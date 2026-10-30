import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GoogleApi } from '../src/google-api.mjs';
import { decodeBase64url, decodeHeader, plainText, replyText } from '../src/google-mime.mjs';
import { mockGoogle } from '../src/google-fixtures.mjs';
import { simulateGoogle, businessSlot } from '../src/simulate-google.mjs';
import { previewGmail, approveGmail, createGmailDraft, reconcileDraft, reconcileSent, readReplies, validateSlot, createCalendarHold, reconcileHold, acceptMeetingRequest, reviewMeeting, proposeHold } from '../src/google-bridge.mjs';
import { runGoogleCommand } from '../src/google-cli.mjs';
import { exportOutreach, reviseCampaign, suppressCandidate } from '../src/campaigns.mjs';
import { erasePersonalData, metrics } from '../src/operations.mjs';
import { dashboardSnapshot, createDashboard } from '../src/server.mjs';
import { funnelMutations } from '../src/funnel.mjs';
import { approve, draft, operator, reviewer, tempStore } from './funnel-helpers.mjs';

function apiFor(model, extra = {}) { return new GoogleApi({ transport: model.transport, accessToken: () => 'synthetic-access-only', ...extra }); }
function setup(t) {
  const store = tempStore(t); const s = draft(); approve(s); exportOutreach(s, { ids: [s.outreach[0].id], format: 'eml' });
  const p = previewGmail(s, { handoffId: s.handoffs[0].id }); const d = approveGmail(s, { handoffId: p.handoffId, ...reviewer(p.hash), messageIdDomainControlled: true });
  store.transaction(state => Object.assign(state, s)); const model = mockGoogle(); model.mailbox = s.operatorConfigs[0].senderEmail;
  const api = apiFor(model); const input = { id: d.id, handoffId: d.handoffId, reviewedHash: d.hash, allowNetwork: true, createGmailDraft: true };
  return { store, model, api, input, d, read: { id: d.id, allowNetwork: true, readGoogle: true } };
}
async function sent(t) { const x = setup(t); await createGmailDraft(x.store, x.input, x.api); x.model.externalHumanSent(); await reconcileSent(x.store, x.read, x.api); return x; }
async function holdSetup(t) {
  const store = tempStore(t); await simulateGoogle(store); store.transaction(s => { s.calendarHolds[0].status = 'proposed'; delete s.calendarHolds[0].meetingId; });
  const h = store.read().calendarHolds[0]; const model = mockGoogle(); model.mailbox = store.read().operatorConfigs[0].senderEmail;
  return { store, h, model, api: apiFor(model), input: { id: h.id, reviewedHash: h.approval.hash, allowNetwork: true, createCalendarHold: true } };
}
const postCount = model => model.calls.filter(c => c.method === 'POST').length;

