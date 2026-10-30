'use strict';
// Untrusted contact, evidence, and model text is rendered only as text, never HTML.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let state; let active = 'councils';
const workspace = document.querySelector('#workspace');
const review = document.querySelector('#review');
const output = document.querySelector('#output');
const status = document.querySelector('#status');
function node(tag, content, className) {
  const e = document.createElement(tag);
  if (content !== undefined) e.textContent = content;
  if (className) e.className = className;
  return e;
}
function show(value) { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); review.replaceChildren(); }
function error(e) { status.textContent = e.message; status.className = 'error'; }
async function api(action, data = {}) {
  const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Launch-Ops-Token': token }, body: JSON.stringify({ action, data }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value.result;
}
async function refresh() {
  const response = await fetch('/api/state', { headers: { 'X-Launch-Ops-Token': token } });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); state = value; render();
}
async function mutate(action, data) {
  const value = await api(action, data); show(value); await refresh(); status.textContent = 'Saved locally.'; status.className = ''; return value;
}
function button(label, callback, parent) {
  const b = node('button', label); b.type = 'button';
  b.addEventListener('click', async () => { b.disabled = true; try { await callback(); } catch (e) { error(e); } finally { b.disabled = false; } });
  parent.append(b); return b;
}
function options(records, label) { return records.map(r => [r.id, label(r)]); }
function field(name, label, type = 'text', value = '', choices = []) { return { name, label, type, value, choices }; }
const f = field;
function form(title, fields, submit, parent = workspace, submitLabel = 'Save locally') {
  const el = node('form'); el.append(node('h3', title)); const controls = {};
  for (const spec of fields) {
    const label = node('label'); const control = node(spec.type === 'textarea' ? 'textarea' : spec.type === 'select' ? 'select' : 'input');
    if (control.tagName === 'INPUT') control.type = spec.type;
    if (spec.type === 'select') for (const [value, title] of spec.choices) { const o = node('option', title); o.value = value; control.append(o); }
    if (spec.type === 'checkbox') { control.checked = spec.value === true; label.append(control, document.createTextNode(spec.label)); }
    else { control.value = spec.value; label.append(document.createTextNode(spec.label), control); }
    control.required = true; if (spec.type === 'file') control.accept = '.csv,text/csv';
    controls[spec.name] = control; el.append(label);
  }
  const save = node('button', submitLabel); save.type = 'submit'; el.append(save);
  el.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    try {
      const data = {};
      for (const spec of fields) { const c = controls[spec.name]; data[spec.name] = spec.type === 'checkbox' ? c.checked : spec.type === 'number' ? Number(c.value) : spec.type === 'file' ? await c.files[0].text() : c.value; }
      await submit(data);
    } catch (e) { error(e); } finally { save.disabled = false; }
  });
  parent.append(el); return el;
}
const councilField = () => f('council', 'Council', 'select', 'educator', [['educator', 'Educator (8 seats)'], ['technical', 'Technical (6 seats)']]);
const operatorField = () => f('operator', 'Your name (local attestation)');
const humanFields = () => [f('reviewer', 'Your name (human reviewer)'), f('humanReviewed', 'I personally reviewed the exact content and hash shown above', 'checkbox')];
function card(title, description, parent = workspace) {
  const el = node('article'); el.append(node('h3', title)); if (description) el.append(node('p', description, 'muted')); parent.append(el); return el;
}
function contactLabel(c) { return `${c.name} · ${c.role} · ${c.organization}${c.suppressed ? ' · SUPPRESSED' : ''}`; }
function renderCouncils() {
  const grid = node('div', undefined, 'grid'); workspace.append(grid);
  for (const [council, seats] of Object.entries(state.councils)) {
    const el = card(`${council} advisory council`, 'Seat labels guide a balanced council; ranking is explainable role fit only.', grid);
    seats.forEach((seat, index) => { const member = state.memberships.find(m => m.council === council && m.seat === index + 1); const c = state.contacts.find(c => c.id === member?.contactId); el.append(node('div', `${index + 1}. ${seat} — ${c ? c.name : 'Open'}`, 'seat')); });
    button('Rank by role fit', async () => show(await api('contacts.rank', { council })), el);
  }
  form('Import public professional contacts', [f('csv', 'CSV file (name,email,organization,role,sourceUrl,tags)', 'file'), operatorField(), f('publicProfessionalOnly', 'I verified these addresses and role tags against public professional sources', 'checkbox'), f('noStudentData', 'No student data or private personal contacts are included', 'checkbox')], data => mutate('contacts.import', data), workspace, 'Import & dedupe locally');
  form('Record an accepted council seat', [councilField(), f('seat', 'Seat number (1–8 educator, 1–6 technical)', 'number', '1'), f('contactId', 'Contact', 'select', '', options(state.contacts.filter(c => !c.suppressed), contactLabel)), operatorField(), f('acceptanceNote', 'Evidence of actual acceptance (date and reference; no private message body)', 'textarea'), f('acceptedByContact', 'The contact actually accepted; this does not send an invitation', 'checkbox')], data => mutate('councils.seat', data));
  for (const c of state.contacts) {
    const el = card(c.name, `${c.role} · ${c.organization} · ${c.email} · ${c.sourceUrl} · ${c.tags.join(', ')}${c.suppressed ? ' · SUPPRESSED' : ''}`);
    if (!c.suppressed) button('Suppress future drafts & exports', () => {
      show(c); form('Confirm local suppression', [operatorField()], data => mutate('contacts.suppress', { id: c.id, ...data }), review, 'Suppress');
    }, el);
  }
}
function renderInvitations() {
  form('Create a personalized draft', [f('contactId', 'Public professional contact', 'select', '', options(state.contacts.filter(c => !c.suppressed), contactLabel)), councilField(), f('sender', 'Sender name for the draft signature')], data => mutate('invitations.draft', data), workspace, 'Draft locally');
  for (const i of state.invitations) {
    const c = state.contacts.find(c => c.id === i.contactId);
    const el = card(`${c.name} · ${i.council}`, i.approved ? `Approved by ${i.approval.reviewer} for current hash` : 'Human approval required');
    button('Read / edit / approve', async () => {
      show({ recipient: c, council: i.council, subject: i.subject, body: i.body, provenance: i.provenance, hash: i.hash });
      form('Edit draft (invalidates approval)', [f('subject', 'Subject', 'text', i.subject), f('body', 'Invitation text', 'textarea', i.body)], data => mutate('invitations.revise', { id: i.id, ...data }), review);
      form('Approve exact draft and recipient', [...humanFields(), f('truthfulLanguageConfirmed', 'Claims are truthful; no unverified outcomes, certifications, commitments or partnerships', 'checkbox'), f('publicSourceConfirmed', 'I verified the professional source and recipient details', 'checkbox')], data => mutate('invitations.approve', { id: i.id, reviewedHash: i.hash, ...data }), review, 'Record human approval');
    }, el);
    if (i.approved) {
      button('Export approved JSON locally', () => mutate('invitations.export', { ids: [i.id], format: 'json' }), el);
      button('Export approved CSV locally', () => mutate('invitations.export', { ids: [i.id], format: 'csv' }), el);
    }
  }
}
function renderMeetings() {
  form('Create a council meeting', [councilField(), f('title', 'Meeting title'), f('startsAt', 'Start (ISO timestamp)', 'text', new Date().toISOString()), f('agenda', 'Agenda JSON: [{"topic":"Review workflows","facilitator":"Owner","minutes":20}]', 'textarea', '[{"topic":"Review workflows and risks","facilitator":"Council facilitator","minutes":20}]')], data => mutate('meetings.create', { ...data, agenda: JSON.parse(data.agenda) }));
  for (const m of state.meetings) {
    const el = card(m.title, `${m.council} · ${m.startsAt}`);
    m.agenda.forEach(a => el.append(node('p', `${a.minutes} min · ${a.topic} · ${a.facilitator}`)));
    form('Assign an action', [f('title', 'Action'), f('owner', 'Accountable owner'), f('dueAt', 'Due (ISO timestamp)')], data => mutate('meetings.action', { meetingId: m.id, ...data }), el);
    m.actions.forEach(a => { const item = card(a.title, `${a.status} · ${a.owner} · ${a.dueAt}`, el); if (a.status === 'open') form('Complete action', [f('completion', 'Completion evidence/reference', 'textarea'), operatorField()], data => mutate('meetings.complete', { meetingId: m.id, id: a.id, ...data }), item); });
    form('Record feedback', [f('summary', 'Feedback (no personal/student data)', 'textarea'), f('owner', 'Disposition owner')], data => mutate('feedback.add', { meetingId: m.id, ...data }), el);
    state.feedback.filter(x => x.meetingId === m.id).forEach(x => {
      const item = card(x.summary, `${x.disposition} · ${x.owner} · ${x.rationale} · ${x.followUp || ''}`, el);
      form('Record disposition', [f('disposition', 'Decision', 'select', 'accepted', [['accepted', 'Accepted'], ['deferred', 'Deferred'], ['declined', 'Declined']]), f('rationale', 'Why (include evidence)', 'textarea'), f('followUp', 'Follow-up action / issue / decision reference'), operatorField()], data => mutate('feedback.dispose', { id: x.id, ...data }), item);
    });
  }
}
function renderPilots() {
  workspace.append(node('p', 'Planning records do not grant access or deploy anything. All eight gates need current human-reviewed evidence, then an authorized district owner must approve the exact scope. Evidence review is a human judgment; the tool cannot verify signatures or reviewer authority.'));
  form('Plan a synthetic pilot', [f('district', 'District planning label'), f('scope', 'Exact synthetic pilot scope', 'textarea'), f('owner', 'Accountable district owner'), f('syntheticOnly', 'Synthetic data only; no real student information', 'checkbox')], data => mutate('pilots.create', data));
  for (const p of state.pilots) {
    const el = card(p.district, `${p.readiness.authorized ? 'AUTHORIZED planning record' : 'BLOCKED / authorization required'} · ${p.owner} · ${p.scope}`);
    el.append(node('p', `Missing, expired, or invalid gates: ${p.readiness.missing.join(', ') || 'None'}`));
    button('Revise scope / owner (clears all reviews)', () => {
      show(p); form('Revise pilot', [f('scope', 'Scope', 'textarea', p.scope), f('owner', 'Owner', 'text', p.owner)], data => mutate('pilots.revise', { id: p.id, ...data }), review);
    }, el);
    for (const gate of state.gateNames) {
      const gateEl = card(gate, p.gates[gate] ? `${p.gates[gate].decision} · ${p.gates[gate].reviewer} · expires ${p.gates[gate].validUntil}` : 'No review', el);
      const evidence = state.evidence.filter(e => e.pilotId === p.id && e.gate === gate);
      for (const e of evidence) button(`Read evidence: ${e.title}`, async () => show(await api('evidence.read', { id: e.id })), gateEl);
      form('Record sanitized evidence', [f('title', 'Evidence title'), f('reference', 'Document/version reference'), f('content', 'Sanitized evidence text (no signatures, student data, credentials)', 'textarea')], data => mutate('evidence.add', { pilotId: p.id, gate, ...data }), gateEl, 'Save evidence locally');
      if (evidence.length) form('Prepare evidence review', [f('validUntil', 'Review expires (ISO timestamp)')], async data => {
        const input = { pilotId: p.id, gate, evidenceIds: evidence.map(e => e.id), ...data };
        const preview = await api('gates.preview', input);
        const documents = await Promise.all(evidence.map(e => api('evidence.read', { id: e.id })));
        show({ review: preview, documents });
        form(`Human decision: ${gate}`, [...humanFields(), f('authorizedReviewer', 'I am authorized to review this district gate and have checked the evidence', 'checkbox'), f('decision', 'Evidence decision', 'select', 'rejected', [['rejected', 'Rejected / incomplete'], ['approved', 'Approved']]), f('rationale', 'Evidence-based rationale', 'textarea')], decision => mutate('gates.review', { ...input, ...decision, reviewedHash: preview.hash }), review, 'Record gate decision');
      }, gateEl, 'Read exact evidence and hash');
    }
    if (p.readiness.ready) button('Review district-owner authorization', () => {
      show(p.readiness);
      form('District-owner authorization', [...humanFields(), f('authorizedDistrictOwner', 'I am authorized by this district to approve this exact synthetic pilot scope', 'checkbox'), f('note', 'Authorization rationale / agreement reference', 'textarea')], data => mutate('pilots.authorize', { id: p.id, reviewedHash: p.readiness.hash, ...data }), review, 'Record district authorization');
    }, el);
    if (p.readiness.authorized) button('Export authorized planning record locally', () => mutate('pilots.export', { id: p.id }), el);
    button('Revoke local pilot authorization', () => { show(p); form('Confirm revocation', [operatorField()], data => mutate('pilots.revoke', { id: p.id, ...data }), review, 'Revoke'); }, el);
  }
}
function renderSupport() {
  workspace.append(node('p', 'Remove student information before entry. Common emails, URLs, phone numbers, IDs and secrets are redacted before storage. Heuristics can miss names or unusual identifiers: manually sanitize the stored text and confirm it before export. Routes are local queues; no external ticket or message is created.'));
  form('Route a support ticket locally', [f('title', 'Sanitized title'), f('detail', 'Sanitized issue (never paste student records)', 'textarea'), f('category', 'Route category (explicit selection)', 'select', 'general', ['privacy', 'security', 'accessibility', 'technical', 'training', 'general'].map(x => [x, x]))], data => mutate('tickets.create', data));
  for (const t of state.tickets) {
    const el = card(t.title, `${t.route} · ${t.priority} · ${t.status}`);
    button('Read / sanitize / review', () => {
      show(t);
      form('Manually sanitize text', [f('title', 'Title', 'text', t.title), f('detail', 'Redacted detail', 'textarea', t.detail)], data => mutate('tickets.revise', { id: t.id, ...data }), review);
      form('Confirm redaction', [...humanFields(), f('noPersonalDataConfirmed', 'All personal data, student information, and secrets have been removed', 'checkbox')], data => mutate('tickets.review', { id: t.id, reviewedHash: t.hash, ...data }), review, 'Record redaction review');
    }, el);
    if (t.approval?.hash === t.hash) {
      button('Export reviewed ticket locally', () => mutate('tickets.export', { id: t.id }), el);
      if (t.status !== 'resolved') form('Resolve locally', [f('resolution', 'Sanitized resolution (no personal data)', 'textarea'), operatorField()], data => mutate('tickets.resolve', { id: t.id, ...data }), el);
    }
  }
}
function render() {
  workspace.replaceChildren();
  document.querySelectorAll('[data-tab]').forEach(b => { if (b.dataset.tab === active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  ({ councils: renderCouncils, invitations: renderInvitations, meetings: renderMeetings, pilots: renderPilots, support: renderSupport, audit: () => { const el = node('pre', JSON.stringify(state.audit, null, 2)); workspace.append(el); } })[active]();
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { active = b.dataset.tab; review.replaceChildren(); output.textContent = ''; render(); }));
if (!/^[a-f0-9]{64}$/.test(token)) error(new Error('Open the full local URL printed by the CLI, including its session fragment. Restart the CLI if needed.'));
else refresh().catch(error);
