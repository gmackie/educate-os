'use strict';
// Untrusted contact, evidence, and model text is rendered only as text, never HTML.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let state; let active = 'pipeline';
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
    control.required = spec.required !== false; if (spec.type === 'file') control.accept = '.csv,.json,text/csv,application/json';
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
  ({ pipeline: renderPipeline, sourcing: renderSourcing, campaigns: renderCampaigns, inbound: renderInbound, metrics: renderMetrics, councils: renderCouncils, invitations: renderInvitations, meetings: renderMeetings, pilots: renderPilots, support: renderSupport, audit: () => { const el = node('pre', JSON.stringify(state.audit, null, 2)); workspace.append(el); } })[active]();
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { active = b.dataset.tab; review.replaceChildren(); output.textContent = ''; render(); }));
if (!/^[a-f0-9]{64}$/.test(token)) error(new Error('Open the full local URL printed by the CLI, including its session fragment. Restart the CLI if needed.'));
else refresh().catch(error);

function jsonImport(title, action, fieldName = null) {
  form(title, [f('file', 'Private JSON file (see tools/launch-ops/examples)', 'file'), operatorField()], data => {
    const value = JSON.parse(data.file);
    return mutate(action, fieldName ? { [fieldName]: value, operator: data.operator } : { ...value, operator: data.operator });
  });
}
function renderPipeline() {
  workspace.append(node('h2', 'Daily local workflow'), node('p', 'Public role fit is not interest. Interest is not technical readiness. All decisions below are explicit human actions; this dashboard cannot send messages.'));
  form('Build daily review queues', [operatorField(), f('approvedLocalSources', 'I have approved the locally imported sources for this workflow', 'checkbox')], data => mutate('daily.run', data), workspace, 'Build queues (safe to repeat)');
  jsonImport('Optional approved daily import bundle', 'daily.run');
  const latest = state.runs.at(-1);
  if (latest) card(`Review queues · ${latest.day}`, JSON.stringify(latest.queues, null, 2));
  card('Stage flow', 'discovered → verified → selected → draft → approval → exported (unsent) → response → interview / council / pilot, or declined');
  for (const c of state.candidates) {
    const org = state.organizations.find(o => o.id === c.organizationId);
    card(`${c.name} · ${c.stage}`, `${org?.name} · public role segment: ${c.persona} · ${c.sourceKind === 'staff-optin' ? 'explicit staff request (scope shown in record)' : 'no expressed interest inferred'}`);
  }
}
function renderSourcing() {
  workspace.append(node('h2', 'Approved sources and quarantined discoveries'), node('p', state.sourceCatalog.policy));
  button('Read source catalog and attribution', () => show(state.sourceCatalog), workspace);
  jsonImport('Import organization registry with provenance', 'registry.import');
  jsonImport('Quarantine institutional candidate fixtures', 'candidates.import');
  for (const o of state.organizations) {
    const el = card(o.name, `${o.state} · ${o.kind} · ${o.ncesId || 'no NCES identifier'} · ${o.website}`);
    const imports = state.sourceImports.filter(x => o.importIds.includes(x.id));
    el.append(node('p', imports.map(x => `${x.sourceId} · observed ${x.observedAt} · ${x.attribution}`).join('\n')));
    button('Review exact official domain approval', async () => {
      const input = { organizationId: o.id, origin: new URL(o.website).origin };
      const preview = await api('domains.approve', { ...input, preview: true }); show(preview);
      form('Approve institutional source domain', [...humanFields(), f('officialDomainConfirmed', 'I verified this is the official institution domain', 'checkbox'), f('noMemberLists', 'No login, student, social or association member-list scraping', 'checkbox')], data => mutate('domains.approve', { ...input, ...data, reviewedHash: preview.hash }), review);
    }, el);
  }
  for (const c of state.candidates) {
    const el = card(`${c.name} · ${c.stage}`, `${c.role} · ${c.email} · ${c.persona} (public role fit only)`);
    button('Read evidence and exact verification hash', () => {
      show(c);
      if (c.stage === 'discovered') form('Human verification', [...humanFields(), f('publicProfessionalConfirmed', 'I checked the explicitly published institutional identity, title and exact address', 'checkbox'), f('accurateEvidenceConfirmed', 'The provenance and evidence accurately match the official source', 'checkbox'), f('noStudentData', 'Staff only; no student information', 'checkbox')], data => mutate('candidates.verify', { id: c.id, reviewedHash: c.hash, ...data }), review);
    }, el);
    if (c.stage === 'verified') form('Select initial organization contact', [operatorField()], data => mutate('candidates.select', { id: c.id, ...data }), el, 'Select (one per organization)');
    form('Suppress further outreach', [f('reason', 'Reason', 'select', 'operator-hold', ['operator-hold', 'optout', 'declined', 'bounce'].map(x => [x, x])), { ...f('organizationWide', 'Also suppress entire organization', 'checkbox'), required: false }, operatorField()], data => mutate('candidates.suppress', { id: c.id, ...data }), el);
    button('Review personal-data erasure', async () => {
      const preview = await api('privacy.erase', { address: c.email, preview: true }); show(preview);
      form('Verified erasure (retains suppression; purges all local exports)', [...humanFields(), f('deletionAuthorityConfirmed', 'I verified deletion authority and will handle copies and backups', 'checkbox')], data => mutate('privacy.erase', { address: c.email, reviewedHash: preview.hash, ...data }), review, 'Erase and retain suppression');
    }, el);
  }
}
function renderCampaigns() {
  workspace.append(node('h2', 'Campaign drafts and human approvals'), node('p', 'We are exploring a foundation model with an open source and district-owned design. No incorporation, tax exemption, signed Clever agreement, certifications, participating districts or partner endorsement is established here.'));
  jsonImport('Configure compliant sender and caps', 'sender.configure');
  if (state.operatorConfigs[0]) card('Current sender / caps', JSON.stringify(state.operatorConfigs[0], null, 2));
  form('Create campaign', [f('kind', 'Purpose (regional referral is a primary channel)', 'select', 'regional-referral', Object.entries(state.campaignKinds).map(([key, value]) => [key, value.title])), f('context', 'Truthful context grounded in verified evidence', 'textarea'), operatorField()], data => mutate('campaigns.create', data));
  const selected = state.candidates.filter(c => c.stage === 'selected');
  if (selected.length && state.campaigns.some(c => c.active)) form('Prepare selected staff draft', [f('candidateId', 'Selected initial contact', 'select', selected[0].id, options(selected, x => `${x.name} · ${x.persona}`)), f('campaignId', 'Campaign', 'select', state.campaigns[0].id, options(state.campaigns.filter(c => c.active), x => state.campaignKinds[x.kind].title)), operatorField()], data => mutate('outreach.draft', data));
  for (const c of state.campaigns) {
    const el = card(state.campaignKinds[c.kind].title, `${c.active ? 'Active' : 'Paused'} · revision ${c.revision} · ${c.context}`);
    form('Revise campaign (invalidates approvals)', [f('context', 'Campaign context', 'textarea', c.context), { ...f('active', 'Active campaign', 'checkbox', c.active), required: false }, operatorField()], data => mutate('campaigns.revise', { id: c.id, ...data }), el);
  }
  for (const o of state.outreach) {
    const c = state.candidates.find(c => c.id === o.candidateId);
    const el = card(o.subject, `${c?.email} · ${o.exportedAt ? 'EXPORTED / sending unknown' : o.approved ? 'APPROVED' : 'NEEDS HUMAN REVIEW'}`);
    button('Read exact recipient, evidence, text and hash', () => {
      show({ draft: o, candidate: c, campaign: state.campaigns.find(x => x.id === o.campaignId), sender: state.operatorConfigs[0] });
      if (!o.exportedAt) {
        form('Revise draft (invalidates approval)', [f('subject', 'Subject', 'text', o.subject), f('body', 'Body with sender, postal address and opt-out', 'textarea', o.body), operatorField()], data => mutate('outreach.revise', { id: o.id, ...data }), review);
        form('Approve exact draft', [...humanFields(), f('truthfulClaimsConfirmed', 'Claims are truthful; no inferred relationship or readiness', 'checkbox'), f('sourceAndRecipientConfirmed', 'Exact recipient and source evidence verified', 'checkbox'), f('complianceConfirmed', 'Correct sender, valid physical address, monitored free opt-out and B2B compliance reviewed', 'checkbox')], data => mutate('outreach.approve', { items: [{ id: o.id, reviewedHash: o.hash }], ...data }), review, 'Record explicit human approval');
      }
    }, el);
    if (o.approved) form('Local approved draft handoff', [f('format', 'Format', 'select', 'eml', ['eml', 'csv', 'json'].map(x => [x, x]))], data => mutate('outreach.export', { ids: [o.id], ...data }), el, 'Export unsent draft');
    if (o.exportedAt && !o.followUpOf) form('Prepare sole follow-up (waiting interval enforced)', [operatorField()], data => mutate('outreach.draft', { candidateId: o.candidateId, campaignId: o.campaignId, followUpOf: o.id, ...data }), el);
  }
  jsonImport('Explicit batch approval (IDs + reviewed hashes; never automatic)', 'outreach.approve');
}
function renderInbound() {
  workspace.append(node('h2', 'Staff interest and reply review'), node('p', state.privacyNotice));
  jsonImport('Import manually exported website-interest v1', 'interest.import', 'envelope');
  jsonImport('Import simulated CSV/JSON replies', 'responses.import');
  const optionalCheckbox = (name, label) => ({ ...f(name, label, 'checkbox'), required: false });
  form('Synthetic staff opt-in form (.invalid only)', [f('externalId', 'Unique fictional event ID'), f('name', 'Fictional staff name'), f('workEmail', 'Fictional work address (.invalid)'), f('org', 'Registry organization name'), f('state', 'State', 'select', 'MI', [['MI', 'MI'], ['TX', 'TX'], ['other', 'other']]), f('role', 'Professional role'), f('interestType', 'Explicit requested scope', 'select', 'demo', ['demo', 'council', 'technical-review', 'pilot', 'feedback', 'webinar'].map(x => [x, x])), f('limitedFeedback', 'Staff-only feedback (no students, secrets, contacts or URLs)', 'textarea'), f('staffConfirmed', 'I am staff and this is synthetic test information', 'checkbox'), f('privacyAcknowledged', 'I read and accept the local privacy notice above', 'checkbox'), f('responseConsent', 'I permit a one-time response about this specific request', 'checkbox'), optionalCheckbox('marketingOptIn', 'Optional: I separately opt in to future updates'), operatorField()], data => {
    const { operator, ...record } = data;
    Object.assign(record, { receivedAt: new Date().toISOString(), verificationStatus: 'unverified', consentVersion: 'staff-local-v1', referralSource: 'local-test' });
    return mutate('staff.submit', { record, operator, syntheticLocalTest: true, noticeVersion: 'staff-local-v1' });
  });
  for (const feedback of state.staffFeedback) {
    const el = card(`${feedback.record.name} · ${feedback.record.interestType}`, `${feedback.status} · response permission ${feedback.record.responseConsent} · marketing opt-in ${feedback.record.marketingOptIn} · ${feedback.record.limitedFeedback}`);
    button('Review staff identity and immutable consent', () => {
      show(feedback);
      if (!feedback.review && state.organizations.length) form('Verify staff request against registry', [...humanFields(), f('organizationId', 'Verified organization', 'select', state.organizations[0].id, options(state.organizations, x => x.name)), f('identityAndOrganizationConfirmed', 'I independently verified work email ownership and organization', 'checkbox'), f('staffOnlyConfirmed', 'Verified staff only; no student data', 'checkbox')], data => mutate('interest.review', { id: feedback.id, reviewedHash: feedback.hash, ...data }), review);
    }, el);
  }
  for (const r of state.responses) {
    const el = card(`Reply · ${r.state}`, r.text);
    button('Human classification review', () => {
      show(r);
      form('Classify exact reply (no inferred consent)', [...humanFields(), f('state', 'Confirmed response state', 'select', 'ambiguous', ['ambiguous', 'interested', 'needs-info', 'declined', 'unsubscribed'].map(x => [x, x])), f('requestedScope', 'Expressly requested scope', 'select', 'none', ['none', 'interview', 'demo', 'council', 'pilot', 'technical-review', 'feedback', 'webinar'].map(x => [x, x])), f('note', 'Evidence for classification (staff only)', 'textarea')], data => mutate('responses.review', { id: r.id, reviewedHash: r.hash, ...data }), review);
    }, el);
  }
  const verified = state.candidates.filter(c => c.verification);
  if (verified.length) form('Review exact requested triage route', [f('candidateId', 'Verified contact', 'select', verified[0].id, options(verified, x => x.name)), f('kind', 'Explicit requested route', 'select', 'demo', ['interview', 'demo', 'technical-review', 'feedback', 'council', 'pilot'].map(x => [x, x]))], async input => {
    const preview = await api('interest.triage', { ...input, preview: true }); show(preview);
    const extra = input.kind === 'pilot' ? [f('scope', 'Synthetic evaluation scope', 'textarea'), f('owner', 'Accountable planning owner')] : input.kind === 'council' ? [councilField(), f('seat', 'Seat number', 'number'), f('acceptedByContact', 'Actual acceptance of this council seat confirmed (interest alone is insufficient)', 'checkbox')] : [];
    form('Record human triage decision', [...humanFields(), f('note', 'Staff-only rationale / acceptance evidence', 'textarea'), ...extra], data => mutate('interest.triage', { ...input, ...data, reviewedHash: preview.hash }), review);
  }, workspace, 'Read request evidence and route hash');
}
function renderMetrics() {
  workspace.append(node('h2', 'Truthful local metrics'), node('p', state.metrics.scope));
  const grid = node('div', undefined, 'grid'); workspace.append(grid);
  for (const [label, value] of [['Distinct organizations', state.metrics.organizations], ['Distinct contacts', state.metrics.distinctContacts], ['Verified contacts', state.metrics.verifiedContacts], ['Explicit interest contacts', state.metrics.expressedInterestContacts], ['Approved drafts', state.metrics.approvedDrafts], ['Exported drafts (unsent)', state.metrics.exportedDrafts], ['Confirmed sent invitations', state.metrics.confirmedSentInvitations], ['Delivery unknown exports', state.metrics.deliveryUnknownExports], ['Response rate', state.metrics.responseRate.value === null ? 'Unknown — no confirmed sends' : `${state.metrics.responseRate.numerator}/${state.metrics.responseRate.denominator} confirmed invitations`], ['Pilot planning records', state.metrics.pilotPlanning], ['Pilot gates ready', state.metrics.pilotsGateReady]]) card(label, String(value), grid);
  card('Independent signals and source attribution', JSON.stringify({ publicRoleFit: state.metrics.roleFit, expressedInterest: state.metrics.interestTypes, pilotReadiness: state.metrics.pilotsAuthorized, meetingDecisions: state.metrics.meetingFeedback, sources: state.metrics.source }, null, 2));
  workspace.append(node('p', state.metrics.note));
  jsonImport('Optional actual external delivery evidence (human verified)', 'delivery.record');
}
