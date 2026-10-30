import { check, hash, human, id, now, oneOf } from './safety.mjs';
import { audit } from './store.mjs';
import { exact, get, safe, staffText } from './funnel-common.mjs';
import { candidateHash } from './discovery.mjs';
import { outreachHash } from './campaigns.mjs';
import { responseHash } from './inbound.mjs';
import { isSuppressed, suppress } from './suppression.mjs';
import { googleId } from './google-api.mjs';
import { copyHash, headers, mailbox, messageCopy, plainText, replyText } from './google-mime.mjs';
import { createMeeting, addAction, addFeedback, disposeFeedback } from './domain.mjs';

function verified(s, candidateId) {
  const c = get(s, 'candidates', candidateId); const org = get(s, 'organizations', c.organizationId);
  check(c.verification?.hash === candidateHash(c), 'Current professional identity verification required');
  check(!isSuppressed(s, c.email, org.name), 'Contact or organization suppressed'); return c;
}
function draftBasis(s, handoffId) {
  const h = get(s, 'handoffs', handoffId); const o = get(s, 'outreach', h.outreachId); const c = verified(s, h.candidateId);
  check(h.approvalHash === outreachHash(s, o) && o.approval?.hash === h.approvalHash, 'Handoff approval is stale');
  check(get(s, 'campaigns', o.campaignId).active && !s.responses.some(r => r.candidateId === c.id), 'Campaign paused or reply pending; no draft creation');
  check(Date.now() - Date.parse(c.observedAt) <= 90 * 86400_000, 'Source evidence stale');
  const from = s.operatorConfigs[0].senderEmail; const domain = from.split('@')[1];
  return { handoffId: h.id, candidateId: c.id, approvedHash: h.approvalHash, suppression: false,
    rfcId: `<${h.id}@${domain}>`, copy: { from, to: c.email, subject: o.subject, body: o.body } };
}
export function previewGmail(s, input) {
  const basis = draftBasis(s, input.handoffId);
  return { version: 1, ...basis, hash: hash(basis), policy: 'Create exactly this Gmail draft; no sending' };
}
export function approveGmail(s, input) {
  const preview = previewGmail(s, input); const reviewer = human(input, preview.hash);
  check(input.messageIdDomainControlled === true, 'Confirm control of configured sender domain for stable Message-ID');
  check(!s.googleDrafts.some(d => d.handoffId === input.handoffId), 'Gmail intent exists; reconcile it, never create another');
  const record = { id: id(), handoffId: input.handoffId, candidateId: preview.candidateId, hash: preview.hash, approvedHash: preview.approvedHash,
    rfcId: preview.rfcId, copyHash: copyHash(preview.copy), sender: preview.copy.from, recipient: preview.copy.to, reviewer, approvedAt: now(), status: 'approved' };
  s.googleDrafts.push(record); audit(s, 'google.draft-approved', record.id, reviewer); return record;
}
function rfc2822(p) {
  const subject = `=?UTF-8?B?${Buffer.from(p.copy.subject).toString('base64')}?=`;
  const body = Buffer.from(p.copy.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
  return Buffer.from(`From: <${p.copy.from}>\r\nTo: <${p.copy.to}>\r\nSubject: ${subject}\r\nMessage-ID: ${p.rfcId}\r\nX-EducateOS-Approval: ${p.approvedHash}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`).toString('base64url');
}
async function authorized(api, sender) {
  const p = await api.profile(); check(typeof p.emailAddress === 'string' && p.emailAddress.toLowerCase() === sender, 'Authorized Google mailbox does not match configured sender');
}
function requireNetwork(input, flag) { check(input.allowNetwork === true && input[flag] === true, 'Explicit CLI network and operation opt-in required'); }
function matchingDraft(result, d) {
  googleId(result.id); googleId(result.message?.id); googleId(result.message?.threadId);
  check(result.message.labelIds?.includes('DRAFT'), 'Gmail draft read-back lacks DRAFT label');
  const copy = messageCopy(result.message);
  check(copy.rfcId === d.rfcId && copyHash(copy) === d.copyHash && copy.headers['x-educateos-approval'] === d.approvedHash, 'Gmail copy differs from approved handoff; manual review required');
  return { draftId: result.id, messageId: result.message.id, threadId: result.message.threadId };
}
export async function createGmailDraft(store, input, api) {
  requireNetwork(input, 'createGmailDraft');
  let d = get(store.read(), 'googleDrafts', input.id); check(d.handoffId === input.handoffId && input.reviewedHash === d.hash, 'Specify exact approved handoff and hash');
  if (d.status === 'created') return d;
  check(d.status === 'approved', 'Draft outcome uncertain; reconcile before any manual retry');
  await authorized(api, d.sender);
  const intent = store.transaction(s => {
    const record = get(s, 'googleDrafts', input.id); check(record.status === 'approved', 'Intent already reserved');
    const p = previewGmail(s, { handoffId: record.handoffId }); check(p.hash === record.hash && input.reviewedHash === p.hash, 'Draft approval stale');
    record.status = 'uncertain'; record.attemptedAt = now(); audit(s, 'google.draft-intent-durable', record.id); return { record, raw: rfc2822(p) };
  });
  try {
    const result = await api.createDraft(intent.raw); const draftId = googleId(result.id);
    // Save the container ID before read-back: a crash still permits narrow reconciliation.
    store.transaction(s => { get(s, 'googleDrafts', input.id).draftId = draftId; });
    const ids = matchingDraft(await api.getDraft(draftId), intent.record);
    return store.transaction(s => { const r = get(s, 'googleDrafts', input.id); Object.assign(r, ids, { status: 'created', verifiedAt: now() }); audit(s, 'google.draft-created-not-sent', r.id); return r; });
  } catch { throw new Error('Gmail draft outcome uncertain; do not retry. Reconcile exact Message-ID/draft in Gmail.'); }
}
export async function reconcileDraft(store, input, api) {
  requireNetwork(input, 'readGoogle'); const d = get(store.read(), 'googleDrafts', input.id); await authorized(api, d.sender);
  const list = await api.findDrafts(d.rfcId); check(Array.isArray(list.drafts || []) && !list.nextPageToken && (list.drafts || []).length <= 20, 'Incomplete draft reconciliation');
  const drafts = list.drafts || []; check(drafts.length <= 1, 'Duplicate drafts require manual cleanup; lock retained');
  if (!drafts.length) return store.transaction(s => { const r = get(s, 'googleDrafts', d.id); r.emptySearchAt = now(); return { id: r.id, status: r.status, emptySearchAt: r.emptySearchAt, hash: hash(r), note: 'Absence is not proof of no write. Inspect Gmail manually before release.' }; });
  const ids = matchingDraft(await api.getDraft(googleId(drafts[0].id)), d);
  return store.transaction(s => { const r = get(s, 'googleDrafts', d.id); Object.assign(r, ids, { status: 'created', reconciledAt: now() }); audit(s, 'google.draft-reconciled', r.id); return r; });
}
export function releaseDraft(s, input) {
  const d = get(s, 'googleDrafts', input.id); const reviewer = human(input, hash(d));
  check(d.status === 'uncertain' && d.emptySearchAt && Date.now() - Date.parse(d.emptySearchAt) < 600_000 && input.noDraftInGmailConfirmed === true && input.duplicateRiskAcknowledged === true, 'Recent narrow reconciliation and manual Gmail inspection required');
  const p = previewGmail(s, { handoffId: d.handoffId }); check(p.hash === d.hash, 'Re-review changed handoff; no retry');
  d.status = 'approved'; delete d.draftId; audit(s, 'google.draft-lock-manually-released', d.id, reviewer); return d;
}
export async function reconcileSent(store, input, api) {
  requireNetwork(input, 'readGoogle'); const d = get(store.read(), 'googleDrafts', input.id); await authorized(api, d.sender);
  const list = await api.findSent(d.rfcId); check(Array.isArray(list.messages || []) && !list.nextPageToken && (list.messages || []).length <= 20, 'Incomplete SENT reconciliation');
  const matches = [];
  for (const hit of list.messages || []) {
    googleId(hit.id); const thread = await api.getThread(googleId(hit.threadId)); check(thread.id === hit.threadId && Array.isArray(thread.messages), 'Thread mismatch');
    const m = thread.messages.find(m => m.id === hit.id); check(m?.labelIds?.includes('SENT') && m.threadId === thread.id, 'Exact source message must carry SENT label');
    try { const copy = messageCopy(m); check(copy.rfcId === d.rfcId && copyHash(copy) === d.copyHash, 'Altered sent copy'); }
    catch {
      store.transaction(s => { const r = get(s, 'googleDrafts', d.id); r.sentReview = 'modified-or-unsupported-manual-review'; audit(s, 'google.sent-copy-noncompliant', r.id); });
      throw new Error('Sent copy or recipient differs from approval; no compliant send counted');
    }
    check(/^\d{10,16}$/.test(m.internalDate), 'Verified Gmail send time required');
    const at = new Date(Number(m.internalDate)).toISOString(); const h = get(store.read(), 'handoffs', d.handoffId);
    check(at >= h.at && Date.parse(at) <= Date.now() + 60_000, 'Invalid Gmail send time'); matches.push({ messageId: m.id, threadId: thread.id, at });
  }
  check(matches.length <= 1, 'Multiple actual sends require manual audit'); if (!matches.length) return { status: 'unconfirmed' };
  return store.transaction(s => {
    const r = get(s, 'googleDrafts', d.id); const hit = matches[0]; Object.assign(r, { sentMessageId: hit.messageId, threadId: hit.threadId, sentReview: 'exact-approved-copy' });
    let delivery = s.deliveries.find(x => x.handoffId === r.handoffId);
    if (!delivery) { delivery = { id: id(), handoffId: r.handoffId, approvalHash: r.approvedHash, at: hit.at, status: 'sent', reference: 'Gmail SENT exact-copy verification', source: 'gmail-sent', reviewer: 'Google API exact-copy verifier', recordedAt: now() }; s.deliveries.push(delivery); }
    audit(s, 'google.actual-sent-verified', r.id); return delivery;
  });
}
/** Read only the exact conversation established by a verified SENT source; never auto-import other senders. */
export async function readReplies(store, input, api) {
  requireNetwork(input, 'readGoogle'); const d = get(store.read(), 'googleDrafts', input.id);
  check(d.sentReview === 'exact-approved-copy' && d.threadId && d.sentMessageId, 'Verify actual SENT source first'); await authorized(api, d.sender);
  const thread = await api.getThread(d.threadId); check(thread.id === d.threadId && Array.isArray(thread.messages) && thread.messages.length <= 100, 'Invalid or oversized known thread');
  const source = thread.messages.find(m => m.id === d.sentMessageId);
  check(source?.labelIds?.includes('SENT') && copyHash(messageCopy(source)) === d.copyHash, 'SENT source changed');
  let added = 0; let quarantined = 0;
  for (const m of thread.messages) {
    googleId(m.id); check(m.threadId === d.threadId, 'Unexpected reply thread');
    if (m.id === d.sentMessageId || m.labelIds?.some(x => ['SENT', 'DRAFT'].includes(x))) continue;
    if (store.read().responses.some(r => r.externalId === `gmail-${m.id}`) || store.read().googleQuarantine.some(r => r.messageId === m.id)) continue;
    const contentHash = hash(m.payload); let excerpt; let receivedAt;
    try {
      const h = headers(m.payload); check(mailbox(h.from) === d.recipient && mailbox(h.to) === d.sender && !h.cc && !h.bcc, 'Unverified conversation participant');
      check((h['in-reply-to'] || '').includes(d.rfcId) || (h.references || '').split(/\s+/).includes(d.rfcId), 'Reply lacks exact source reference');
      check(/^\d{10,16}$/.test(m.internalDate) && Number(m.internalDate) >= Number(source.internalDate) && Number(m.internalDate) <= Date.now() + 60_000, 'Invalid reply date');
      receivedAt = new Date(Number(m.internalDate)).toISOString(); excerpt = replyText(plainText(m.payload));
    } catch {
      store.transaction(s => { s.googleQuarantine.push({ id: id(), candidateId: d.candidateId, messageId: m.id, threadId: d.threadId, contentHash, reason: 'unsupported-body-or-unverified-sender', at: now() }); }); quarantined++; continue;
    }
    store.transaction(s => {
      const c = get(s, 'candidates', d.candidateId);
      if (excerpt.optout) suppress(s, { address: c.email, reason: 'optout', operator: 'Known Gmail reply opt-out' });
      const r = { id: id(), externalId: `gmail-${m.id}`, candidateId: c.id, receivedAt, text: excerpt.text, suggestedState: 'ambiguous', sourceUrl: 'https://gmail.googleapis.com',
        state: excerpt.optout ? 'unsubscribed' : 'ambiguous', review: null, importedAt: now(), google: { messageId: m.id, threadId: d.threadId, contentHash, senderMatched: true } };
      s.responses.push(r); c.stage = excerpt.optout ? 'declined' : 'response';
      for (const o of s.outreach.filter(o => o.candidateId === c.id)) o.approval = null;
      audit(s, 'google.reply-excerpt-pending-review', r.id);
    }); added++;
  }
  return { added, quarantined };
}

export function acceptMeetingRequest(s, input) {
  const c = verified(s, input.candidateId); const r = get(s, 'responses', input.responseId);
  check(r.candidateId === c.id && r.state === 'interested' && r.review?.hash === responseHash(r) && ['council', 'demo', 'interview', 'technical-review'].includes(r.review.requestedScope), 'Reviewed explicit meeting scope required');
  check(!r.google || r.google.senderMatched === true, 'Unverified Gmail sender');
  check(input.meetingRequestedConfirmed === true && input.respondentVerifiedConfirmed === true, 'Independently verify respondent and explicit meeting request; role fit is insufficient');
  const expiresAt = validFuture(input.expiresAt); check(Date.parse(expiresAt) <= Date.now() + 30 * 86400_000, 'Request approval expires within 30 days');
  const basis = { candidateId: c.id, responseId: r.id, evidenceHash: responseHash(r), scope: r.review.requestedScope, expiresAt, note: staffText(input.note, 1000) };
  if (input.preview === true) return { ...basis, hash: hash(basis) };
  const reviewer = human(input, hash(basis)); check(!s.meetingRequests.some(x => x.responseId === r.id), 'Request already accepted');
  const request = { id: id(), ...basis, reviewer, at: now() }; s.meetingRequests.push(request); audit(s, 'google.explicit-meeting-request-accepted', request.id, reviewer); return request;
}
function validFuture(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'RFC3339 timestamp with explicit offset required');
  check(Date.parse(value) > Date.now(), 'Time must be future'); return new Date(value).toISOString();
}
export function validateSlot(input) {
  exact(input, ['start', 'end', 'timeZone'], 'slot (attendee fields forbidden)');
  const start = validFuture(input.start); const end = validFuture(input.end);
  check(Date.parse(start) < Date.now() + 90 * 86400_000 && Date.parse(end) - Date.parse(start) >= 15 * 60_000 && Date.parse(end) - Date.parse(start) <= 60 * 60_000, 'Use a 15–60 minute hold within 90 days');
  check(typeof input.timeZone === 'string' && input.timeZone.length <= 80 && /^(?:[A-Za-z_]+\/[-A-Za-z_/]+|UTC)$/.test(input.timeZone), 'IANA timezone required');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: input.timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { throw new Error('Invalid IANA timezone'); }
  const parts = v => Object.fromEntries(formatter.formatToParts(new Date(v)).map(x => [x.type, x.value])); const a = parts(start); const b = parts(end);
  check(!['Sat', 'Sun'].includes(a.weekday) && a.year === b.year && a.month === b.month && a.day === b.day && Number(a.hour) >= 9 && Number(b.hour) <= 17 && (Number(b.hour) < 17 || b.minute === '00'), 'Use weekday business hours 09:00–17:00 in chosen timezone');
  // Reject impossible/mismatched explicit wall-time offsets, including DST gaps.
  for (const value of [input.start, input.end]) if (!value.endsWith('Z')) {
    const p = parts(value); check(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === value.slice(0, 16), 'Timestamp offset does not match timezone/DST');
  }
  return { start, end, timeZone: input.timeZone };
}
function requestBasis(s, requestId) {
  const r = get(s, 'meetingRequests', requestId); const c = verified(s, r.candidateId); const response = get(s, 'responses', r.responseId);
  check(Date.parse(r.expiresAt) > Date.now() && response.state === 'interested' && response.review?.hash === responseHash(response) && responseHash(response) === r.evidenceHash && response.review.requestedScope === r.scope, 'Meeting request expired or consent changed');
  check(!s.responses.some(x => x.candidateId === c.id && x.receivedAt > response.receivedAt && (!x.review || ['declined', 'unsubscribed'].includes(x.state))), 'New reply requires review');
  return { request: r, candidateHash: candidateHash(c), suppression: false, sender: s.operatorConfigs[0]?.senderEmail };
}
export function proposeHold(s, input) {
  exact(input, ['requestId', 'slot', 'council', 'agenda', 'operator'], 'hold proposal (no attendees)');
  const basis = requestBasis(s, input.requestId); check(basis.sender, 'Configure operator sender'); const slot = validateSlot(input.slot);
  const council = oneOf(input.council, ['educator', 'technical'], 'advisory council');
  check(Array.isArray(input.agenda) && input.agenda.length >= 1 && input.agenda.length <= 10, 'Provide 1–10 agenda topics');
  const agenda = input.agenda.map(v => staffText(v, 300)); check(agenda.every(Boolean), 'Agenda topics required');
  check(!s.calendarHolds.some(h => h.requestId === input.requestId && h.status !== 'cancelled'), 'One hold per accepted request');
  const key = id(); const record = { id: key, candidateId: basis.request.candidateId, requestId: input.requestId, slot, council, agenda, eventId: `eos${hash(key)}`, status: 'proposed', approval: null, at: now() };
  s.calendarHolds.push(record); audit(s, 'google.internal-hold-proposed', key, safe(input.operator, 'operator', 120)); return previewHold(s, { id: key });
}
function eventFor(h) {
  return { id: h.eventId, summary: 'EducateOS internal advisory preparation hold', description: `INTERNAL HOLD ONLY. No invitation or participation confirmation.\n${h.council} advisory discussion\n${h.agenda.join('\n')}`,
    start: { dateTime: h.slot.start, timeZone: h.slot.timeZone }, end: { dateTime: h.slot.end, timeZone: h.slot.timeZone }, visibility: 'private', transparency: 'opaque' };
}
export function previewHold(s, input) {
  const h = get(s, 'calendarHolds', input.id); const basis = { id: h.id, ...requestBasis(s, h.requestId), slot: validateSlot(h.slot), council: h.council, agenda: h.agenda, event: eventFor(h) };
  return { ...basis, hash: hash(basis) };
}
export function approveHold(s, input) {
  const h = get(s, 'calendarHolds', input.id); check(h.status === 'proposed', 'Hold intent exists; reconcile');
  const p = previewHold(s, input); const reviewer = human(input, p.hash); check(input.internalNoAttendeesConfirmed === true, 'Confirm internal-only no-attendee hold');
  h.approval = { hash: p.hash, reviewer, at: now() }; audit(s, 'google.internal-hold-approved', h.id, reviewer); return h;
}
function matchingHold(event, h, sender) {
  check(event.id === h.eventId && event.status !== 'cancelled' && !event.attendees?.length && !event.conferenceData && event.visibility === 'private' && event.summary === eventFor(h).summary && event.description === eventFor(h).description && event.organizer?.email?.toLowerCase() === sender, 'Calendar hold differs from approved internal preview');
  check(Date.parse(event.start?.dateTime) === Date.parse(h.slot.start) && Date.parse(event.end?.dateTime) === Date.parse(h.slot.end) && event.start?.timeZone === h.slot.timeZone && event.end?.timeZone === h.slot.timeZone, 'Calendar hold time differs');
}
export async function createCalendarHold(store, input, api) {
  requireNetwork(input, 'createCalendarHold'); let h = get(store.read(), 'calendarHolds', input.id);
  check(input.reviewedHash === h.approval?.hash, 'Specify approved hold preview hash'); if (h.status === 'created') return h;
  check(h.status === 'proposed', 'Hold outcome uncertain; reconcile deterministic event ID, never retry insert');
  const p = previewHold(store.read(), input); check(p.hash === h.approval?.hash, 'Hold approval stale'); await authorized(api, p.sender);
  const busy = await api.freeBusy(h.slot); const calendar = busy.calendars?.primary;
  check(calendar && !calendar.errors?.length && Array.isArray(calendar.busy) && calendar.busy.length === 0 && Date.parse(busy.timeMin) === Date.parse(h.slot.start) && Date.parse(busy.timeMax) === Date.parse(h.slot.end), 'Availability unavailable or busy; no hold');
  const intent = store.transaction(s => { const record = get(s, 'calendarHolds', input.id); const current = previewHold(s, input); check(record.status === 'proposed' && current.hash === record.approval?.hash, 'Hold changed during availability check'); record.status = 'uncertain'; record.attemptedAt = now(); audit(s, 'google.hold-intent-durable', record.id); return { record, event: current.event, sender: current.sender }; });
  try {
    const event = await api.createHold(intent.event); matchingHold(event, intent.record, intent.sender);
    return store.transaction(s => { const record = get(s, 'calendarHolds', input.id); record.status = 'created'; record.verifiedAt = now(); audit(s, 'google.internal-hold-created-no-invite', record.id); return record; });
  } catch { throw new Error('Calendar outcome uncertain; reconcile deterministic event ID; never retry automatically'); }
}
export async function reconcileHold(store, input, api) {
  requireNetwork(input, 'readGoogle'); const s = store.read(); const h = get(s, 'calendarHolds', input.id); const sender = s.operatorConfigs[0]?.senderEmail;
  await authorized(api, sender); const event = await api.getHold(h.eventId); matchingHold(event, h, sender);
  return store.transaction(s => { const r = get(s, 'calendarHolds', h.id); r.status = 'created'; r.reconciledAt = now(); audit(s, 'google.internal-hold-reconciled', r.id); return r; });
}
/** Review meeting facts as a separate human disposition; an internal calendar hold proves no attendance. */
export function reviewMeeting(s, input) {
  const h = get(s, 'calendarHolds', input.holdId); check(h.status === 'created', 'Verified internal hold required');
  check(Date.parse(h.slot.end) <= Date.now(), 'Cannot verify a future meeting as occurred');
  check(input.meetingOccurredConfirmed === true && input.notesSanitizedConfirmed === true, 'Confirm meeting actually occurred and sanitize notes outside this tool');
  check(Array.isArray(input.actions) && input.actions.length <= 20, 'Bounded actions required');
  const basis = { holdId: h.id, council: h.council, agenda: h.agenda, notes: staffText(input.notes, 3000), actions: input.actions.map(a => ({ title: staffText(a.title, 500), owner: safe(a.owner, 'action owner', 120), dueAt: validFuture(a.dueAt) })),
    decision: oneOf(input.decision, ['accepted', 'deferred', 'declined'], 'feedback decision'), rationale: staffText(input.rationale, 1000), followUp: staffText(input.followUp, 500) };
  if (input.preview === true) return { ...basis, hash: hash(basis) }; const reviewer = human(input, hash(basis)); check(!h.meetingId, 'Meeting review already recorded');
  const m = createMeeting(s, { council: h.council, title: 'Reviewed advisory discussion', startsAt: h.slot.start, agenda: h.agenda.map(topic => ({ topic, facilitator: reviewer, minutes: 10 })) });
  m.notes = basis.notes; m.candidateId = h.candidateId; m.review = { hash: hash(basis), reviewer, at: now(), meetingOccurredConfirmed: true };
  basis.actions.forEach(a => addAction(s, { meetingId: m.id, ...a })); const f = addFeedback(s, { meetingId: m.id, summary: basis.notes, owner: reviewer });
  disposeFeedback(s, { id: f.id, disposition: basis.decision, rationale: basis.rationale, followUp: basis.followUp, operator: reviewer });
  h.meetingId = m.id; audit(s, 'google.meeting-disposition-human-verified', m.id, reviewer); return m;
}
export const googleMutations = Object.freeze({ 'google.preview': previewGmail, 'google.approve': approveGmail, 'google.release': releaseDraft,
  'meeting-request.accept': acceptMeetingRequest, 'calendar.propose': proposeHold, 'calendar.preview': previewHold, 'calendar.approve': approveHold, 'meeting.review': reviewMeeting });
