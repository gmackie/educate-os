import { check, email, hash, human, id, now, oneOf, parseCsv, sourceUrl } from './safety.mjs';
import { audit } from './store.mjs';
import { exact, get, norm, safe, single, staffText, timestamp } from './funnel-common.mjs';
import { isSuppressed, suppress } from './suppression.mjs';
import { candidateHash, segment } from './discovery.mjs';
import { addFeedback, createPilot, seatMember } from './domain.mjs';

export const INTEREST_TYPES = ['demo', 'council', 'technical-review', 'pilot', 'feedback', 'webinar', 'unsubscribe', 'deletion'];
export const INTEREST_FIELDS = ['externalId', 'receivedAt', 'name', 'workEmail', 'org', 'state', 'role', 'interestType', 'marketingOptIn', 'verificationStatus', 'consentVersion', 'limitedFeedback', 'referralSource', 'responseConsent', 'staffConfirmed', 'privacyAcknowledged'];
const RECEIPT = /^[a-zA-Z0-9_-]{1,120}$/;
export function interestRecord(r) {
  exact(r, INTEREST_FIELDS, 'website-interest');
  check(INTEREST_FIELDS.every(k => Object.hasOwn(r, k)), 'Missing website-interest fields');
  check(RECEIPT.test(r.externalId), 'Invalid externalId');
  for (const field of ['marketingOptIn', 'responseConsent', 'staffConfirmed', 'privacyAcknowledged']) check(typeof r[field] === 'boolean', `Explicit boolean ${field} required`);
  const privacyAction = ['unsubscribe', 'deletion'].includes(r.interestType);
  const optionalIdentity = (v, label, max) => privacyAction && v === '' ? '' : single(v, label, max);
  const out = { externalId: r.externalId, receivedAt: timestamp(r.receivedAt), name: optionalIdentity(r.name, 'staff name', 120), workEmail: email(r.workEmail), org: optionalIdentity(r.org, 'organization', 160), state: oneOf(r.state, ['MI', 'TX', 'other'], 'state'), role: optionalIdentity(r.role, 'staff role', 160),
    interestType: oneOf(r.interestType, INTEREST_TYPES, 'interest type'), marketingOptIn: r.marketingOptIn, verificationStatus: oneOf(r.verificationStatus, ['unverified', 'verified', 'rejected'], 'external verification status'), consentVersion: single(r.consentVersion, 'consent version', 80), limitedFeedback: staffText(r.limitedFeedback ?? ''), referralSource: single(r.referralSource, 'first-party referral label', 160), responseConsent: r.responseConsent, staffConfirmed: r.staffConfirmed, privacyAcknowledged: r.privacyAcknowledged };
  check(!/https?:|www\.|[/\\?#]/i.test(out.referralSource), 'Referral must be a landing label, never a tracking URL');
  return out;
}
export const interestHash = f => hash({ source: f.source, record: f.record });
export function importInterest(s, input) {
  const operator = safe(input.operator, 'operator', 120); const envelope = input.envelope;
  exact(envelope, ['schemaVersion', 'source', 'records'], 'interest envelope');
  check(envelope.schemaVersion === 1 && envelope.source === 'website-interest' && Array.isArray(envelope.records) && envelope.records.length > 0 && envelope.records.length <= 100, 'website-interest v1 envelope requires 1–100 records');
  const records = envelope.records.map(interestRecord); // Fully validate before any mutation.
  const planned = new Map();
  for (const r of records) {
    const fp = hash({ source: envelope.source, externalId: r.externalId }); const contentHash = hash(r);
    const existing = s.importReceipts.find(x => x.externalHash === fp) || planned.get(fp);
    check(!existing || existing.contentHash === contentHash || ['unsubscribe', 'deletion'].includes(r.interestType), 'Changed externalId collision: export a new event ID for updates');
    planned.set(fp, { contentHash });
  }
  let added = 0; let suppressed = 0;
  for (const r of records) {
    const externalHash = hash({ source: envelope.source, externalId: r.externalId });
    const old = s.importReceipts.find(x => x.externalHash === externalHash);
    if (['unsubscribe', 'deletion'].includes(r.interestType)) {
      suppress(s, { address: r.workEmail, reason: r.interestType === 'deletion' ? 'deletion-request' : 'optout', operator }); suppressed++;
    }
    if (old) continue;
    s.importReceipts.push({ externalHash, contentHash: hash(r), at: now() });
    if (isSuppressed(s, r.workEmail, r.org)) continue;
    const feedback = { id: id(), source: 'website-interest', record: r, receivedAt: r.receivedAt, importedAt: now(), review: null, candidateId: null, status: 'quarantined' };
    s.staffFeedback.push(feedback); added++; audit(s, 'funnel.interest-quarantined', feedback.id, operator);
  }
  return { added, suppressed };
}
export function reviewInterest(s, input) {
  const f = get(s, 'staffFeedback', input.id); const reviewer = human(input, interestHash(f));
  check(!f.review, 'Interest already reviewed; consent updates require a new external event');
  check(input.identityAndOrganizationConfirmed === true && input.staffOnlyConfirmed === true, 'Verify work email ownership, organization and staff identity outside this tool');
  check(f.record.staffConfirmed && f.record.privacyAcknowledged && f.record.responseConsent, 'No explicit staff acknowledgement and one-time response permission');
  check(f.record.verificationStatus !== 'rejected', 'Rejected intake cannot be promoted');
  const org = get(s, 'organizations', input.organizationId);
  check(norm(org.name) === norm(f.record.org) && (f.record.state === 'other' || org.state === f.record.state), 'Match organization to approved registry first');
  check(!isSuppressed(s, f.record.workEmail, org.name), 'Contact or organization suppressed; consent cannot override sticky suppression');
  check(!s.candidates.some(c => c.email === f.record.workEmail), 'Existing person: preserve existing consent and review the new event separately');
  const contact = s.contacts.find(c => c.email === f.record.workEmail);
  check(!contact, 'Existing foundation contact: manual identity/consent reconciliation required');
  const c = { id: id(), organizationId: org.id, name: f.record.name, email: f.record.workEmail, role: f.record.role, sourceUrl: 'https://educateos.io/interest', observedAt: f.record.receivedAt,
    snippet: `Staff-submitted ${f.record.interestType} request; source event ${f.record.externalId}`, evidenceHash: interestHash(f), sourceKind: 'staff-optin', consent: { interestType: f.record.interestType, responseConsent: f.record.responseConsent, marketingOptIn: f.record.marketingOptIn, version: f.record.consentVersion, at: f.record.receivedAt },
    persona: segment(f.record.role, org.kind), stage: 'verified', contactId: id(), verification: null, discoveredAt: now() };
  c.verification = { hash: candidateHash(c), reviewer, at: now() };
  s.contacts.push({ id: c.contactId, name: c.name, email: c.email, organization: org.name, role: c.role, sourceUrl: c.sourceUrl, tags: ['community'], reviewedBy: reviewer, reviewedAt: now(), suppressed: false });
  s.candidates.push(c); f.candidateId = c.id; f.status = 'verified'; f.review = { hash: interestHash(f), reviewer, at: now() };
  audit(s, 'funnel.interest-verified', f.id, reviewer); return { feedback: f, candidate: c };
}
const REPLY_HEADERS = ['externalId', 'candidateId', 'receivedAt', 'text', 'state', 'sourceUrl'];
export const REPLY_STATES = ['interested', 'needs-info', 'declined', 'unsubscribed', 'ambiguous'];
export const responseHash = r => hash({ externalId: r.externalId, candidateId: r.candidateId, receivedAt: r.receivedAt, text: r.text, suggestedState: r.suggestedState, sourceUrl: r.sourceUrl });
export function importResponses(s, input) {
  const actor = safe(input.operator, 'operator', 120);
  const raw = input.csv !== undefined ? parseCsv(input.csv, REPLY_HEADERS) : input.records;
  check(Array.isArray(raw) && raw.length > 0 && raw.length <= 100, 'Import 1–100 replies');
  const rows = raw.map(r => {
    exact(r, REPLY_HEADERS, 'response'); check(RECEIPT.test(r.externalId), 'Invalid external reply ID');
    get(s, 'candidates', r.candidateId);
    const reply = { externalId: r.externalId, candidateId: r.candidateId, receivedAt: timestamp(r.receivedAt), text: staffText(r.text), suggestedState: oneOf(r.state, REPLY_STATES, 'reply state'), sourceUrl: sourceUrl(r.sourceUrl) };
    check(reply.receivedAt >= get(s, 'candidates', reply.candidateId).discoveredAt, 'Reply predates discovery'); return reply;
  });
  for (const r of rows) { const prior = s.responses.find(x => x.externalId === r.externalId); check(!prior || responseHash(prior) === responseHash(r), 'Changed reply ID collision'); }
  let added = 0;
  for (const r of rows) {
    if (s.responses.some(x => x.externalId === r.externalId)) continue;
    const explicitOptOut = /^(?:unsubscribe|please unsubscribe me[.!]?|remove me from (?:your|the) mailing list[.!]?)$/i.test(r.text.trim());
    const response = { id: id(), ...r, state: explicitOptOut ? 'unsubscribed' : 'ambiguous', review: null, importedAt: now() };
    s.responses.push(response); const c = get(s, 'candidates', r.candidateId); c.stage = explicitOptOut ? 'declined' : 'response';
    for (const o of s.outreach.filter(o => o.candidateId === c.id)) o.approval = null;
    if (explicitOptOut) suppress(s, { address: c.email, reason: 'optout', operator: actor });
    audit(s, 'funnel.response-imported', response.id, actor); added++;
  }
  return { added };
}
export function reviewResponse(s, input) {
  const r = get(s, 'responses', input.id); const reviewer = human(input, responseHash(r));
  const state = oneOf(input.state, REPLY_STATES, 'reviewed reply state'); check(r.state !== 'unsubscribed' || state === 'unsubscribed', 'Explicit opt-out cannot be undone by classification');
  const scope = oneOf(input.requestedScope, ['none', 'interview', 'demo', 'council', 'pilot', 'technical-review', 'feedback', 'webinar'], 'expressly requested scope');
  const note = staffText(input.note, 1000); check(note.length > 0, 'Record classification evidence');
  check(!['ambiguous', 'declined', 'unsubscribed'].includes(state) || scope === 'none', 'No consent inferred from ambiguous or negative replies');
  r.state = state; r.review = { hash: responseHash(r), reviewer, at: now(), requestedScope: scope, note };
  const c = get(s, 'candidates', r.candidateId); c.stage = ['declined', 'unsubscribed'].includes(state) ? 'declined' : 'response';
  if (['declined', 'unsubscribed'].includes(state)) suppress(s, { address: c.email, reason: state === 'declined' ? 'declined' : 'optout', operator: reviewer });
  audit(s, 'funnel.response-reviewed', r.id, reviewer); return r;
}
export const PRIVACY_NOTICE = 'Local synthetic staff test only. Minimum professional contact and requested feedback are stored privately for operator review. Never include student information, personal contacts, credentials or URLs. One-time response permission is separate from optional marketing. No sending or pilot authorization occurs. Ask the operator for opt-out or deletion; suppression survives erasure.';
export function submitStaffFeedback(s, input) {
  exact(input, ['record', 'operator', 'syntheticLocalTest', 'noticeVersion'], 'local staff form');
  check(input.syntheticLocalTest === true && input.noticeVersion === 'staff-local-v1', 'Local form is for synthetic staff testing with privacy notice v1 only');
  check(input.record.workEmail.endsWith('.invalid'), 'Local test form accepts fictional .invalid staff addresses only');
  return importInterest(s, { operator: input.operator, envelope: { schemaVersion: 1, source: 'website-interest', records: [input.record] } });
}
export function triageInterest(s, input) {
  const c = get(s, 'candidates', input.candidateId); const kind = oneOf(input.kind, ['interview', 'council', 'pilot', 'demo', 'feedback', 'technical-review'], 'triage type');
  check(c.verification?.hash === candidateHash(c) && !isSuppressed(s, c.email, get(s, 'organizations', c.organizationId).name), 'Verified unsuppressed staff required');
  const staff = s.staffFeedback.find(f => f.candidateId === c.id && f.review?.hash === interestHash(f) && f.record.responseConsent && f.record.interestType === kind);
  const response = s.responses.find(r => r.candidateId === c.id && ['interested', 'needs-info'].includes(r.state) && r.review?.hash === responseHash(r) && r.review.requestedScope === kind);
  check(staff || response, 'Explicit reviewed request for this scope required; no role-fit or positive-text consent inference');
  const basis = { candidateId: c.id, kind, evidenceId: staff?.id || response.id, evidenceHash: staff ? interestHash(staff) : responseHash(response) };
  if (input.preview === true) return { ...basis, hash: hash(basis) };
  const reviewer = human(input, hash(basis)); const note = staffText(input.note, 1000); check(note.length, 'Record triage rationale');
  check(!s.triage.some(x => x.candidateId === c.id && x.kind === kind), 'Already triaged for this scope');
  const record = { id: id(), ...basis, note, at: now(), reviewer, targetId: null };
  if (kind === 'pilot') record.targetId = createPilot(s, { district: get(s, 'organizations', c.organizationId).name, scope: safe(input.scope, 'synthetic evaluation scope', 1000), owner: safe(input.owner, 'pilot planning owner', 120), syntheticOnly: true }).id;
  if (kind === 'council') {
    check(input.acceptedByContact === true, 'Council interest is not membership: record actual acceptance before assigning a seat');
    record.targetId = seatMember(s, { contactId: c.contactId, council: input.council, seat: input.seat, acceptedByContact: true, acceptanceNote: note, operator: reviewer }).id;
  }
  if (input.meetingId) record.feedbackId = addFeedback(s, { meetingId: input.meetingId, summary: note, owner: reviewer }).id;
  s.triage.push(record); c.stage = ['council', 'pilot', 'interview'].includes(kind) ? kind : 'response';
  audit(s, 'funnel.interest-triaged', record.id, reviewer); return record;
}