test('synthetic website export → quarantine → source/consent review → approved Gmail → actual SENT → reply → council → hold → verified meeting decision', async t => {
  const store = tempStore(t); const result = await simulateGoogle(store); const s = store.read();
  assert.equal(result.realNetworkCalls, 0); assert.equal(s.staffFeedback[0].record.marketingOptIn, false); assert.equal(s.memberships.length, 1);
  assert.equal(result.metrics.confirmedSentInvitations, 1); assert.equal(result.metrics.confirmedDeliveredInvitations, 0); assert.equal(result.metrics.responseRate.value, 1);
  assert.equal(s.feedback[0].disposition, 'accepted'); assert.equal(s.meetings[0].actions.length, 1); assert.ok(s.meetings[0].review.meetingOccurredConfirmed);
  for (const event of ['google.draft-intent-durable', 'google.actual-sent-verified', 'google.hold-intent-durable', 'google.meeting-disposition-human-verified']) assert.ok(result.auditEvents.includes(event));
  assert.ok(result.requests.every(c => !/\/send\b|batch|watch/.test(c.url))); assert.equal(result.requests.filter(c => c.method === 'POST').length, 3);
  assert.ok(!JSON.stringify(s).includes('synthetic-access-only')); assert.ok(!JSON.stringify(s.responses).includes('phone 555'));
});
test('draft exact handoff/hash and mailbox gates; post-create verification and idempotence; draft is never counted as sent', async t => {
  const x = setup(t);
  await assert.rejects(createGmailDraft(x.store, { ...x.input, handoffId: 'other' }, x.api), /exact/);
  await assert.rejects(createGmailDraft(x.store, { ...x.input, reviewedHash: 'stale' }, x.api), /exact/);
  x.model.mailbox = 'wrong@owner-example.invalid'; await assert.rejects(createGmailDraft(x.store, x.input, x.api), /mailbox/); assert.equal(postCount(x.model), 0);
  x.model.mailbox = x.store.read().operatorConfigs[0].senderEmail; const d = await createGmailDraft(x.store, x.input, x.api);
  assert.equal(d.status, 'created'); assert.equal(d.draftId, x.model.fixture.draftId); assert.equal(d.threadId, x.model.fixture.threadId); assert.match(d.rfcId, /^<[a-f0-9-]+@foundation-example.invalid>$/);
  await createGmailDraft(x.store, x.input, x.api); assert.equal(postCount(x.model), 1); assert.equal(metrics(x.store.read()).confirmedSentInvitations, 0);
});
test('source/campaign/sender/copy/suppression changes invalidate draft approval before POST', async t => {
  const changes = [s => { s.outreach[0].body += ' Changed'; }, s => { s.candidates[0].sourceUrl += '/changed'; },
    s => { s.operatorConfigs[0].senderName += ' Changed'; }, s => reviseCampaign(s, { id: s.campaigns[0].id, context: 'Changed context', active: true, operator }),
    s => suppressCandidate(s, { id: s.candidates[0].id, reason: 'optout', operator })];
  for (const change of changes) { const x = setup(t); x.store.transaction(change); await assert.rejects(createGmailDraft(x.store, x.input, x.api), /stale|verification|suppressed/); assert.equal(postCount(x.model), 0); }
});
test('durable uncertain intent precedes POST; timeout after write cannot retry; exact draft reconciliation recovers', async t => {
  const x = setup(t); x.model.afterWriteFailure = true; const transport = x.model.transport;
  const api = apiFor(x.model, { transport: (url, init) => { if (init.method === 'POST') assert.equal(x.store.read().googleDrafts[0].status, 'uncertain'); return transport(url, init); } });
  await assert.rejects(createGmailDraft(x.store, x.input, api), /uncertain/); assert.equal(x.store.read().googleDrafts[0].status, 'uncertain');
  await assert.rejects(createGmailDraft(x.store, x.input, api), /reconcile/); assert.equal(postCount(x.model), 1);
  x.model.afterWriteFailure = false; const d = await reconcileDraft(x.store, x.read, x.api); assert.equal(d.status, 'created'); assert.equal(postCount(x.model), 1);
});
test('crash before POST leaves uncertain; absent/duplicate drafts never silently release lock', async t => {
  const x = setup(t); x.store.transaction(s => { s.googleDrafts[0].status = 'uncertain'; });
  const empty = await reconcileDraft(x.store, x.read, x.api); assert.equal(empty.status, 'uncertain'); assert.match(empty.note, /not proof/);
  await assert.rejects(createGmailDraft(x.store, x.input, x.api), /reconcile/);
  assert.throws(() => funnelMutations['google.release'](x.store.read(), { id: x.d.id, ...reviewer(empty.hash) }), /manual/);
  const release = { id: x.d.id, ...reviewer(empty.hash), noDraftInGmailConfirmed: true, duplicateRiskAcknowledged: true };
  x.store.transaction(s => funnelMutations['google.release'](s, release)); assert.equal(x.store.read().googleDrafts[0].status, 'approved');
  await createGmailDraft(x.store, x.input, x.api); const copy = structuredClone([...x.model.drafts.values()][0]); copy.id = 'duplicate'; x.model.drafts.set(copy.id, copy);
  await assert.rejects(reconcileDraft(x.store, x.read, x.api), /Duplicate/); assert.equal(postCount(x.model), 1);
});
test('altered draft read-back fails closed with known container saved and no retry', async t => {
  const x = setup(t); const transport = x.model.transport;
  const api = apiFor(x.model, { transport: async (url, init) => {
    const response = await transport(url, init); if (init.method === 'GET' && new URL(url).pathname.includes('/drafts/')) {
      const d = await response.json(); d.message.payload.body.data = Buffer.from('Altered copy').toString('base64url'); return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
    } return response;
  } });
  await assert.rejects(createGmailDraft(x.store, x.input, api), /uncertain/); assert.equal(x.store.read().googleDrafts[0].draftId, x.model.fixture.draftId);
  await assert.rejects(createGmailDraft(x.store, x.input, api), /reconcile/); assert.equal(postCount(x.model), 1);
});
test('Gmail changed message ID after actual send; SENT label and approved sender/recipient/body mandatory, imported send claims ignored', async t => {
  const x = setup(t); await createGmailDraft(x.store, x.input, x.api);
  assert.equal((await reconcileSent(x.store, x.read, x.api)).status, 'unconfirmed'); const m = x.model.externalHumanSent(); assert.notEqual(m.id, x.model.fixture.draftMessageId);
  const original = structuredClone(m);
  for (const mutate of [m => { m.payload.body.data = Buffer.from('Changed sent body').toString('base64url'); }, m => { m.payload.headers.find(h => h.name === 'To').value = 'other@school-example.invalid'; }, m => { m.payload.headers.push({ name: 'Cc', value: 'extra@school-example.invalid' }); }]) {
    Object.assign(m, structuredClone(original)); mutate(m); await assert.rejects(reconcileSent(x.store, x.read, x.api), /no compliant send/); assert.equal(metrics(x.store.read()).confirmedSentInvitations, 0);
  }
  Object.assign(m, original); await reconcileSent(x.store, x.read, x.api); await reconcileSent(x.store, x.read, x.api); assert.equal(metrics(x.store.read()).confirmedSentInvitations, 1);
  m.labelIds = ['INBOX']; assert.equal((await reconcileSent(x.store, x.read, x.api)).status, 'unconfirmed');
  assert.ok(x.model.calls.filter(c => c.url.includes('/messages?')).every(c => new URL(c.url).searchParams.get('labelIds') === 'SENT'));
});
test('bounded MIME base64url, UTF-8 B/Q headers, nested plain parts; reject HTML-only, attachments, duplicate text and invalid encoding', () => {
  assert.equal(decodeBase64url(Buffer.from('Héllo').toString('base64url')), 'Héllo'); assert.equal(decodeHeader('=?UTF-8?B?SMOpbGxv?='), 'Héllo'); assert.equal(decodeHeader('=?UTF-8?Q?H=C3=A9llo_group?='), 'Héllo group');
  assert.throws(() => decodeBase64url('a'), /encoding/); assert.throws(() => decodeBase64url('%%%'), /encoding/); assert.throws(() => decodeBase64url('_w'), /encoded data/);
  const part = { mimeType: 'text/plain', body: { data: Buffer.from('new text').toString('base64url') } };
  assert.equal(plainText({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [part] }] }), 'new text');
  for (const p of [{ mimeType: 'text/html' }, { ...part, filename: 'attachment.txt' }, { mimeType: 'multipart/mixed', parts: [part, part] }, { ...part, body: { data: 'a'.repeat(64_001) } }]) assert.throws(() => plainText(p));
});
test('reply strips signature/quoted history and redacts URL/email/phone/credentials; STOP suppresses immediately without review', async t => {
  const x = await sent(t); const reply = x.model.addReply();
  reply.payload.parts[0].body.data = Buffer.from('STOP\nContact foo@other.invalid or https://example.invalid or 555-555-0100\npassword=fictional\n\n-- \nDiscard signature\nOn Monday, Person wrote:\n> old history').toString('base64url');
  const result = await readReplies(x.store, x.read, x.api); assert.equal(result.added, 1); const s = x.store.read(); const r = s.responses[0];
  assert.equal(r.state, 'unsubscribed'); assert.equal(r.review, null); assert.equal(s.contacts[0].suppressed, true); assert.equal(s.outreach[0].approval, null);
  for (const value of ['foo@', 'https://example', '555-555', 'password=', 'signature', 'old history']) assert.ok(!r.text.includes(value));
  assert.equal((await readReplies(x.store, x.read, x.api)).added, 0); assert.equal(s.responses.length, 1);
  assert.equal(replyText('Maybe later\n\nOn Monday, Person wrote:\n> please unsubscribe me').optout, false);
});
test('same-thread spoofed sender and unsupported risky bodies retain only opaque IDs/hash; explicit interest still needs review', async t => {
  const x = await sent(t); const spoof = x.model.addReply(); spoof.payload.headers.find(h => h.name === 'From').value = 'spoof@unsolicited.invalid';
  const bad = x.model.addReply({ id: 'bad_body_4' }); bad.payload.parts = [{ mimeType: 'text/html', body: { data: Buffer.from('risky personal body').toString('base64url') } }];
  const good = x.model.addReply({ id: 'good_reply_5' }); good.payload.parts[0].body.data = Buffer.from('I would like a preview.').toString('base64url');
  const result = await readReplies(x.store, x.read, x.api); assert.deepEqual(result, { added: 1, quarantined: 2 }); const s = x.store.read(); assert.equal(s.responses[0].state, 'ambiguous'); assert.equal(s.responses[0].review, null);
  assert.ok(!JSON.stringify(s.googleQuarantine).includes('spoof@')); assert.ok(!JSON.stringify(s.googleQuarantine).includes('risky personal'));
  assert.throws(() => acceptMeetingRequest(s, { candidateId: s.candidates[0].id, responseId: s.responses[0].id }), /Reviewed/);
});
test('strict transport: fixed URLs, no send method, no redirects, failures/limits/timeouts sanitized and no token persistence', async () => {
  const model = mockGoogle(); const api = apiFor(model); assert.equal(api.send, undefined); assert.equal(api.request, undefined); assert.equal(api.messagesSend, undefined);
  for (const id of ['https://evil.invalid', '../send', 'x?y', 'x#z']) await assert.rejects(async () => api.getDraft(id), /opaque/);
  for (const response of [new Response('secret-response', { status: 401 }), new Response('', { status: 302, headers: { Location: 'https://evil.invalid' } }), new Response('{}', { headers: { 'Content-Type': 'text/html' } }), new Response('a'.repeat(1_000_001), { headers: { 'Content-Type': 'application/json' } })]) {
    const broken = new GoogleApi({ transport: async (_url, init) => { assert.equal(init.redirect, 'error'); return response; }, accessToken: () => 'private-test-token' });
    await assert.rejects(broken.profile(), e => e.message === 'Google request failed; no automatic retry');
  }
  const timeout = new GoogleApi({ transport: () => new Promise(() => {}), accessToken: () => 'private-test-token', timeoutMs: 10 });
  await assert.rejects(timeout.profile(), /no automatic retry/); assert.ok(!JSON.stringify(api).includes('private-test-token'));
});
test('Calendar accepts reviewed explicit request only, expiry/suppression revoke; no inferred role/consent or future meeting disposition', async t => {
  const x = await holdSetup(t); const s = x.store.read(); const h = s.calendarHolds[0];
  assert.throws(() => acceptMeetingRequest(s, { candidateId: s.candidates[0].id, responseId: s.responses[0].id }), /Independently/);
  assert.throws(() => reviewMeeting(s, { holdId: h.id, meetingOccurredConfirmed: true }), /Verified internal hold/);
  x.store.transaction(s => { s.meetingRequests[0].expiresAt = '2000-01-01T00:00:00Z'; }); await assert.rejects(createCalendarHold(x.store, x.input, x.api), /expired/); assert.equal(postCount(x.model), 0);
  x.store.transaction(s => { s.meetingRequests[0].expiresAt = new Date(Date.now() + 86400_000).toISOString(); suppressCandidate(s, { id: s.candidates[0].id, reason: 'optout', operator }); });
  await assert.rejects(createCalendarHold(x.store, x.input, x.api), /suppressed/); assert.equal(postCount(x.model), 0);
});
test('Calendar availability recheck, explicit flags, deterministic base32hex id, private no-attendee POST and successful idempotence', async t => {
  const x = await holdSetup(t); await assert.rejects(createCalendarHold(x.store, { ...x.input, createCalendarHold: false }, x.api), /opt-in/);
  x.model.busy = [{ start: x.h.slot.start, end: x.h.slot.end }]; await assert.rejects(createCalendarHold(x.store, x.input, x.api), /busy/); assert.equal(x.model.events.size, 0);
  x.model.busy = []; const h = await createCalendarHold(x.store, x.input, x.api); assert.match(h.eventId, /^[a-v0-9]{5,1024}$/); assert.equal(h.status, 'created');
  const insert = x.model.calls.find(c => c.url.includes('/events?')); assert.equal(insert.body.visibility, 'private'); assert.ok(!Object.hasOwn(insert.body, 'attendees')); assert.equal(new URL(insert.url).searchParams.get('sendUpdates'), 'none');
  await createCalendarHold(x.store, x.input, x.api); assert.equal(x.model.events.size, 1); assert.equal(x.model.calls.filter(c => c.url.includes('/events?')).length, 1);
  assert.throws(() => x.api.createHold({ ...insert.body, attendees: [] }), /without attendee/);
  assert.throws(() => proposeHold(x.store.read(), { requestId: x.h.requestId, slot: x.h.slot, council: 'educator', agenda: ['Topic'], operator, attendees: [] }), /no attendees/);
  assert.throws(() => reviewMeeting(x.store.read(), { holdId: h.id, meetingOccurredConfirmed: true }), /future meeting/);
});
test('Calendar timeout after write persists uncertain and blocks duplicate; GET deterministic event recovers without second insert', async t => {
  const x = await holdSetup(t); x.model.afterWriteFailure = true; const transport = x.model.transport;
  const api = apiFor(x.model, { transport: (url, init) => { if (url.includes('/events?')) assert.equal(x.store.read().calendarHolds[0].status, 'uncertain'); return transport(url, init); } });
  await assert.rejects(createCalendarHold(x.store, x.input, api), /uncertain/); assert.equal(x.model.events.size, 1);
  await assert.rejects(createCalendarHold(x.store, x.input, api), /never retry/); x.model.afterWriteFailure = false;
  const h = await reconcileHold(x.store, { id: x.h.id, allowNetwork: true, readGoogle: true }, x.api); assert.equal(h.status, 'created'); assert.equal(x.model.calls.filter(c => c.url.includes('/events?')).length, 1);
});
test('timezones/RFC3339/business hours/duration/DST validation reject wrong offsets and nonexistent spring times', () => {
  assert.equal(validateSlot(businessSlot()).timeZone, 'America/Detroit');
  for (const slot of [
    { ...businessSlot(), timeZone: 'Not/AZone' }, { ...businessSlot(), start: businessSlot().start.slice(0, -1) },
    { ...businessSlot(), start: '2000-01-01T10:00:00Z' }, { ...businessSlot(), end: new Date(Date.parse(businessSlot().start) + 90 * 60_000).toISOString() },
    { ...businessSlot(), attendees: [] }, { ...businessSlot(), start: businessSlot().start.replace('T15:', 'T02:'), end: businessSlot().end.replace('T15:', 'T02:') },
  ]) assert.throws(() => validateSlot(slot));
  // Freeze only this test's validation clock to exercise both sides of the 2027 DST transition.
  const actualNow = Date.now; Date.now = () => Date.parse('2027-03-01T00:00:00Z');
  try {
    assert.equal(validateSlot({ start: '2027-03-15T10:00:00-04:00', end: '2027-03-15T10:20:00-04:00', timeZone: 'America/Detroit' }).start, '2027-03-15T14:00:00.000Z');
    assert.throws(() => validateSlot({ start: '2027-03-15T10:00:00-05:00', end: '2027-03-15T10:20:00-05:00', timeZone: 'America/Detroit' }), /DST/);
    assert.throws(() => validateSlot({ start: '2027-03-14T02:10:00-05:00', end: '2027-03-14T02:30:00-05:00', timeZone: 'America/Detroit' }));
  } finally { Date.now = actualNow; }
});
test('CLI flags cannot be supplied in JSON; offline synthetic command smoke on current Node, help and approval surface remain compatible', async t => {
  const x = setup(t); const path = join(x.store.root, 'google.json'); writeFileSync(path, JSON.stringify({ schemaVersion: 1, id: x.d.id, handoffId: x.d.handoffId, reviewedHash: x.d.hash }));
  await assert.rejects(runGoogleCommand(x.store, 'google-draft', [path], x.api), /flags/); assert.equal(x.model.calls.length, 0);
  await runGoogleCommand(x.store, 'google-draft', ['--allow-network', '--create-gmail-draft', path], x.api); assert.equal(postCount(x.model), 1);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, id: x.d.id, allowNetwork: true })); await assert.rejects(runGoogleCommand(x.store, 'google-draft', ['--allow-network', '--create-gmail-draft', path], x.api), /fields/);
  const cli = new URL('../src/cli.mjs', import.meta.url); const result = JSON.parse(execFileSync(process.execPath, [cli.pathname, 'simulate-google'], { encoding: 'utf8' })); assert.equal(result.realNetworkCalls, 0); assert.equal(result.metrics.meetingFeedback.accepted, 1);
  assert.match(execFileSync(process.execPath, [cli.pathname, 'help'], { encoding: 'utf8' }), /--create-calendar-hold/);
  assert.ok(dashboardSnapshot(x.store.read()).googleDrafts[0].threadId); assert.ok(funnelMutations['calendar.approve']);
});
test('erasure purges Google IDs, excerpts, linked holds/requests and meeting notes while retaining suppression', async t => {
  const store = tempStore(t); await simulateGoogle(store); const address = store.read().candidates[0].email;
  store.transaction(s => { const p = erasePersonalData(s, { address, preview: true }); erasePersonalData(s, { address, ...reviewer(p.hash), deletionAuthorityConfirmed: true }); });
  const s = store.read(); for (const key of ['googleDrafts', 'googleQuarantine', 'meetingRequests', 'calendarHolds', 'responses', 'meetings', 'feedback']) assert.equal(s[key].length, 0, key);
  assert.ok(s.suppressions.length > 0); assert.ok(!JSON.stringify(s).includes('known_thread_1')); assert.ok(!JSON.stringify(s).includes(address));
});
test('dashboard Google state stays loopback/CSRF protected and cannot invoke any network command', async t => {
  const store = tempStore(t); const { server, token } = createDashboard(store); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })); const base = `http://127.0.0.1:${server.address().port}`;
  for (const action of ['google-draft', 'calendar-hold', 'google-replies']) {
    const res = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Launch-Ops-Token': token }, body: JSON.stringify({ action, data: {} }) }); assert.equal(res.status, 400);
  }
  const res = await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.invalid', 'X-Launch-Ops-Token': token } }); assert.equal(res.status, 400);
  assert.match(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /renderGoogle/);
});
