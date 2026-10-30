import { readFileSync } from 'node:fs';
import { importRegistry } from './registry.mjs';
import { importInterest, reviewInterest, interestHash, reviewResponse, responseHash, triageInterest } from './inbound.mjs';
import { configureOperator, selectCandidate, createCampaign, draftOutreach, outreachHash, approveBatch, exportOutreach } from './campaigns.mjs';
import { previewGmail, approveGmail, createGmailDraft, reconcileSent, readReplies, acceptMeetingRequest, proposeHold, approveHold, createCalendarHold, reviewMeeting } from './google-bridge.mjs';
import { metrics } from './operations.mjs';
import { GoogleApi } from './google-api.mjs';
import { mockGoogle } from './google-fixtures.mjs';
import { check } from './safety.mjs';

export const syntheticReview = hash => ({ humanReviewed: true, reviewer: 'Synthetic fixture reviewer', reviewedHash: hash });
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
export function businessSlot() {
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 2); start.setUTCHours(15, 0, 0, 0);
  while ([0, 6].includes(start.getUTCDay())) start.setUTCDate(start.getUTCDate() + 1);
  return { start: start.toISOString(), end: new Date(start.getTime() + 20 * 60_000).toISOString(), timeZone: 'America/Detroit' };
}
/** Uses real ops transitions and serialized mock HTTP, without fetch or real identities. Empty store only. */
export async function simulateGoogle(store) {
  check(store.read().contacts.length === 0 && store.read().sourceImports.length === 0, 'Simulation requires isolated empty store');
  const operator = 'Synthetic operator'; const model = mockGoogle(); const api = new GoogleApi({ transport: model.transport, accessToken: () => 'synthetic-access-only' });
  store.transaction(s => {
    const registry = fixture('registry.json'); registry.observedAt = new Date().toISOString().slice(0, 10); importRegistry(s, registry);
    const envelope = fixture('website-interest.json'); envelope.records[0].receivedAt = new Date().toISOString(); envelope.records[0].interestType = 'council';
    envelope.records[0].limitedFeedback = 'Please show a synthetic preview and discuss the educator advisory group.';
    importInterest(s, { envelope, operator }); check(s.candidates.length === 0 && s.staffFeedback[0].status === 'quarantined', 'Intake must quarantine');
    const f = s.staffFeedback[0]; reviewInterest(s, { id: f.id, ...syntheticReview(interestHash(f)), organizationId: s.organizations[0].id, identityAndOrganizationConfirmed: true, staffOnlyConfirmed: true });
    configureOperator(s, fixture('operator.json')); model.mailbox = s.operatorConfigs[0].senderEmail;
    selectCandidate(s, { id: s.candidates[0].id, operator }); const campaign = createCampaign(s, { kind: 'council', context: 'A small educator and technical advisory group to review synthetic workflows.', operator });
    draftOutreach(s, { candidateId: s.candidates[0].id, campaignId: campaign.id, operator });
    const o = s.outreach[0]; approveBatch(s, { items: [{ id: o.id, reviewedHash: outreachHash(s, o) }], ...syntheticReview('unused'), truthfulClaimsConfirmed: true, sourceAndRecipientConfirmed: true, complianceConfirmed: true });
    exportOutreach(s, { ids: [o.id], format: 'eml' }); const preview = previewGmail(s, { handoffId: s.handoffs[0].id });
    approveGmail(s, { handoffId: preview.handoffId, ...syntheticReview(preview.hash), messageIdDomainControlled: true });
  });
  let s = store.read(); const d = s.googleDrafts[0];
  await createGmailDraft(store, { id: d.id, handoffId: d.handoffId, reviewedHash: d.hash, allowNetwork: true, createGmailDraft: true }, api);
  check(metrics(store.read()).confirmedSentInvitations === 0, 'Draft must not count as sent');
  model.externalHumanSent(); await reconcileSent(store, { id: d.id, allowNetwork: true, readGoogle: true }, api);
  model.addReply(); await readReplies(store, { id: d.id, allowNetwork: true, readGoogle: true }, api);
  store.transaction(s => {
    const r = s.responses[0]; check(r.state === 'ambiguous' && !r.review && !r.text.includes('signature'), 'Reply must need review and discard signature');
    reviewResponse(s, { id: r.id, ...syntheticReview(responseHash(r)), state: 'interested', requestedScope: 'council', note: 'Explicit educator council acceptance and meeting request verified by the synthetic human.' });
    const triage = { candidateId: r.candidateId, kind: 'council' }; const p = triageInterest(s, { ...triage, preview: true });
    triageInterest(s, { ...triage, ...syntheticReview(p.hash), acceptedByContact: true, council: 'educator', seat: 1, note: 'Actual council seat acceptance verified.' });
    const input = { candidateId: r.candidateId, responseId: r.id, meetingRequestedConfirmed: true, respondentVerifiedConfirmed: true, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), note: 'Respondent expressly requested the meeting.' };
    const preview = acceptMeetingRequest(s, { ...input, preview: true }); const request = acceptMeetingRequest(s, { ...input, ...syntheticReview(preview.hash) });
    const hold = proposeHold(s, { requestId: request.id, slot: businessSlot(), council: 'educator', agenda: ['Review synthetic curriculum workflow', 'Discuss advisory feedback'], operator });
    approveHold(s, { id: hold.id, ...syntheticReview(hold.hash), internalNoAttendeesConfirmed: true });
  });
  s = store.read(); const h = s.calendarHolds[0]; await createCalendarHold(store, { id: h.id, reviewedHash: h.approval.hash, allowNetwork: true, createCalendarHold: true }, api);
  // Advance only the isolated synthetic scenario clock for the post-meeting review.
  const actualNow = Date.now; Date.now = () => Date.parse(h.slot.end) + 60_000;
  try { store.transaction(s => {
    const input = { holdId: h.id, meetingOccurredConfirmed: true, notesSanitizedConfirmed: true, notes: 'Synthetic reviewer requested clearer accessibility guidance.',
      actions: [{ title: 'Prepare accessible synthetic preview', owner: 'Synthetic action owner', dueAt: new Date(Date.now() + 14 * 86400_000).toISOString() }], decision: 'accepted', rationale: 'Verified synthetic council feedback accepted.', followUp: 'Track accessible preview preparation.' };
    const preview = reviewMeeting(s, { ...input, preview: true }); reviewMeeting(s, { ...input, ...syntheticReview(preview.hash) });
  }); } finally { Date.now = actualNow; }
  s = store.read(); return { syntheticOnly: true, realNetworkCalls: 0, metrics: metrics(s), auditEvents: s.audit.map(a => a.event), requests: model.calls.map(c => ({ method: c.method, url: c.url })), state: s };
}
