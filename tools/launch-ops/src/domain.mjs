import { audit } from './store.mjs';
import { check, digest, email, hash, human, id, noSensitive, now, oneOf, parseCsv, redact, sourceUrl, text, toCsv } from './safety.mjs';

export const COUNCILS = Object.freeze({
  educator: ['Classroom practice', 'Curriculum', 'Special education', 'Accessibility', 'School leadership', 'District operations', 'Professional learning', 'Community voice'],
  technical: ['Security', 'Privacy', 'Cloud infrastructure', 'Integrations', 'Accessibility engineering', 'Quality engineering'],
});
export const GATES = ['districtAgreement', 'dpa', 'security', 'technical', 'accessibility', 'syntheticTests', 'training', 'owner'];
export const TAGS = ['teaching', 'curriculum', 'special-education', 'accessibility', 'leadership', 'district-operations', 'training', 'community', 'security', 'privacy', 'cloud', 'integrations', 'testing'];
const FIT = {
  educator: ['teaching', 'curriculum', 'special-education', 'accessibility', 'leadership', 'district-operations', 'training', 'community'],
  technical: ['security', 'privacy', 'cloud', 'integrations', 'accessibility', 'testing'],
};
const find = (state, collection, key) => {
  const item = state[collection].find(x => x.id === key);
  check(item, `${collection} record not found`); return item;
};
const safe = (value, label, max) => noSensitive(text(value, label, max));
const council = value => oneOf(value, Object.keys(COUNCILS), 'council');
const date = value => { check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)), 'Use an ISO timestamp'); return new Date(value).toISOString(); };

