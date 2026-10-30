import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, emptyState } from '../src/store.mjs';
import { importRegistry, approveDomain } from '../src/registry.mjs';
import { candidateHash, ingestCandidates, verifyCandidate, officialSiteRecords } from '../src/discovery.mjs';
import { configureOperator, createCampaign, selectCandidate, draftOutreach, outreachHash, approveBatch } from '../src/campaigns.mjs';

export const fixtureFile = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
export const reviewer = h => ({ humanReviewed: true, reviewer: 'Fictional human operator', reviewedHash: h });
export const operator = 'Fictional operator';
export function tempStore(t) { const root = mkdtempSync(join(realpathSync(tmpdir()), 'funnel-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return new Store(root); }
export function baseState() {
  const s = emptyState(); const input = JSON.parse(fixtureFile('registry.json')); input.observedAt = new Date().toISOString().slice(0, 10);
  importRegistry(s, input); return s;
}
export function domain(s, org = s.organizations[0]) {
  const input = { organizationId: org.id, origin: new URL(org.website).origin };
  const preview = approveDomain(s, { ...input, preview: true });
  return approveDomain(s, { ...input, ...reviewer(preview.hash), officialDomainConfirmed: true, noMemberLists: true });
}
export function discovered(s = baseState()) {
  domain(s); const org = s.organizations[0];
  ingestCandidates(s, { organizationId: org.id, operator, noStudentData: true, records: officialSiteRecords(fixtureFile('official-staff.html'), `${org.website}/staff`, org) });
  return s;
}
export function verified(s = discovered()) {
  const c = s.candidates[0]; verifyCandidate(s, { id: c.id, ...reviewer(candidateHash(c)), publicProfessionalConfirmed: true, accurateEvidenceConfirmed: true, noStudentData: true }); return s;
}
export function draft(s = verified()) {
  configureOperator(s, JSON.parse(fixtureFile('operator.json')));
  selectCandidate(s, { id: s.candidates[0].id, operator });
  const campaign = createCampaign(s, { kind: 'interview', context: 'We are exploring a foundation model for an open source and district-owned design.', operator });
  draftOutreach(s, { candidateId: s.candidates[0].id, campaignId: campaign.id, operator }); return s;
}
export function approve(s) {
  const o = s.outreach[0]; return approveBatch(s, { items: [{ id: o.id, reviewedHash: outreachHash(s, o) }], humanReviewed: true, reviewer: operator, truthfulClaimsConfirmed: true, sourceAndRecipientConfirmed: true, complianceConfirmed: true });
}
export function staffRecord(overrides = {}) { return { ...JSON.parse(fixtureFile('website-interest.json')).records[0], receivedAt: new Date().toISOString(), ...overrides }; }
