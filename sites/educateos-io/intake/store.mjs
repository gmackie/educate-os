import {CONSENT_VERSION, HOLD_MS, RETENTION_MS, reply} from './core.mjs';
const DAY = 86400000;
const ttlKey = (time, key) => `ttl:${String(time).padStart(16, '0')}:${key}`;
const privateAction = record => ['unsubscribe', 'deletion'].includes(record.interestType);

/** Transactional isolated project storage; no district authority or plaintext abuse tokens. */
export class IntakeStore {
  constructor(storage) { this.storage = storage; }
  async dispatch(action, data) {
    const {now} = data;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
    return this.storage.transaction(async tx => {
      const put = async (key, value, expiresAt) => {
        const previous = await tx.get('expires:' + key);
        if (previous !== undefined && previous !== expiresAt) await tx.delete(ttlKey(previous, key));
        await tx.put(key, value);
        await tx.put('expires:' + key, expiresAt);
        await tx.put(ttlKey(expiresAt, key), {key, expiresAt});
      };
      const count = async (key, limit, expiresAt) => {
        const n = (await tx.get(key) ?? 0) + 1;
        await put(key, n, expiresAt);
        return n <= limit;
      };
      if (action === 'attempt') {
        const bucket = Math.floor(now / 600000);
        // Global cost ceiling includes malformed and bot attempts, before external verification.
        const global = await count(`attempt:${data.optout ? 'optout' : 'interest'}:${bucket}`, data.optout ? 2000 : 1000, (bucket + 2) * 600000);
        if (!global) return false;
        const ip = await count(`ip:${data.optout ? 'optout' : 'interest'}:${bucket}:${data.ipHash}`, data.optout ? 100 : 10, (bucket + 2) * 600000);
        return global && ip;
      }
      if (action === 'hold') {
        // A bounded aggregate spam hold. Deliberately retain no bot-supplied PII.
        await count(`held:${Math.floor(now / DAY)}`, Number.MAX_SAFE_INTEGER, now + HOLD_MS);
        return true;
      }
      if (action === 'submit') {
        const {record, address, idem, fingerprint, tokenHash} = data;
        const existing = await tx.get('idem:' + idem);
        if (existing && existing.expiresAt > now) return {status: existing.fingerprint === fingerprint ? 200 : 409};
        if (await tx.get('token:' + tokenHash)) return {status: 400};
        await put('token:' + tokenHash, true, now + 330000);
        const day = Math.floor(now / DAY);
        if (!await count(`received:${day}`, 500, (day + 2) * DAY)) return {status: 429};
        if (!await count(`email:${day}:${address}:${privateAction(record) ? 'privacy' : 'interest'}`, privateAction(record) ? 10 : 3, (day + 2) * DAY)) return {status: 429};
        if (await tx.get('suppressed:' + address) && !privateAction(record)) return {status: 200};
        const externalId = crypto.randomUUID();
        const expiresAt = now + RETENTION_MS;
        const row = {record: {externalId, receivedAt: new Date(now).toISOString(), ...record}, address, idem, expiresAt};
        await put('record:' + externalId, row, expiresAt);
        await put(`address:${address}:${externalId}`, {externalId, idem}, expiresAt);
        await put('idem:' + idem, {fingerprint, expiresAt}, expiresAt);
        // Immediately conservative: requests suppress future ordinary intake/export, even before
        // identity verification. Erasure remains a separately authenticated, verified operation.
        if (privateAction(record)) await tx.put('suppressed:' + address, true);
        return {status: 200};
      }
      if (action === 'export') {
        const rows = await tx.list({prefix: 'record:', ...(data.cursor ? {startAfter: 'record:' + data.cursor} : {}), limit: 100});
        const records = [];
        for (const row of rows.values()) {
          if (row.expiresAt > now && (privateAction(row.record) || !await tx.get('suppressed:' + row.address))) records.push(row.record);
        }
        const last = [...rows.keys()].at(-1);
        return {records, nextCursor: rows.size === 100 ? last.slice('record:'.length) : ''};
      }
      if (action === 'unsubscribe') {
        // No identifying fields beyond the address; no challenge, sign-in or confirmation mail.
        if (!await tx.get('suppressed:' + data.address)) {
          const externalId = crypto.randomUUID();
          const expiresAt = now + RETENTION_MS;
          const idem = 'unsubscribe-' + data.address;
          const record = {externalId, receivedAt: new Date(now).toISOString(), name: '', workEmail: data.workEmail,
            org: '', state: 'other', role: '', interestType: 'unsubscribe', marketingOptIn: false,
            verificationStatus: 'unverified', consentVersion: CONSENT_VERSION, limitedFeedback: '',
            referralSource: 'unsubscribe', responseConsent: false, staffConfirmed: false, privacyAcknowledged: false};
          await put('record:' + externalId, {record, address: data.address, idem, expiresAt}, expiresAt);
          await put(`address:${data.address}:${externalId}`, {externalId, idem}, expiresAt);
        }
        await tx.put('suppressed:' + data.address, true);
        return true;
      }
      if (action === 'privacy') {
        await tx.put('suppressed:' + data.address, true);
        if (data.erase) {
          // Address index avoids loading other people's records. Transactional erasure includes
          // idempotency fingerprints; only the keyed suppression tombstone survives.
          const rows = await tx.list({prefix: `address:${data.address}:`});
          for (const [key, value] of rows) await tx.delete([key, 'record:' + value.externalId, 'idem:' + value.idem]);
        }
        return true;
      }
      throw new Error('unknown action');
    });
  }
  async purge(now) {
    // Bound each alarm; the DO wrapper schedules another batch if needed.
    return this.storage.transaction(async tx => {
      const due = await tx.list({prefix: 'ttl:', end: 'ttl:' + String(now + 1).padStart(16, '0'), limit: 1000});
      for (const [expiry, {key, expiresAt}] of due) {
        if (await tx.get('expires:' + key) === expiresAt) await tx.delete([key, 'expires:' + key]);
        await tx.delete(expiry);
      }
      return due.size === 1000;
    });
  }
  async fetch(request) {
    const data = await request.json();
    return reply(200, await this.dispatch(new URL(request.url).pathname.slice(1), data));
  }
}