export function importContacts(state, input) {
  check(input.publicProfessionalOnly === true && input.noStudentData === true, 'Attest public professional sources only and no student data');
  const operator = safe(input.operator, 'source reviewer', 120);
  const rows = input.csv !== undefined ? parseCsv(input.csv) : input.contacts;
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 500, 'Import 1–500 contacts');
  // Validate the complete batch before touching state; dedupe never overwrites reviewed metadata.
  const contacts = rows.map(r => ({
    name: safe(r.name, 'name', 120), email: email(r.email), organization: safe(r.organization, 'organization', 160),
    role: safe(r.role, 'professional role', 160), sourceUrl: sourceUrl(r.sourceUrl),
    tags: [...new Set((check(Array.isArray(r.tags), 'Tags must be an array'), r.tags).map(t => oneOf(t, TAGS, 'sourced role tag')))].sort(),
  }));
  let added = 0; let duplicates = 0;
  for (const c of contacts) {
    const duplicate = state.contacts.find(x => x.email === c.email ||
      (x.name.normalize('NFKC').toLowerCase() === c.name.normalize('NFKC').toLowerCase() && x.organization.normalize('NFKC').toLowerCase() === c.organization.normalize('NFKC').toLowerCase()));
    if (duplicate) { duplicates++; continue; }
    state.contacts.push({ id: id(), ...c, reviewedBy: operator, reviewedAt: now(), suppressed: false }); added++;
  }
  audit(state, 'contacts.imported', `${added} added; ${duplicates} duplicates`, operator);
  return { added, duplicates };
}
export function rankContacts(state, councilName) {
  council(councilName);
  return state.contacts.filter(c => !c.suppressed).map(c => {
    const matched = FIT[councilName].filter(t => c.tags.includes(t));
    return { ...c, score: matched.length * 10, reasons: matched.map(t => `Public professional role tag: ${t}`), basis: 'Advisory role fit only; no purchase intent or budget inference' };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function seatMember(state, input) {
  const name = council(input.council); const c = find(state, 'contacts', input.contactId);
  check(!c.suppressed, 'Contact is suppressed');
  check(Number.isInteger(input.seat) && input.seat >= 1 && input.seat <= COUNCILS[name].length, 'Invalid seat');
  check(input.acceptedByContact === true, 'Record an actual human-confirmed acceptance first');
  const operator = safe(input.operator, 'acceptance recorder', 120);
  const acceptanceNote = safe(input.acceptanceNote, 'acceptance evidence note', 2000);
  check(!state.memberships.some(m => m.council === name && (m.seat === input.seat || m.contactId === c.id)), 'Seat or council member already assigned');
  const member = { id: id(), council: name, seat: input.seat, contactId: c.id, acceptanceNote, operator, at: now() };
  state.memberships.push(member); audit(state, 'council.seat-assigned', member.id, operator); return member;
}
export function invitationContent(state, invitation) {
  const c = find(state, 'contacts', invitation.contactId);
  return { contact: { id: c.id, name: c.name, email: c.email, organization: c.organization, role: c.role, sourceUrl: c.sourceUrl, tags: c.tags, suppressed: c.suppressed }, council: invitation.council, subject: invitation.subject, body: invitation.body, provenance: invitation.provenance };
}
export const invitationHash = (state, invitation) => hash(invitationContent(state, invitation));
export function draftInvitation(state, input) {
  const c = find(state, 'contacts', input.contactId); const name = council(input.council);
  check(!c.suppressed, 'Contact is suppressed');
  const sender = safe(input.sender, 'sender name', 120);
  const invitation = {
    id: id(), contactId: c.id, council: name,
    subject: `Invitation to help shape EducateOS: ${name} advisory council`,
    body: `Hello ${c.name},\n\nYour public professional role as ${c.role} at ${c.organization} prompted this draft invitation (source: ${c.sourceUrl}).\n\nEducateOS is an open-source education platform whose core runs in an organization's own Cloudflare account. We are forming an ${name} advisory council with ${COUNCILS[name].length} seats to help shape priorities, review workflows, and identify risks. This is a request for advice, not a purchase request or a claim of an existing partnership.\n\nWould you be open to discussing whether participation fits your interests and availability? Meeting cadence, time commitment, and any compensation would be agreed with you; none is promised here. Participation does not authorize a school pilot or access to student information.\n\nWe are seeking feedback on an evolving project and make no claim of district approval, certifications, or proven outcomes. If this is not relevant, no reply is required.\n\n${sender}`,
    provenance: 'local-template-v1', approval: null, createdAt: now(),
  };
  state.invitations.push(invitation); audit(state, 'invitation.drafted', invitation.id); return { ...invitation, hash: invitationHash(state, invitation) };
}
export function reviseInvitation(state, input) {
  const invitation = find(state, 'invitations', input.id);
  invitation.subject = safe(input.subject, 'subject', 240);
  check(!/[\r\n]/.test(invitation.subject), 'Subject must be one line');
  invitation.body = safe(input.body, 'invitation body', 12_000);
  invitation.provenance = 'human-edited'; invitation.approval = null;
  audit(state, 'invitation.revised', invitation.id);
  return { ...invitation, hash: invitationHash(state, invitation) };
}
export function approveInvitation(state, input) {
  const invitation = find(state, 'invitations', input.id);
  check(!find(state, 'contacts', invitation.contactId).suppressed, 'Contact is suppressed');
  const h = invitationHash(state, invitation); const reviewer = human(input, h);
  check(input.truthfulLanguageConfirmed === true && input.publicSourceConfirmed === true, 'Confirm truthful claims and the public professional source');
  invitation.approval = { hash: h, reviewer, at: now(), truthfulLanguageConfirmed: true, publicSourceConfirmed: true };
  audit(state, 'invitation.approved', invitation.id, reviewer); return invitation.approval;
}
export function exportInvitations(state, input) {
  check(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 100 && new Set(input.ids).size === input.ids.length, 'Choose 1–100 distinct invitations');
  const records = input.ids.map(key => {
    const i = find(state, 'invitations', key); const content = invitationContent(state, i);
    check(!content.contact.suppressed, 'Contact is suppressed');
    check(i.approval?.hash === invitationHash(state, i) && i.approval?.reviewer, 'Every invitation needs human approval of its current hash');
    return { invitationId: i.id, ...content, approval: i.approval };
  });
  oneOf(input.format, ['json', 'csv'], 'export format');
  audit(state, 'invitation.exported', input.ids.join(','));
  return input.format === 'json' ? JSON.stringify({ kind: 'local-drafts-only', exportedAt: now(), records }, null, 2) :
    toCsv([['invitationId', 'name', 'email', 'organization', 'council', 'subject', 'body', 'sourceUrl', 'approvedHash', 'reviewer', 'approvedAt'], ...records.map(r => [r.invitationId, r.contact.name, r.contact.email, r.contact.organization, r.council, r.subject, r.body, r.contact.sourceUrl, r.approval.hash, r.approval.reviewer, r.approval.at])]);
}
export function suppressContact(state, input) {
  const c = find(state, 'contacts', input.id); c.suppressed = true;
  for (const i of state.invitations.filter(i => i.contactId === c.id)) i.approval = null;
  audit(state, 'contact.suppressed', c.id, safe(input.operator, 'operator', 120)); return { suppressed: true };
}

export function createMeeting(state, input) {
  const agenda = input.agenda;
  check(Array.isArray(agenda) && agenda.length > 0 && agenda.length <= 20, 'Supply 1–20 agenda items');
  const meeting = { id: id(), council: council(input.council), title: safe(input.title, 'meeting title', 200), startsAt: date(input.startsAt),
    agenda: agenda.map(a => ({ topic: safe(a.topic, 'topic', 300), facilitator: safe(a.facilitator, 'facilitator', 120), minutes: (check(Number.isInteger(a.minutes) && a.minutes >= 1 && a.minutes <= 180, 'Invalid agenda minutes'), a.minutes) })), actions: [] };
  state.meetings.push(meeting); audit(state, 'meeting.created', meeting.id); return meeting;
}
export function addAction(state, input) {
  const m = find(state, 'meetings', input.meetingId);
  const action = { id: id(), title: safe(input.title, 'action', 1000), owner: safe(input.owner, 'owner', 120), dueAt: date(input.dueAt), status: 'open', completion: null };
  m.actions.push(action); audit(state, 'meeting.action-added', action.id); return action;
}
export function closeAction(state, input) {
  const m = find(state, 'meetings', input.meetingId); const a = m.actions.find(a => a.id === input.id);
  check(a, 'Action not found'); a.completion = safe(input.completion, 'completion evidence', 2000); a.status = 'done';
  audit(state, 'meeting.action-completed', a.id, safe(input.operator, 'operator', 120)); return a;
}
export function addFeedback(state, input) {
  find(state, 'meetings', input.meetingId);
  const f = { id: id(), meetingId: input.meetingId, summary: safe(input.summary, 'feedback', 3000), disposition: 'pending', rationale: '', owner: safe(input.owner, 'feedback owner', 120) };
  state.feedback.push(f); audit(state, 'feedback.recorded', f.id); return f;
}
export function disposeFeedback(state, input) {
  const f = find(state, 'feedback', input.id);
  f.disposition = oneOf(input.disposition, ['accepted', 'deferred', 'declined'], 'feedback disposition');
  f.rationale = safe(input.rationale, 'disposition rationale', 3000);
  f.followUp = safe(input.followUp, 'follow-up or decision reference', 1000);
  audit(state, 'feedback.dispositioned', f.id, safe(input.operator, 'operator', 120)); return f;
}

export function createPilot(state, input) {
  check(input.syntheticOnly === true, 'This tool only manages synthetic pilot planning; never enter student data');
  const p = { id: id(), district: safe(input.district, 'district label', 200), scope: safe(input.scope, 'pilot scope', 3000), owner: safe(input.owner, 'accountable owner', 120), syntheticOnly: true, gates: {}, authorization: null, createdAt: now() };
  state.pilots.push(p); audit(state, 'pilot.created', p.id); return p;
}
export function revisePilot(state, input) {
  const p = find(state, 'pilots', input.id);
  p.scope = safe(input.scope, 'pilot scope', 3000); p.owner = safe(input.owner, 'accountable owner', 120);
  p.gates = {}; p.authorization = null;
  audit(state, 'pilot.scope-revised', p.id); return p;
}
export function addEvidence(state, input) {
  const p = find(state, 'pilots', input.pilotId); const gate = oneOf(input.gate, GATES, 'gate');
  const content = safe(input.content, 'sanitized textual evidence', 50_000);
  const evidence = { id: id(), pilotId: p.id, gate, title: safe(input.title, 'evidence title', 200), reference: safe(input.reference, 'document/version reference', 1000), content, sha256: digest(content), recordedAt: now() };
  state.evidence.push(evidence); delete p.gates[gate]; p.authorization = null;
  audit(state, 'pilot.evidence-recorded', evidence.id);
  return { ...evidence, content: undefined };
}
function gatePayload(state, p, gate, evidenceIds, validUntil) {
  check(Array.isArray(evidenceIds) && evidenceIds.length > 0 && new Set(evidenceIds).size === evidenceIds.length, 'Gate needs distinct evidence IDs');
  const evidence = evidenceIds.map(key => {
    const e = find(state, 'evidence', key);
    check(e.pilotId === p.id && e.gate === gate && digest(e.content) === e.sha256, 'Evidence mismatch or changed evidence');
    return { id: e.id, title: e.title, reference: e.reference, sha256: e.sha256 };
  });
  return { pilotId: p.id, district: p.district, scope: p.scope, owner: p.owner, syntheticOnly: p.syntheticOnly, gate, evidence, validUntil: date(validUntil) };
}
export function previewGate(state, input) {
  const p = find(state, 'pilots', input.pilotId); const gate = oneOf(input.gate, GATES, 'gate');
  const payload = gatePayload(state, p, gate, input.evidenceIds, input.validUntil);
  return { ...payload, hash: hash(payload) };
}
export function reviewGate(state, input) {
  const p = find(state, 'pilots', input.pilotId);
  const preview = previewGate(state, input); const { hash: h, ...payload } = preview;
  const reviewer = human(input, h);
  check(Date.parse(payload.validUntil) > Date.now(), 'Evidence review must not already be expired');
  check(input.authorizedReviewer === true, 'Reviewer must attest authority for this district gate');
  p.gates[input.gate] = { evidenceIds: input.evidenceIds, validUntil: payload.validUntil, hash: h, decision: oneOf(input.decision, ['approved', 'rejected'], 'gate decision'), reviewer, reviewedAt: now(), rationale: safe(input.rationale, 'evidence-based rationale', 3000) };
  p.authorization = null; audit(state, 'pilot.gate-reviewed', `${p.id}/${input.gate}`, reviewer); return p.gates[input.gate];
}
export function pilotReadiness(state, p) {
  const missing = GATES.filter(gate => {
    const r = p.gates[gate];
    if (!r || r.decision !== 'approved' || !r.reviewer || Date.parse(r.validUntil) <= Date.now()) return true;
    try { return r.hash !== hash(gatePayload(state, p, gate, r.evidenceIds, r.validUntil)); } catch { return true; }
  });
  const payload = { pilotId: p.id, district: p.district, scope: p.scope, owner: p.owner, syntheticOnly: p.syntheticOnly, gates: p.gates };
  const h = hash(payload);
  return { missing, ready: missing.length === 0, hash: h, authorized: missing.length === 0 && p.authorization?.hash === h, payload };
}
export function authorizePilot(state, input) {
  const p = find(state, 'pilots', input.id); const readiness = pilotReadiness(state, p);
  check(readiness.ready, `Pilot blocked: ${readiness.missing.join(', ')}`);
  const reviewer = human(input, readiness.hash);
  check(input.authorizedDistrictOwner === true, 'An authorized district owner must confirm authorization');
  p.authorization = { hash: readiness.hash, reviewer, at: now(), note: safe(input.note, 'authorization rationale', 2000) };
  audit(state, 'pilot.authorized', p.id, reviewer); return p.authorization;
}
export function revokePilot(state, input) {
  const p = find(state, 'pilots', input.id); p.authorization = null;
  audit(state, 'pilot.revoked', p.id, safe(input.operator, 'operator', 120)); return { revoked: true };
}
export function exportPilot(state, input) {
  const p = find(state, 'pilots', input.id); const readiness = pilotReadiness(state, p);
  check(readiness.authorized, 'Pilot export requires current evidence-backed district authorization');
  audit(state, 'pilot.exported', p.id);
  return JSON.stringify({ kind: 'synthetic-pilot-planning-only', ...readiness.payload, authorization: p.authorization }, null, 2);
}

export function createTicket(state, input) {
  const title = redact(input.title); const detail = redact(input.detail);
  // Routing uses explicit categories; embedded instructions and keywords cannot reroute a ticket.
  const category = oneOf(input.category, ['privacy', 'security', 'accessibility', 'technical', 'training', 'general'], 'support category');
  const routes = { privacy: 'Privacy lead', security: 'Security lead', accessibility: 'Accessibility lead', technical: 'Technical owner', training: 'Training lead', general: 'Operations owner' };
  const ticket = { id: id(), title, detail, category, route: routes[category], priority: ['privacy', 'security'].includes(category) ? 'urgent' : 'normal', status: 'needs-redaction-review', approval: null, resolution: null, createdAt: now() };
  state.tickets.push(ticket); audit(state, 'support.routed', ticket.id); return ticket;
}
export const ticketHash = ticket => hash({ id: ticket.id, title: ticket.title, detail: ticket.detail, category: ticket.category, route: ticket.route, priority: ticket.priority, resolution: ticket.resolution });
export function reviseTicket(state, input) {
  const ticket = find(state, 'tickets', input.id);
  ticket.title = redact(input.title); ticket.detail = redact(input.detail); ticket.approval = null; ticket.status = 'needs-redaction-review';
  audit(state, 'support.redaction-revised', ticket.id); return { ...ticket, hash: ticketHash(ticket) };
}
export function reviewTicket(state, input) {
  const ticket = find(state, 'tickets', input.id); const h = ticketHash(ticket); const reviewer = human(input, h);
  check(input.noPersonalDataConfirmed === true, 'Manually confirm all personal data and secrets are removed');
  ticket.approval = { hash: h, reviewer, at: now() }; ticket.status = ticket.resolution ? 'resolved' : 'triaged';
  audit(state, 'support.redaction-reviewed', ticket.id, reviewer); return ticket.approval;
}
export function resolveTicket(state, input) {
  const ticket = find(state, 'tickets', input.id);
  check(ticket.approval?.hash === ticketHash(ticket), 'Review redaction before resolving');
  ticket.resolution = redact(input.resolution); ticket.status = 'needs-redaction-review'; ticket.approval = null;
  audit(state, 'support.resolved', ticket.id, safe(input.operator, 'operator', 120)); return ticket;
}
export function exportTicket(state, input) {
  const ticket = find(state, 'tickets', input.id);
  check(ticket.approval?.hash === ticketHash(ticket), 'Review the current redacted ticket before export');
  audit(state, 'support.exported', ticket.id); return JSON.stringify(ticket, null, 2);
}
export function snapshot(state) {
  return { ...state, evidence: state.evidence.map(({ content: _content, ...e }) => e),
    invitations: state.invitations.map(i => ({ ...i, hash: invitationHash(state, i), approved: i.approval?.hash === invitationHash(state, i) && !find(state, 'contacts', i.contactId).suppressed })),
    pilots: state.pilots.map(p => ({ ...p, readiness: pilotReadiness(state, p) })),
    tickets: state.tickets.map(t => ({ ...t, hash: ticketHash(t) })), councils: COUNCILS, gateNames: GATES, tags: TAGS };
}
export const mutations = {
  'contacts.import': importContacts, 'contacts.suppress': suppressContact, 'councils.seat': seatMember,
  'invitations.draft': draftInvitation, 'invitations.revise': reviseInvitation, 'invitations.approve': approveInvitation,
  'meetings.create': createMeeting, 'meetings.action': addAction, 'meetings.complete': closeAction,
  'feedback.add': addFeedback, 'feedback.dispose': disposeFeedback,
  'pilots.create': createPilot, 'pilots.revise': revisePilot, 'evidence.add': addEvidence, 'gates.review': reviewGate,
  'pilots.authorize': authorizePilot, 'pilots.revoke': revokePilot,
  'tickets.create': createTicket, 'tickets.revise': reviseTicket, 'tickets.review': reviewTicket, 'tickets.resolve': resolveTicket,
};
