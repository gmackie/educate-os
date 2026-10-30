import { createHmac, randomBytes } from 'node:crypto';
import { audit } from './store.mjs';
import { id, now } from './safety.mjs';
import { norm, safe } from './funnel-common.mjs';

function key(s) { if (!s.privacyKeys.length) s.privacyKeys.push({ value: randomBytes(32).toString('hex') }); return s.privacyKeys[0].value; }
function fingerprint(s, kind, value) { return createHmac('sha256', key(s)).update(`${kind}:${norm(value)}`).digest('hex'); }
export function isSuppressed(s, address, organization) {
  return s.suppressions.some(x => (address && x.kind === 'email' && x.fingerprint === fingerprint(s, 'email', address)) || (organization && x.kind === 'organization' && x.fingerprint === fingerprint(s, 'organization', organization))) || s.contacts.some(c => c.email === address && c.suppressed);
}
export function suppress(s, { address, organization, reason, operator }) {
  const actor = safe(operator, 'operator', 120);
  for (const [kind, value] of [['email', address], ['organization', organization]]) {
    if (!value) continue;
    const fp = fingerprint(s, kind, value);
    if (!s.suppressions.some(x => x.kind === kind && x.fingerprint === fp)) s.suppressions.push({ id: id(), kind, fingerprint: fp, reason, at: now() });
  }
  for (const c of s.contacts) if (isSuppressed(s, c.email, c.organization)) {
    c.suppressed = true;
    for (const i of s.invitations.filter(x => x.contactId === c.id)) i.approval = null;
    for (const o of s.outreach.filter(x => x.contactId === c.id)) o.approval = null;
  }
  audit(s, 'funnel.suppressed', reason, actor); return { suppressed: true };
}
