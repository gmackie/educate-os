import { check } from './safety.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
export function googleId(value) {
  check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value), 'Invalid opaque Google ID'); return value;
}
export function messageId(value) {
  check(typeof value === 'string' && /^<[a-f0-9-]{36}@[a-z0-9.-]+>$/.test(value), 'Invalid bridge Message-ID'); return value;
}
/** Narrow fixed-host API. Tokens remain in this closure and are never returned or persisted. */
export class GoogleApi {
  #transport; #token; #timeout;
  constructor({ transport = fetch, accessToken = () => process.env.LAUNCH_OPS_GOOGLE_ACCESS_TOKEN, timeoutMs = 10_000 } = {}) {
    check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'Invalid Google timeout');
    this.#transport = transport; this.#token = accessToken; this.#timeout = timeoutMs;
  }
  async #request(url, method = 'GET', body) {
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Google request failed; no automatic retry')); }, this.#timeout); });
    try {
      return await Promise.race([deadline, (async () => {
        const token = await this.#token();
        check(typeof token === 'string' && token.length >= 8 && token.length <= 8192 && !/\s/.test(token), 'Short-lived Google access token required');
        const response = await this.#transport(url, { method, redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        check(!response.redirected && response.status === 200 && /application\/json/i.test(response.headers.get('content-type') || ''), 'Google request rejected');
        check(Number(response.headers.get('content-length') || 0) <= 1_000_000, 'Google response too large');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; check(size <= 1_000_000, 'Google response too large'); chunks.push(value); } }
        finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      })()]);
    } catch { throw new Error('Google request failed; no automatic retry'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  profile() { return this.#request(`${GMAIL}/profile`); }
  createDraft(raw) {
    check(typeof raw === 'string' && /^[a-zA-Z0-9_-]+$/.test(raw) && raw.length <= 100_000, 'Invalid RFC2822 base64url draft');
    return this.#request(`${GMAIL}/drafts`, 'POST', { message: { raw } });
  }
  getDraft(id) { return this.#request(`${GMAIL}/drafts/${googleId(id)}?format=full`); }
  findDrafts(rfcId) { return this.#request(`${GMAIL}/drafts?${new URLSearchParams({ q: `rfc822msgid:${messageId(rfcId)}`, maxResults: '20' })}`); }
  findSent(rfcId) { return this.#request(`${GMAIL}/messages?${new URLSearchParams({ q: `rfc822msgid:${messageId(rfcId)}`, labelIds: 'SENT', maxResults: '20' })}`); }
  getThread(id) { return this.#request(`${GMAIL}/threads/${googleId(id)}?format=full`); }
  freeBusy(slot) {
    return this.#request(`${CALENDAR}/freeBusy`, 'POST', { timeMin: slot.start, timeMax: slot.end, timeZone: slot.timeZone, items: [{ id: 'primary' }] });
  }
  createHold(event) {
    check(event && /^[a-v0-9]{5,1024}$/.test(event.id) && event.visibility === 'private' && !Object.hasOwn(event, 'attendees') && !Object.hasOwn(event, 'conferenceData'), 'Only private internal holds without attendee fields');
    check(Object.keys(event).every(k => ['id', 'summary', 'description', 'start', 'end', 'visibility', 'transparency'].includes(k)), 'Unexpected event fields');
    return this.#request(`${CALENDAR}/calendars/primary/events?sendUpdates=none`, 'POST', event);
  }
  getHold(id) { check(typeof id === 'string' && /^[a-v0-9]{5,1024}$/.test(id), 'Invalid event ID'); return this.#request(`${CALENDAR}/calendars/primary/events/${id}`); }
}
