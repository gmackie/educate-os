import { check, email, hash, human, id, now, oneOf, toCsv } from './safety.mjs';
import { audit } from './store.mjs';
import { get, safe, single } from './funnel-common.mjs';
import { candidateHash } from './discovery.mjs';
import { isSuppressed, suppress } from './suppression.mjs';

export const CAMPAIGNS = Object.freeze({
  'regional-referral': { title: 'Regional partner introduction', ask: 'Would your regional organization consider a brief introduction to the appropriate staff feedback channel? Please do not share member lists or personal contacts without their permission.' },
  interview: { title: 'Discovery interview', ask: 'Would you be willing to share practical staff workflow feedback in a 20-minute discovery interview? This is research, with no purchase commitment.' },
  council: { title: 'Educator and technical advisory group', ask: 'Would you be open to a 20-minute preview and a conversation about a small educator and technical advisory group? A referral to an interested colleague is welcome, with their permission. Time commitment, scope and any compensation would require mutual agreement; none is promised.' },
  'technical-demo': { title: 'Technical demonstration', ask: 'Would a 20-minute synthetic technical demonstration be useful? We can discuss limitations and integration questions; no account or data access is requested.' },
  webinar: { title: 'Opt-in staff webinar', ask: 'Would you like information about an optional staff webinar? Registration and any future updates require your explicit opt-in.' },
});
export function configureOperator(s, input) {
  check(input.complianceReviewed === true, 'Human must review sender identity, physical address and free opt-out process (including B2B)');
  const config = { senderName: single(input.senderName, 'sender name', 120), senderEmail: email(input.senderEmail), physicalAddress: single(input.physicalAddress, 'valid physical postal address', 400), optOutEmail: email(input.optOutEmail),
    dailyCap: input.dailyCap, cooldownDays: input.cooldownDays, followUpDays: input.followUpDays, retentionDays: input.retentionDays, reviewer: safe(input.operator, 'operator', 120) };
  for (const [k, lo, hi] of [['dailyCap', 1, 20], ['cooldownDays', 14, 365], ['followUpDays', 7, 90], ['retentionDays', 7, 365]]) check(Number.isInteger(config[k]) && config[k] >= lo && config[k] <= hi, `Invalid ${k}`);
  check(config.followUpDays >= config.cooldownDays, 'Follow-up must respect organization cooldown');
  config.versionHash = hash(config); config.at = now(); s.operatorConfigs = [config];
  for (const o of s.outreach) o.approval = null;
  audit(s, 'funnel.sender-configured', config.versionHash, config.reviewer); return config;
}
export function createCampaign(s, input) {
  const kind = oneOf(input.kind, Object.keys(CAMPAIGNS), 'campaign');
  const c = { id: id(), kind, context: claimSafe(safe(input.context, 'truthful campaign context', 1000)), active: true, revision: 1, createdAt: now() };
  s.campaigns.push(c); audit(s, 'funnel.campaign-created', c.id, safe(input.operator, 'operator', 120)); return c;
}
export function reviseCampaign(s, input) {
  const c = get(s, 'campaigns', input.id);
  c.context = claimSafe(safe(input.context, 'truthful campaign context', 1000)); check(typeof input.active === 'boolean', 'Campaign active flag required'); c.active = input.active; c.revision++;
  for (const o of s.outreach.filter(o => o.campaignId === c.id)) o.approval = null;
  audit(s, 'funnel.campaign-revised', c.id, safe(input.operator, 'operator', 120)); return c;
}
function eligible(s, c) {
  check(c.verification?.hash === candidateHash(c), 'Current evidence needs human verification');
  check(Date.now() - Date.parse(c.observedAt) <= 90 * 86400_000, 'Evidence is stale; obtain current published evidence');
  const contact = get(s, 'contacts', c.contactId); const org = get(s, 'organizations', c.organizationId);
  check(contact.email === c.email && contact.name === c.name && contact.role === c.role && contact.sourceUrl === c.sourceUrl && contact.organization === org.name, 'Contact changed; verify current source');
  check(!contact.suppressed && !isSuppressed(s, c.email, org.name), 'Contact or organization is suppressed');
  return { contact, org };
}
export function selectCandidate(s, input) {
  const c = get(s, 'candidates', input.id); eligible(s, c);
  check(c.stage === 'verified', 'Select a verified candidate');
  check(!s.candidates.some(x => x.organizationId === c.organizationId && x.id !== c.id && !['discovered', 'verified'].includes(x.stage)), 'One initial contact per organization across all campaigns');
  check(!s.handoffs.some(x => x.organizationId === c.organizationId), 'Organization already approached; no parallel employee outreach');
  c.stage = 'selected'; audit(s, 'funnel.candidate-selected', c.id, safe(input.operator, 'operator', 120)); return c;
}
export function outreachContent(s, o) {
  const c = get(s, 'candidates', o.candidateId); const org = get(s, 'organizations', c.organizationId);
  const campaign = get(s, 'campaigns', o.campaignId); const config = s.operatorConfigs[0];
  return { recipient: { id: c.id, name: c.name, email: c.email, contact: get(s, 'contacts', c.contactId), organization: org, verification: c.verification }, evidence: { hash: candidateHash(c), sourceImports: s.sourceImports.filter(x => org.importIds.includes(x.id)) },
    campaign, sender: config || null, subject: o.subject, body: o.body, source: o.source, followUpOf: o.followUpOf };
}
export const outreachHash = (s, o) => hash(outreachContent(s, o));
function footer(config) { return `\n\n${config.senderName}\n${config.senderEmail}\n${config.physicalAddress}\nThis is an outreach invitation about EducateOS. For free opt-out from further outreach, reply to ${config.optOutEmail} with unsubscribe. We block opt-outs immediately when imported; the operator must monitor this mailbox and honor requests within 10 business days. No login, fee, or extra personal information is required.`; }
export function draftOutreach(s, input) {
  const c = get(s, 'candidates', input.candidateId); const { org } = eligible(s, c); const campaign = get(s, 'campaigns', input.campaignId);
  if (c.sourceKind === 'staff-optin') {
    const scopes = { demo: 'technical-demo', 'technical-review': 'technical-demo', council: 'council', feedback: 'interview', webinar: 'webinar' };
    check(c.consent.responseConsent && scopes[c.consent.interestType] === campaign.kind, 'Preserve staff consent scope; no unrelated campaign from an intake request');
  }
  const config = s.operatorConfigs[0]; check(config, 'Configure compliant sender identity and opt-out process first'); check(campaign.active, 'Campaign is inactive');
  check(campaign.kind !== 'regional-referral' || c.persona === 'regional-org', 'Regional referrals require published regional role evidence');
  check(!s.outreach.some(x => x.candidateId === c.id && !x.exportedAt), 'An unexported draft already exists for this person');
  let followUpOf = null;
  if (input.followUpOf) {
    const original = get(s, 'outreach', input.followUpOf);
    check(original.candidateId === c.id && original.campaignId === campaign.id && original.exportedAt && !original.followUpOf, 'Follow-up must reference the same exported initial campaign draft');
    check(!s.outreach.some(x => x.followUpOf === original.id), 'Only one follow-up is permitted');
    check(!s.responses.some(x => x.candidateId === c.id), 'Any imported reply stops follow-up pending review');
    check(Date.now() - Date.parse(original.exportedAt) >= config.followUpDays * 86400_000, 'Follow-up waiting interval not reached');
    followUpOf = original.id;
  } else check(c.stage === 'selected' && !s.handoffs.some(x => x.organizationId === c.organizationId), 'Initial outreach requires selection and an unapproached organization');
  const o = { id: id(), candidateId: c.id, contactId: c.contactId, campaignId: campaign.id, followUpOf,
    subject: `${followUpOf ? 'One follow-up: ' : ''}Invitation to help shape EducateOS — open-source AI for schools`,
    body: `Hello ${c.name},\n\nI'm helping develop EducateOS, an open-source platform that lets schools use AI for teaching, learning, and administration while retaining ownership of their infrastructure and student data.\n\nParticipation requires no school purchase or deployment, and we use synthetic data initially.${['technical-demo'].includes(campaign.kind) ? ' Districts host independently in their own Cloudflare accounts. We welcome feedback on security, LTI/OneRoster integration and control of data; this makes no claim of vendor agreements or certification.' : ''}\n\nYour explicitly published role, ${c.role} at ${org.name}, is why this invitation may be professionally relevant (source: ${c.sourceUrl}). This public role evidence does not indicate interest or endorsement.\n\n${campaign.context}\n\nEducateOS is an evolving platform with an open source and district-owned design; we are exploring a foundation model. We are seeking staff feedback; this invitation makes no claim of a relationship, certification, school approval, demonstrated outcomes or production-ready pilot.\n\n${CAMPAIGNS[campaign.kind].ask}\n\nNo student records, credentials or system access should be shared. Participation is optional. A reply permits only the specific conversation you request; it does not enroll you in marketing or authorize a pilot.${footer(config)}`,
    source: 'deterministic-evidence-template-v1', approval: null, createdAt: now(), exportedAt: null };
  s.outreach.push(o); c.stage = 'draft'; audit(s, 'funnel.outreach-drafted', o.id, safe(input.operator, 'operator', 120)); return { ...o, hash: outreachHash(s, o) };
}
export function claimSafe(value) {
  check(!/501\s*\(?c\)?|LTI Advantage Complete|certified Clever|signed Clever|participating districts|endorsed by|production pilots/iu.test(value), 'Remove unsupported legal status, certification, partnership, participation or endorsement claims'); return value;
}
export function reviseOutreach(s, input) {
  const o = get(s, 'outreach', input.id); check(!o.exportedAt, 'Exported handoff is immutable; revoke its use outside this tool');
  o.subject = claimSafe(single(input.subject, 'subject')); o.body = claimSafe(safe(input.body, 'outreach body', 12_000)); o.source = 'human-edited-v1'; o.approval = null;
  get(s, 'candidates', o.candidateId).stage = 'draft'; audit(s, 'funnel.outreach-revised', o.id, safe(input.operator, 'operator', 120)); return { ...o, hash: outreachHash(s, o) };
}
function current(s, o) {
  const c = get(s, 'candidates', o.candidateId); eligible(s, c); check(get(s, 'campaigns', o.campaignId).active, 'Campaign is inactive'); check(!o.exportedAt, 'Already handed off; no duplicate export');
  const config = s.operatorConfigs[0];
  check(o.body.includes(config.physicalAddress) && o.body.includes(config.optOutEmail) && o.body.includes(config.senderEmail) && /opt-out/i.test(o.body), 'Edited message must retain sender, postal address and clear opt-out');
  check(!s.responses.some(x => x.candidateId === c.id), 'Reply received; review and use the requested human conversation, no campaign handoff');
  return c;
}
export function approveBatch(s, input) {
  check(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 20 && new Set(input.items.map(x => x.id)).size === input.items.length, 'Explicitly choose 1–20 unique drafts for human approval');
  check(input.truthfulClaimsConfirmed === true && input.sourceAndRecipientConfirmed === true && input.complianceConfirmed === true, 'Confirm claims, exact recipient/source and commercial-message compliance');
  const reviewed = input.items.map(item => {
    const o = get(s, 'outreach', item.id); current(s, o); const h = outreachHash(s, o); const reviewer = human({ ...input, reviewedHash: item.reviewedHash }, h); return { o, h, reviewer };
  });
  for (const { o, h, reviewer } of reviewed) { o.approval = { hash: h, reviewer, at: now() }; get(s, 'candidates', o.candidateId).stage = 'approval'; audit(s, 'funnel.outreach-approved', o.id, reviewer); }
  return { approved: reviewed.length };
}
export function exportOutreach(s, input) {
  check(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 20 && new Set(input.ids).size === input.ids.length, 'Choose unique approved drafts');
  const format = oneOf(input.format, ['csv', 'eml', 'json'], 'handoff format'); check(format !== 'eml' || input.ids.length === 1, 'EML exports one draft at a time');
  const records = input.ids.map(key => {
    const o = get(s, 'outreach', key); const c = current(s, o);
    check(o.approval?.hash === outreachHash(s, o), 'Current exact-hash human approval required');
    const prior = s.handoffs.filter(x => x.organizationId === c.organizationId);
    check(!prior.length || (o.followUpOf && prior.every(x => x.outreachId === o.followUpOf)), 'One organization contact and one follow-up only');
    check(!prior.some(x => Date.now() - Date.parse(x.at) < s.operatorConfigs[0].cooldownDays * 86400_000), 'Organization cooldown is active');
    return { o, c, content: outreachContent(s, o) };
  });
  check(new Set(records.map(x => x.c.organizationId)).size === records.length, 'No batch can approach an organization through multiple employees');
  const day = now().slice(0, 10); check(s.handoffs.filter(x => x.at.startsWith(day)).length + records.length <= s.operatorConfigs[0].dailyCap, 'Daily contact cap reached');
  let content;
  if (format === 'eml') {
    const { o, c } = records[0]; const config = s.operatorConfigs[0];
    const encoded = v => `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`;
    const encodedBody = Buffer.from(o.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
    content = `X-Unsent: 1\r\nFrom: ${encoded(config.senderName)} <${config.senderEmail}>\r\nTo: ${encoded(c.name)} <${c.email}>\r\nSubject: ${encoded(o.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\nList-Unsubscribe: <mailto:${config.optOutEmail}?subject=unsubscribe>\r\nX-EducateOS-Approval: ${o.approval.hash}\r\n\r\n${encodedBody}\r\n`;
  } else if (format === 'csv') content = toCsv([['draftId', 'email', 'name', 'organization', 'campaign', 'subject', 'body', 'sourceUrl', 'approvalHash', 'reviewer'], ...records.map(({ o, c }) => [o.id, c.email, c.name, get(s, 'organizations', c.organizationId).name, get(s, 'campaigns', o.campaignId).kind, o.subject, o.body, c.sourceUrl, o.approval.hash, o.approval.reviewer])]);
  else content = JSON.stringify({ type: 'approved-local-draft-handoff-not-sent', records: records.map(({ o, content: record }) => ({ ...record, approval: o.approval })) }, null, 2);
  for (const { o, c } of records) {
    o.exportedAt = now(); c.stage = 'exported';
    s.handoffs.push({ id: id(), outreachId: o.id, candidateId: c.id, organizationId: c.organizationId, campaignId: o.campaignId, approvalHash: o.approval.hash, at: o.exportedAt }); audit(s, 'funnel.outreach-exported-not-sent', o.id);
  }
  return content;
}
export function suppressCandidate(s, input) {
  const c = get(s, 'candidates', input.id); const org = get(s, 'organizations', c.organizationId);
  const reason = oneOf(input.reason, ['optout', 'declined', 'bounce', 'operator-hold'], 'suppression reason');
  return suppress(s, { address: c.email, organization: input.organizationWide === true ? org.name : undefined, reason, operator: input.operator });
}
