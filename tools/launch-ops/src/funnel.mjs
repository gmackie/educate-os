import { googleMutations } from './google-bridge.mjs';
import { check } from './safety.mjs';
import { SOURCE_CATALOG, importRegistry, approveDomain } from './registry.mjs';
import { candidateHash, ingestCandidates, verifyCandidate, PERSONAS } from './discovery.mjs';
import { CAMPAIGNS, configureOperator, createCampaign, reviseCampaign, selectCandidate, draftOutreach, reviseOutreach, approveBatch, outreachHash, suppressCandidate } from './campaigns.mjs';
import { importInterest, reviewInterest, submitStaffFeedback, importResponses, reviewResponse, triageInterest, interestHash, responseHash, PRIVACY_NOTICE, INTEREST_TYPES } from './inbound.mjs';
import { dailyWorkflow, metrics, erasePersonalData, recordDelivery } from './operations.mjs';

export const funnelMutations = Object.freeze({
  ...googleMutations,
  'registry.import': importRegistry, 'domains.approve': approveDomain, 'candidates.import': ingestCandidates, 'candidates.verify': verifyCandidate,
  'candidates.select': selectCandidate, 'sender.configure': configureOperator, 'campaigns.create': createCampaign, 'campaigns.revise': reviseCampaign,
  'outreach.draft': draftOutreach, 'outreach.revise': reviseOutreach, 'outreach.approve': approveBatch, 'candidates.suppress': suppressCandidate,
  'interest.import': importInterest, 'interest.review': reviewInterest, 'staff.submit': submitStaffFeedback,
  'responses.import': importResponses, 'responses.review': reviewResponse, 'interest.triage': triageInterest,
  'privacy.erase': erasePersonalData, 'delivery.record': recordDelivery, 'daily.run': runDaily,
});
export function runDaily(s, input) {
  check(input.approvedLocalSources === true, 'Confirm daily inputs are locally imported operator-approved sources');
  check(!input.registry || (Array.isArray(input.registry) && input.registry.length <= 10), 'At most ten registry batches per run');
  check(!input.discoveries || (Array.isArray(input.discoveries) && input.discoveries.length <= 10), 'At most ten discovery batches per run');
  const imports = (input.registry || []).map(batch => importRegistry(s, { ...batch, operator: input.operator }));
  const discoveries = (input.discoveries || []).map(batch => ingestCandidates(s, { ...batch, operator: input.operator }));
  // Selection is always a separate human decision; daily can prepare only those already selected.
  if (input.prepareSelected === true) for (const c of s.candidates.filter(c => c.stage === 'selected')) draftOutreach(s, { candidateId: c.id, campaignId: input.campaignId, operator: input.operator });
  return { imports, discoveries, run: dailyWorkflow(s, input), metrics: metrics(s) };
}
export function funnelSnapshot(s) {
  const { privacyKeys: _keys, suppressions, ...visible } = s;
  return { ...visible, suppressions: suppressions.map(({ fingerprint: _fingerprint, ...x }) => x),
    candidates: s.candidates.map(c => ({ ...c, hash: candidateHash(c) })),
    outreach: s.outreach.map(o => ({ ...o, hash: outreachHash(s, o), approved: !o.exportedAt && o.approval?.hash === outreachHash(s, o) })),
    staffFeedback: s.staffFeedback.map(f => ({ ...f, hash: interestHash(f) })), responses: s.responses.map(r => ({ ...r, hash: responseHash(r) })),
    sourceCatalog: SOURCE_CATALOG, campaignKinds: CAMPAIGNS, personas: PERSONAS, interestTypes: INTEREST_TYPES, privacyNotice: PRIVACY_NOTICE, metrics: metrics(s),
  };
}
