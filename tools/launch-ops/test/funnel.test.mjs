import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createDashboard, dashboardSnapshot } from '../src/server.mjs';
import { Store, emptyState } from '../src/store.mjs';
import { importRegistry } from '../src/registry.mjs';
import { candidateHash, segment } from '../src/discovery.mjs';
import { approveBatch, createCampaign, draftOutreach, exportOutreach, outreachHash, reviseOutreach, selectCandidate, suppressCandidate, reviseCampaign, configureOperator } from '../src/campaigns.mjs';
import { importInterest, interestHash, reviewInterest, importResponses, responseHash, reviewResponse, triageInterest, submitStaffFeedback } from '../src/inbound.mjs';
import { dailyWorkflow, erasePersonalData, metrics, recordDelivery } from '../src/operations.mjs';
import { importContacts, draftInvitation, createMeeting, disposeFeedback } from '../src/domain.mjs';
import { runFunnelCommand } from '../src/funnel-cli.mjs';
import { approve, baseState, discovered, draft, fixtureFile, operator, reviewer, staffRecord, tempStore, verified } from './funnel-helpers.mjs';

async function dashboard(t) {
  const store = tempStore(t); const { server, token } = createDashboard(store);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Launch-Ops-Token': token };
  async function command(action, data) {
    const res = await fetch(`${base}/api/command`, { method: 'POST', headers, body: JSON.stringify({ action, data }) });
    const value = await res.json(); assert.equal(res.status, 200, `${action}: ${JSON.stringify(value)}`); return value.result;
  }
  return { store, base, headers, command };
}
test('HTTP vertical slice: organization → quarantine → verify → select → approve → EML → staff/reply → council/pilot → honest metrics', async t => {
  const { store, command, base, headers } = await dashboard(t);
  await command('registry.import', { ...JSON.parse(fixtureFile('registry.json')), observedAt: new Date().toISOString().slice(0, 10) });
  let s = store.read(); const org = s.organizations[0];
  const domain = { organizationId: org.id, origin: org.website };
  const domainPreview = await command('domains.approve', { ...domain, preview: true });
  await command('domains.approve', { ...domain, ...reviewer(domainPreview.hash), officialDomainConfirmed: true, noMemberLists: true });
  const snapshotInput = { organizationId: org.id, url: `${org.website}/staff`, html: fixtureFile('official-staff.html'), robotsTxt: fixtureFile('robots.txt'), observedAt: new Date().toISOString(), operator };
  const fixturePath = join(store.root, 'snapshot.json'); writeFileSync(fixturePath, JSON.stringify(snapshotInput));
  assert.equal((await runFunnelCommand(store, 'official-fixture', [fixturePath])).added, 1);
  s = store.read(); const c = s.candidates[0]; assert.equal(c.stage, 'discovered'); assert.equal(s.contacts.length, 0);
  await command('candidates.verify', { id: c.id, ...reviewer(candidateHash(c)), publicProfessionalConfirmed: true, accurateEvidenceConfirmed: true, noStudentData: true });
  await command('candidates.select', { id: c.id, operator });
  await command('sender.configure', JSON.parse(fixtureFile('operator.json')));
  const campaign = await command('campaigns.create', { kind: 'interview', context: 'We are exploring a foundation model with an open source and district-owned design.', operator });
  const o = await command('outreach.draft', { candidateId: c.id, campaignId: campaign.id, operator });
  assert.match(o.body, /exploring a foundation model/); assert.match(o.body, /public role evidence does not indicate interest/);
  await command('outreach.approve', { items: [{ id: o.id, reviewedHash: o.hash }], humanReviewed: true, reviewer: operator, truthfulClaimsConfirmed: true, sourceAndRecipientConfirmed: true, complianceConfirmed: true });
  const exported = await command('outreach.export', { ids: [o.id], format: 'eml' });
  const eml = readFileSync(join(store.exportsPath, exported.name), 'utf8'); assert.match(eml, /^X-Unsent: 1\r\n/); assert.match(eml, /X-EducateOS-Approval:/); assert.match(eml, /List-Unsubscribe:/);
  assert.match(Buffer.from(eml.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString(), /unsubscribe@foundation-example.invalid/);
  assert.equal(metrics(store.read()).confirmedSentInvitations, 0); assert.equal(metrics(store.read()).responseRate.value, null);
  // An ambiguous reply never infers consent; review exact scope before council routing.
  const replies = { operator, records: [{ externalId: 'fictional-reply-1', candidateId: c.id, receivedAt: new Date().toISOString(), text: 'I accept a council seat; please discuss it with me.', state: 'interested', sourceUrl: 'https://reply.example.invalid/manual' }] };
  await command('responses.import', replies); s = store.read(); const r = s.responses[0]; assert.equal(r.state, 'ambiguous');
  await command('responses.review', { id: r.id, ...reviewer(responseHash(r)), state: 'interested', requestedScope: 'council', note: 'Explicit council request and acceptance confirmed in the reply.' });
  const council = { candidateId: c.id, kind: 'council' }; const preview = await command('interest.triage', { ...council, preview: true });
  await command('interest.triage', { ...council, ...reviewer(preview.hash), note: 'Explicit acceptance of the educator council seat confirmed.', council: 'educator', seat: 1, acceptedByContact: true });
  // Separate staff opt-in requesting pilot evaluation is quarantined even if export claims verified.
  const record = staffRecord({ externalId: 'fictional-pilot-2', workEmail: 'pilot@cedar-example.invalid', name: 'Riley Example', interestType: 'pilot', verificationStatus: 'verified' });
  const importPath = join(store.root, 'website-export.json'); writeFileSync(importPath, JSON.stringify({ schemaVersion: 1, source: 'website-interest', records: [record] }));
  await runFunnelCommand(store, 'interest-import', [importPath, operator]); s = store.read(); const f = s.staffFeedback[0]; assert.equal(f.status, 'quarantined');
  const result = await command('interest.review', { id: f.id, ...reviewer(interestHash(f)), organizationId: org.id, identityAndOrganizationConfirmed: true, staffOnlyConfirmed: true });
  const pilot = { candidateId: result.candidate.id, kind: 'pilot' }; const pilotPreview = await command('interest.triage', { ...pilot, preview: true });
  await command('interest.triage', { ...pilot, ...reviewer(pilotPreview.hash), note: 'Request for synthetic pilot evaluation only.', scope: 'Synthetic curriculum workflow evaluation', owner: 'Fictional district owner' });
  s = store.read(); const m = metrics(s);
  assert.equal(s.memberships.length, 1); assert.equal(s.pilots.length, 1); assert.equal(m.pilotsGateReady, 0); assert.equal(m.pilotsAuthorized, 0);
  assert.equal(m.distinctContacts, 2); assert.equal(m.expressedInterestContacts, 2); assert.equal(m.expressedInterestOrganizations, 1); assert.equal(m.exportedDrafts, 1); assert.equal(m.confirmedSentInvitations, 0); assert.equal(m.responseRate.value, null);
  const snap = await (await fetch(`${base}/api/state`, { headers })).json(); assert.ok(!Object.hasOwn(snap, 'privacyKeys')); assert.ok(snap.metrics); assert.equal(snap.candidates[0].stage, 'council');
  const html = await (await fetch(base)).text(); const js = await (await fetch(`${base}/app.js`)).text(); assert.match(html, /data-tab="inbound"/); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(/.test(js));
});
test('registry provenance, NCES IDs, domains and names dedupe; data rows never imply contacts or interest', () => {
  const s = baseState(); const input = JSON.parse(fixtureFile('registry.json'));
  input.observedAt = new Date().toISOString().slice(0, 10);
  assert.equal(importRegistry(s, input).replay, true);
  input.attribution = 'Second observation'; input.csv = input.csv.replace('Cedar Example District', 'Renamed Example');
  assert.equal(importRegistry(s, input).added, 0); assert.equal(s.organizations.length, 2); assert.equal(s.organizations[0].ncesId, '0099999');
  assert.equal(s.organizations[0].name, 'Cedar Example District'); assert.equal(s.contacts.length, 0); assert.equal(metrics(s).expressedInterestContacts, 0);
  for (const website of ['http://example.invalid', 'https://127.0.0.1', 'https://example.invalid/?key=x']) assert.throws(() => importRegistry(s, { ...input, csv: `ncesId,name,state,kind,website\n0011111,Example,MI,public,${website}` }));
  assert.throws(() => importRegistry(s, { ...input, approvedSource: false }));
});
test('role segmentation is deterministic evidence vocabulary, never a lead or purchase score', () => {
  assert.equal(segment('Instructional Technology Coach', 'public'), 'instructional-tech');
  for (const [role, kind, expected] of [['Teacher', 'public', 'educator'], ['CTO', 'public', 'district-cto'], ['SIS administrator', 'public', 'sis'], ['Superintendent', 'public', 'superintendent'], ['Head of School', 'private', 'private-school-leader'], ['Director', 'regional', 'regional-org'], ['Budget owner eager buyer', 'public', 'unclassified']]) assert.equal(segment(role, kind), expected);
  const s = discovered(); assert.equal(s.candidates[0].stage, 'discovered'); assert.throws(() => selectCandidate(s, { id: s.candidates[0].id, operator }), /verification/);
});
test('exact approval gates bind recipient, sender, campaign, source and body; no legacy bypass', () => {
  for (const mutate of [s => { s.candidates[0].email = 'changed@cedar-example.invalid'; }, s => { s.operatorConfigs[0].physicalAddress = 'Changed address'; }, s => { s.campaigns[0].context = 'Changed context'; }, s => { s.sourceImports[0].observedAt = '2025-01-01'; }, s => { s.outreach[0].body += '\nChanged'; }]) {
    const s = draft(); approve(s); mutate(s); assert.throws(() => exportOutreach(s, { ids: [s.outreach[0].id], format: 'eml' }));
  }
  const s = draft(); const o = s.outreach[0]; assert.throws(() => exportOutreach(s, { ids: [o.id], format: 'eml', approved: true }));
  assert.throws(() => approveBatch(s, { items: [{ id: o.id, reviewedHash: outreachHash(s, o) }], humanReviewed: false }), /Confirm|review/);
  approve(s); reviseOutreach(s, { id: o.id, subject: 'Changed', body: o.body, operator }); assert.equal(o.approval, null);
  approve(s); reviseCampaign(s, { id: s.campaigns[0].id, context: 'Updated evidence', active: true, operator }); assert.equal(o.approval, null);
  assert.throws(() => draftInvitation(s, { contactId: s.contacts[0].id, council: 'educator', sender: operator }), /campaign pipeline/);
  assert.throws(() => createCampaign(s, { kind: 'interview', context: 'We have signed Clever agreements and participating districts', operator }), /unsupported/);
  assert.throws(() => reviseOutreach(s, { id: o.id, subject: 'Hello\r\nBcc: bad@example.invalid', body: o.body, operator }), /one line|controls/);
});
test('dedupe, organization contact cap, daily cap, cooldown and one follow-up work across campaigns', () => {
  const s = draft(); approve(s); exportOutreach(s, { ids: [s.outreach[0].id], format: 'eml' });
  assert.throws(() => exportOutreach(s, { ids: [s.outreach[0].id], format: 'eml' }), /Already handed/);
  assert.throws(() => draftOutreach(s, { candidateId: s.candidates[0].id, campaignId: s.campaigns[0].id, followUpOf: s.outreach[0].id, operator }), /interval/);
  const first = s.outreach[0]; first.exportedAt = new Date(Date.now() - 31 * 86400_000).toISOString(); s.handoffs[0].at = first.exportedAt;
  const followup = draftOutreach(s, { candidateId: s.candidates[0].id, campaignId: s.campaigns[0].id, followUpOf: first.id, operator });
  approveBatch(s, { items: [{ id: followup.id, reviewedHash: outreachHash(s, s.outreach[1]) }], humanReviewed: true, reviewer: operator, truthfulClaimsConfirmed: true, sourceAndRecipientConfirmed: true, complianceConfirmed: true });
  s.operatorConfigs[0].dailyCap = 1; // A config change invalidates approvals, even direct disk mutation.
  assert.throws(() => exportOutreach(s, { ids: [followup.id], format: 'eml' }), /approval/);
  approveBatch(s, { items: [{ id: followup.id, reviewedHash: outreachHash(s, s.outreach[1]) }], humanReviewed: true, reviewer: operator, truthfulClaimsConfirmed: true, sourceAndRecipientConfirmed: true, complianceConfirmed: true });
  s.handoffs.push({ id: 'other', organizationId: 'other', at: new Date().toISOString() }); assert.throws(() => exportOutreach(s, { ids: [followup.id], format: 'eml' }), /cap/); s.handoffs.pop();
  exportOutreach(s, { ids: [followup.id], format: 'eml' }); assert.throws(() => draftOutreach(s, { candidateId: s.candidates[0].id, campaignId: s.campaigns[0].id, followUpOf: first.id, operator }), /Only one/);
  const sameOrg = { ...s.candidates[0], id: 'another', email: 'other@cedar-example.invalid', stage: 'verified', contactId: 'other-contact' }; sameOrg.verification = { hash: candidateHash(sameOrg) }; s.candidates.push(sameOrg); s.contacts.push({ ...s.contacts[0], id: 'other-contact', email: sameOrg.email });
  assert.throws(() => selectCandidate(s, { id: sameOrg.id, operator }), /One initial/);
});
test('website schema enforces quarantine, bounds and consent scope; minimal optout blocks immediately across delete/reimport', () => {
  const s = baseState(); const record = staffRecord(); const envelope = { schemaVersion: 1, source: 'website-interest', records: [record] };
  importInterest(s, { envelope, operator }); importInterest(s, { envelope, operator }); assert.equal(s.staffFeedback.length, 1); assert.equal(s.contacts.length, 0);
  for (const change of [{ extraStudentField: 'forbidden' }, { limitedFeedback: 'student name: Example' }, { limitedFeedback: 'password=credential' }, { limitedFeedback: 'https://example.invalid' }, { limitedFeedback: 'x'.repeat(1501) }, { marketingOptIn: 'true' }]) assert.throws(() => importInterest(s, { operator, envelope: { ...envelope, records: [{ ...record, ...change }] } }));
  const f = s.staffFeedback[0]; const result = reviewInterest(s, { id: f.id, ...reviewer(interestHash(f)), organizationId: s.organizations[0].id, identityAndOrganizationConfirmed: true, staffOnlyConfirmed: true });
  configureOperator(s, JSON.parse(fixtureFile('operator.json'))); selectCandidate(s, { id: result.candidate.id, operator });
  const campaign = createCampaign(s, { kind: 'council', context: 'Fictional council request', operator }); assert.throws(() => draftOutreach(s, { candidateId: result.candidate.id, campaignId: campaign.id, operator }), /consent scope/);
  const optout = { ...record, externalId: 'minimal-optout', name: '', org: '', role: '', state: 'other', interestType: 'unsubscribe', marketingOptIn: false, responseConsent: false, staffConfirmed: false, privacyAcknowledged: false, referralSource: 'unsubscribe' };
  importInterest(s, { operator, envelope: { ...envelope, records: [optout] } }); assert.equal(s.contacts[0].suppressed, true);
  const before = s.staffFeedback.length; importInterest(s, { operator, envelope: { ...envelope, records: [staffRecord({ externalId: 'new-attempt' })] } }); assert.equal(s.staffFeedback.length, before);
  const preview = erasePersonalData(s, { address: record.workEmail, preview: true }); erasePersonalData(s, { address: record.workEmail, ...reviewer(preview.hash), deletionAuthorityConfirmed: true });
  assert.equal(s.contacts.length, 0); assert.equal(s.candidates.length, 0); assert.equal(s.staffFeedback.length, 0); assert.ok(s.suppressions.length > 0);
  importInterest(s, { operator, envelope: { ...envelope, records: [staffRecord({ externalId: 'after-erasure' })] } }); assert.equal(s.staffFeedback.length, 0);
  assert.ok(!JSON.stringify(s).includes(record.workEmail)); assert.ok(!Object.hasOwn(dashboardSnapshot(s), 'privacyKeys'));
});
test('ambiguous and negative wording cannot silently suppress or grant consent; explicit optout is immediate', () => {
  const s = verified(); const c = s.candidates[0];
  const reply = text => ({ externalId: `reply-${s.responses.length}`, candidateId: c.id, receivedAt: new Date().toISOString(), text, state: 'interested', sourceUrl: 'https://reply.example.invalid/manual' });
  importResponses(s, { records: [reply('That sounds interesting but I am not sure.')], operator }); assert.equal(s.responses[0].state, 'ambiguous'); assert.equal(s.contacts[0].suppressed, false);
  assert.throws(() => triageInterest(s, { candidateId: c.id, kind: 'council', preview: true }), /Explicit/);
  const r = s.responses[0]; reviewResponse(s, { id: r.id, ...reviewer(responseHash(r)), state: 'ambiguous', requestedScope: 'none', note: 'No explicit request or opt-out.' });
  assert.throws(() => reviewResponse(s, { id: r.id, ...reviewer(responseHash(r)), state: 'ambiguous', requestedScope: 'pilot', note: 'Ambiguous' }), /No consent/);
  importResponses(s, { records: [reply('I am not interested in the demo right now.')], operator }); assert.equal(s.contacts[0].suppressed, false);
  const negative = s.responses.at(-1); reviewResponse(s, { id: negative.id, ...reviewer(responseHash(negative)), state: 'declined', requestedScope: 'none', note: 'Human confirmed decline.' }); assert.equal(s.contacts[0].suppressed, true);
  importResponses(s, { records: [reply('unsubscribe')], operator }); assert.equal(s.responses.at(-1).state, 'unsubscribed');
});
test('daily is idempotent and cannot approve, select or export; legacy private state migrates without data loss', t => {
  const store = tempStore(t); const old = emptyState(); importContacts(old, { csv: fixtureFile('fictional-contacts.csv'), operator, publicProfessionalOnly: true, noStudentData: true });
  for (const k of ['organizations', 'candidates', 'outreach', 'responses']) delete old[k]; writeFileSync(store.statePath, JSON.stringify(old)); chmodSync(store.statePath, 0o600);
  const migrated = new Store(store.root).read(); assert.equal(migrated.contacts.length, 4); assert.deepEqual(migrated.candidates, []);
  const s = draft(); const first = dailyWorkflow(s, { operator }); const second = dailyWorkflow(s, { operator }); assert.equal(first.id, second.id); assert.equal(second.replay, true); assert.equal(s.outreach[0].approval, null); assert.equal(s.handoffs.length, 0);
  const before = s.contacts[0].email; suppressCandidate(s, { id: s.candidates[0].id, reason: 'optout', operator }); s.contacts = []; importContacts(s, { contacts: [{ name: 'Another', email: before, organization: s.organizations[0].name, role: 'Teacher', sourceUrl: 'https://cedar-example.invalid/staff', tags: ['teaching'] }], operator, publicProfessionalOnly: true, noStudentData: true }); assert.equal(s.contacts.length, 0);
});
test('only independently confirmed sends enter response denominators, meeting dispositions stay integrated', () => {
  const s = draft(); approve(s); exportOutreach(s, { ids: [s.outreach[0].id], format: 'eml' }); assert.equal(metrics(s).responseRate.value, null);
  const input = { handoffId: s.handoffs[0].id, at: new Date().toISOString(), status: 'sent', reference: 'Fictional external dispatch receipt TEST-1' };
  const preview = recordDelivery(s, { ...input, preview: true }); recordDelivery(s, { ...input, ...reviewer(preview.hash), independentEvidenceConfirmed: true }); assert.equal(metrics(s).confirmedSentInvitations, 1); assert.equal(metrics(s).confirmedDeliveredInvitations, 0); assert.equal(metrics(s).responseRate.value, 0);
  const meeting = createMeeting(s, { council: 'educator', title: 'Fictional staff meeting', startsAt: new Date().toISOString(), agenda: [{ topic: 'Staff workflow', facilitator: operator, minutes: 20 }] });
  const record = staffRecord({ workEmail: 'feedback@cedar-example.invalid', externalId: 'feedback-2', interestType: 'feedback', name: 'Casey Example' }); importInterest(s, { operator, envelope: { schemaVersion: 1, source: 'website-interest', records: [record] } });
  const f = s.staffFeedback[0]; const result = reviewInterest(s, { id: f.id, ...reviewer(interestHash(f)), organizationId: s.organizations[0].id, identityAndOrganizationConfirmed: true, staffOnlyConfirmed: true }); const triage = { candidateId: result.candidate.id, kind: 'feedback' }; const p = triageInterest(s, { ...triage, preview: true });
  triageInterest(s, { ...triage, ...reviewer(p.hash), note: 'Please improve keyboard navigation.', meetingId: meeting.id }); disposeFeedback(s, { id: s.feedback[0].id, disposition: 'accepted', rationale: 'Staff usability evidence', followUp: 'Fictional action TEST-2', operator }); assert.equal(metrics(s).meetingFeedback.accepted, 1);
});
test('local synthetic form refuses real addresses and extra fields and does not auto-verify', () => {
  const s = baseState(); const input = { record: staffRecord(), operator, syntheticLocalTest: true, noticeVersion: 'staff-local-v1' };
  assert.throws(() => submitStaffFeedback(s, { ...input, studentName: 'forbidden' })); assert.throws(() => submitStaffFeedback(s, { ...input, record: { ...input.record, workEmail: 'person@real.example' } }), /fictional/);
  submitStaffFeedback(s, input); assert.equal(s.staffFeedback[0].status, 'quarantined'); assert.equal(s.contacts.length, 0);
});
test('EML and spreadsheet exports encode untrusted display text, no formula or header injection', () => {
  const s = draft(); s.candidates[0].name = '=1+1'; s.contacts[0].name = '=1+1'; s.candidates[0].verification.hash = candidateHash(s.candidates[0]); approve(s);
  const csv = exportOutreach(s, { ids: [s.outreach[0].id], format: 'csv' }); assert.ok(csv.includes('"\'=1+1"'));
});
