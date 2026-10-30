import { check, hash, human, id, now, oneOf } from './safety.mjs';
import { audit } from './store.mjs';
import { get, safe, timestamp } from './funnel-common.mjs';
import { candidateHash } from './discovery.mjs';
import { outreachHash } from './campaigns.mjs';
import { interestHash, responseHash } from './inbound.mjs';
import { isSuppressed, suppress } from './suppression.mjs';
import { pilotReadiness } from './domain.mjs';

export function recordDelivery(s, input) {
  const h = get(s, 'handoffs', input.handoffId);
  const basis = { handoffId: h.id, approvalHash: h.approvalHash, at: timestamp(input.at), status: oneOf(input.status, ['sent', 'delivered', 'bounce'], 'external delivery state'), reference: safe(input.reference, 'independent delivery evidence reference', 500) };
  check(basis.at >= h.at, 'Delivery evidence predates draft export');
  if (input.preview === true) return { ...basis, hash: hash(basis) };
  const reviewer = human(input, hash(basis)); check(input.independentEvidenceConfirmed === true, 'Confirm actual external delivery evidence; export is not a send');
  check(!s.deliveries.some(x => x.handoffId === h.id), 'Delivery evidence already recorded; keep one denominator per invitation');
  const d = { id: id(), ...basis, reviewer, recordedAt: now() }; s.deliveries.push(d);
  if (d.status === 'bounce') { const c = get(s, 'candidates', h.candidateId); suppress(s, { address: c.email, reason: 'bounce', operator: reviewer }); }
  audit(s, 'funnel.external-delivery-recorded', d.id, reviewer); return d;
}
export function dailyWorkflow(s, input) {
  const day = now().slice(0, 10); const key = hash({ day, sourceImports: s.sourceImports.map(x => x.contentHash).toSorted(), evidence: s.candidates.map(c => [c.id, candidateHash(c), c.verification, c.stage]), outreach: s.outreach.map(o => [o.id, outreachHash(s, o), o.approval]),
    responses: s.responses.map(r => [r.id, responseHash(r), r.review]), feedback: s.staffFeedback.map(f => [f.id, interestHash(f), f.review]), suppressions: s.suppressions.map(x => x.fingerprint).toSorted() });
  const old = s.runs.find(x => x.key === key); if (old) return { ...old, replay: true };
  const queues = {
    quarantine: s.candidates.filter(c => !c.verification).map(c => c.id),
    staleEvidence: s.candidates.filter(c => Date.now() - Date.parse(c.observedAt) > 90 * 86400_000 || (c.verification && c.verification.hash !== candidateHash(c))).map(c => c.id),
    selectable: s.candidates.filter(c => c.stage === 'verified' && c.verification?.hash === candidateHash(c) && !isSuppressed(s, c.email, get(s, 'organizations', c.organizationId).name)).map(c => c.id),
    draftReview: s.outreach.filter(o => !o.exportedAt && o.approval?.hash !== outreachHash(s, o)).map(o => o.id),
    responseReview: s.responses.filter(r => !r.review).map(r => r.id), interestReview: s.staffFeedback.filter(f => !f.review).map(f => f.id),
    retentionReview: s.candidates.filter(c => Date.now() - Date.parse(c.discoveredAt) > (s.operatorConfigs[0]?.retentionDays || 90) * 86400_000).map(c => c.id),
  };
  const run = { id: id(), key, day, at: now(), queues, policy: 'local-only-review-queues-no-selection-approval-export-or-contact' };
  s.runs.push(run); audit(s, 'funnel.daily-review-queues-built', run.id, safe(input.operator, 'operator', 120)); return run;
}
const distinct = values => new Set(values.filter(Boolean)).size;
export function metrics(s) {
  const c = s.candidates; const exported = s.handoffs;
  const deliveredIds = new Set(s.deliveries.filter(d => d.status === 'delivered').map(d => d.handoffId));
  const sentIds = new Set(s.deliveries.filter(d => ['sent', 'delivered'].includes(d.status)).map(d => d.handoffId));
  const repliedInvitations = new Set();
  for (const r of s.responses) {
    const preceding = exported.filter(h => h.candidateId === r.candidateId && sentIds.has(h.id) && s.deliveries.some(d => d.handoffId === h.id && d.at <= r.receivedAt)).toSorted((a, b) => b.at.localeCompare(a.at));
    if (preceding[0]) repliedInvitations.add(preceding[0].id);
  }
  const denominator = sentIds.size;
  const optedIn = new Set(s.staffFeedback.filter(f => f.review?.hash === interestHash(f) && f.record.responseConsent && !['unsubscribe', 'deletion'].includes(f.record.interestType)).map(f => f.candidateId));
  const positive = s.responses.filter(r => r.state === 'interested' && r.review?.hash === responseHash(r) && r.review.requestedScope !== 'none'); positive.forEach(r => optedIn.add(r.candidateId));
  const source = s.sourceImports.map(b => {
    const organizations = s.organizations.filter(o => o.importIds.includes(b.id)); const ids = new Set(organizations.map(o => o.id));
    return { sourceId: b.sourceId, observedAt: b.observedAt, attribution: b.attribution, organizations: organizations.length, distinctContacts: c.filter(x => ids.has(x.organizationId)).length, exportedDrafts: exported.filter(x => ids.has(x.organizationId)).length };
  });
  const interestTypes = Object.fromEntries(['demo', 'council', 'pilot', 'feedback', 'technical-review', 'webinar'].map(kind => [kind, distinct(s.staffFeedback.filter(f => f.review?.hash === interestHash(f) && f.record.responseConsent && f.record.interestType === kind).map(f => f.candidateId).concat(s.responses.filter(r => r.state === 'interested' && r.review?.hash === responseHash(r) && r.review.requestedScope === kind).map(r => r.candidateId)))]));
  return {
    scope: 'Retained local records only; exports reserve contact capacity but do not prove contact. Role fit, explicit interest and pilot readiness are independent.',
    organizations: s.organizations.length, distinctContacts: distinct(c.map(x => x.email)), quarantinedContacts: c.filter(x => !x.verification).length,
    verifiedContacts: c.filter(x => x.verification?.hash === candidateHash(x)).length, approvedDrafts: s.outreach.filter(o => o.approval?.hash === outreachHash(s, o)).length,
    exportedDrafts: exported.length, exportedOrganizations: distinct(exported.map(x => x.organizationId)), exportedContacts: distinct(exported.map(x => x.candidateId)),
    confirmedSentInvitations: sentIds.size, confirmedDeliveredInvitations: deliveredIds.size, deliveryUnknownExports: exported.filter(h => !s.deliveries.some(d => d.handoffId === h.id)).length,
    responseRate: { numerator: repliedInvitations.size, denominator, value: denominator ? repliedInvitations.size / denominator : null, unit: 'confirmed-sent invitations with subsequent imported reply / independently confirmed sent invitations; reply attributed to latest preceding confirmed invitation', status: denominator ? 'based-on-operator-delivery-evidence' : 'unknown-no-confirmed-sends' },
    expressedInterestContacts: distinct([...optedIn]), expressedInterestOrganizations: distinct(c.filter(x => optedIn.has(x.id)).map(x => x.organizationId)), interestTypes,
    staffIntakeQuarantined: s.staffFeedback.filter(f => !f.review).length, ambiguousReplies: s.responses.filter(r => r.state === 'ambiguous').length,
    roleFit: Object.fromEntries([...new Set(c.map(x => x.persona))].map(p => [p, c.filter(x => x.persona === p).length])),
    pilotPlanning: s.pilots.length, pilotsGateReady: s.pilots.filter(p => pilotReadiness(s, p).ready).length, pilotsAuthorized: s.pilots.filter(p => pilotReadiness(s, p).authorized).length,
    meetingFeedback: Object.fromEntries(['pending', 'accepted', 'deferred', 'declined'].map(d => [d, s.feedback.filter(f => f.disposition === d).length])), source,
    note: 'Registry rows, page views and drafts are not leads, interest, sends, deliveries, council acceptance or pilot authorization. Source attribution can overlap after dedupe; do not sum source cohorts.',
  };
}
export function erasePersonalData(s, input) {
  const address = input.address; check(typeof address === 'string', 'Address required for verified deletion');
  const candidates = s.candidates.filter(c => c.email === address); const ids = new Set(candidates.map(c => c.id));
  const contactIds = new Set(s.contacts.filter(c => c.email === address).map(c => c.id));
  const feedback = s.staffFeedback.filter(f => f.record.workEmail === address);
  const basis = { address, candidates: candidates.map(c => c.id), contacts: [...contactIds], feedback: feedback.map(f => f.id) };
  check(candidates.length + contactIds.size + feedback.length > 0, 'No retained personal records found');
  if (input.preview === true) return { ...basis, hash: hash(basis) };
  const reviewer = human(input, hash(basis)); check(input.deletionAuthorityConfirmed === true, 'Verify deletion request and authority outside this tool');
  suppress(s, { address, reason: 'verified-erasure', operator: reviewer });
  for (const c of candidates) suppress(s, { organization: get(s, 'organizations', c.organizationId).name, reason: 'erasure-outreach-hold', operator: reviewer });
  const handoffs = s.handoffs.filter(h => ids.has(h.candidateId)); const handoffIds = new Set(handoffs.map(h => h.id));
  const cleanup = [...new Set(handoffs.map(h => h.fileName).filter(Boolean))];
  const triage = s.triage.filter(t => ids.has(t.candidateId)); const pilotIds = new Set(triage.filter(t => t.kind === 'pilot').map(t => t.targetId));
  s.pilots = s.pilots.filter(p => !pilotIds.has(p.id)); s.evidence = s.evidence.filter(e => !pilotIds.has(e.pilotId));
  s.contacts = s.contacts.filter(c => !contactIds.has(c.id)); s.invitations = s.invitations.filter(x => !contactIds.has(x.contactId)); s.memberships = s.memberships.filter(x => !contactIds.has(x.contactId));
  s.candidates = s.candidates.filter(c => !ids.has(c.id)); s.staffFeedback = s.staffFeedback.filter(f => f.record.workEmail !== address);
  s.responses = s.responses.filter(r => !ids.has(r.candidateId)); s.outreach = s.outreach.filter(o => !ids.has(o.candidateId)); s.handoffs = s.handoffs.filter(h => !ids.has(h.candidateId)); s.triage = s.triage.filter(t => !ids.has(t.candidateId)); s.deliveries = s.deliveries.filter(d => !handoffIds.has(d.handoffId));
  // Run queues contain IDs, never PII; clear old queues to remove dangling records.
  s.runs = []; audit(s, 'funnel.personal-data-erased-suppression-retained', id(), reviewer);
  return { erased: true, cleanup, note: 'Suppression and import receipts retained. Independently remove copies/backups and manually entered meeting notes under the same retention policy.' };
}
