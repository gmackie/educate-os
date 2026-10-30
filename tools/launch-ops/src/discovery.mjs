import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { check, email, hash, human, id, now, sourceUrl } from './safety.mjs';
import { audit } from './store.mjs';
import { get, norm, safe, single, timestamp } from './funnel-common.mjs';
import { isSuppressed } from './suppression.mjs';
import { importContacts } from './domain.mjs';

export const USER_AGENT = 'EducateOSLaunchOps';
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false; // IPv6 is deliberately unsupported, including mapped IPv4.
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
}
export function approvedUrl(raw, origin) {
  const u = new URL(sourceUrl(raw));
  check(u.origin === origin && !u.port && !isIP(u.hostname) && !u.hostname.endsWith('.localhost') && !/linkedin\.com$/i.test(u.hostname), 'Only the approved official origin, default HTTPS port and public DNS hostname are allowed');
  check(!/\b(?:login|signin|auth|accounts?|students?|pupils?|members?|portal)\b/i.test(decodeURIComponent(u.pathname)), 'No auth, student or member directories');
  return u;
}
function glob(pattern, value) {
  check(pattern.length <= 2000 && value.length <= 2000, 'Robots path exceeds budget');
  let p = 0; let v = 0; let star = -1; let last = 0;
  while (v < value.length) {
    if (pattern[p] === '*') { star = p++; last = v; }
    else if (pattern[p] === value[v]) { p++; v++; }
    else if (star >= 0) { p = star + 1; v = ++last; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function robotsAllows(raw, path) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= 64_000, 'Invalid robots.txt');
  const groups = []; let agents = []; let rules = []; let delay = 1; let sawRules = false;
  const flush = () => { if (agents.length) groups.push({ agents, rules, delay }); agents = []; rules = []; delay = 1; sawRules = false; };
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim(); if (!clean) continue;
    const colon = clean.indexOf(':'); if (colon < 0) continue;
    const key = clean.slice(0, colon).trim().toLowerCase(); const value = clean.slice(colon + 1).trim();
    if (key === 'user-agent') { if (sawRules) flush(); agents.push(value.toLowerCase()); }
    else if (agents.length && ['allow', 'disallow'].includes(key)) { sawRules = true; if (value) { check(value.startsWith('/'), 'Unsupported robots rule'); check(rules.length < 256, 'Too many robots rules'); rules.push({ allow: key === 'allow', value }); } }
    else if (agents.length && key === 'crawl-delay') { sawRules = true; check(/^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 60, 'Unsupported robots delay; stop for manual review'); delay = Math.max(1, Number(value)); }
  }
  flush();
  // Honor every applicable group, including wildcard; conservative when a specific group relaxes it.
  let waitSeconds = 1;
  for (const group of groups.filter(g => g.agents.some(a => a === '*' || USER_AGENT.toLowerCase().includes(a)))) {
    waitSeconds = Math.max(waitSeconds, group.delay);
    const matches = group.rules.filter(r => {
      const pattern = r.value.endsWith('$') ? r.value.slice(0, -1) : r.value + '*';
      return glob(pattern, path) || glob(pattern, decodeURI(path)) || glob(decodeURI(pattern), decodeURI(path));
    }).sort((a, b) => b.value.replace(/[*$]/g, '').length - a.value.replace(/[*$]/g, '').length || Number(b.allow) - Number(a.allow));
    if (matches.length && !matches[0].allow) return { allowed: false, waitSeconds };
  }
  return { allowed: true, waitSeconds };
}
export async function safeGet(raw, origin, resolver = lookup, transport = request) {
  const u = approvedUrl(raw, origin);
  let dnsTimer;
  const addresses = await Promise.race([resolver(u.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS lookup timeout')), 5000); })]).finally(() => clearTimeout(dnsTimer));
  check(addresses.length > 0 && addresses.every(x => publicIPv4(x.address)), 'SSRF blocked: all DNS answers must be public IPv4');
  const pinned = addresses[0].address;
  return new Promise((resolve, reject) => {
    // Pin the checked IP in the transport; TLS still verifies the original hostname.
    const req = transport(u, { method: 'GET', agent: false, family: 4, servername: u.hostname,
      lookup: (_host, options, cb) => cb(null, options.all ? [{ address: pinned, family: 4 }] : pinned, options.all ? undefined : 4),
      headers: { 'User-Agent': `${USER_AGENT}/1.0 (operator-approved institutional directory review)`, Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(new Error('Official source must return 200 without redirect, login or compression')); return; }
      const type = String(res.headers['content-type'] || '').split(';')[0].trim();
      if (!['text/html', 'text/plain'].includes(type)) { res.destroy(); reject(new Error('Unsupported official content type')); return; }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 256_000) { res.destroy(); reject(new Error('Official page exceeds budget')); } else chunks.push(c); });
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), type })); res.on('error', () => reject(new Error('Official source response failed')));
    });
    const timeout = setTimeout(() => req.destroy(new Error('Official source timeout')), 10_000);
    req.on('close', () => clearTimeout(timeout)); req.on('error', () => reject(new Error('Official source transport failed'))); req.end();
  });
}
export const PERSONAS = ['instructional-tech', 'educator', 'district-cto', 'sis', 'superintendent', 'private-school-leader', 'regional-org', 'unclassified'];
export function segment(role, kind) {
  if (['regional', 'isd', 'association'].includes(kind)) return 'regional-org';
  if (/superintendent/i.test(role)) return 'superintendent';
  if (kind === 'private' && /(?:head|principal|director|president)/i.test(role)) return 'private-school-leader';
  if (/chief technology|\bcto\b|technology (?:director|officer)/i.test(role)) return 'district-cto';
  if (/student information system|\bsis\b|data systems/i.test(role)) return 'sis';
  if (/instructional technolog|instructional tech|technology (?:coach|integrat)/i.test(role)) return 'instructional-tech';
  if (/teacher|educator|curriculum|instruction|professional learning/i.test(role)) return 'educator';
  return 'unclassified';
}
export const candidateHash = c => hash({ organizationId: c.organizationId, name: c.name, email: c.email, role: c.role, sourceUrl: c.sourceUrl, observedAt: c.observedAt, snippet: c.snippet, evidenceHash: c.evidenceHash, persona: c.persona, sourceKind: c.sourceKind || 'public-role', consent: c.consent || null });
export function ingestCandidates(s, input) {
  const org = get(s, 'organizations', input.organizationId);
  const approval = s.domainApprovals.find(x => x.organizationId === org.id); check(approval, 'Explicit official domain approval required');
  check(input.noStudentData === true && Array.isArray(input.records) && input.records.length > 0 && input.records.length <= 100, 'Import 1–100 public staff records with no student data');
  const operator = safe(input.operator, 'operator', 120);
  const records = input.records.map(r => {
    const source = sourceUrl(approvedUrl(r.sourceUrl, approval.origin).href);
    const record = { organizationId: org.id, name: single(r.name, 'published staff name', 120), email: email(r.email), role: single(r.role, 'published role', 160), sourceUrl: source,
      observedAt: timestamp(r.observedAt), snippet: safe(r.snippet, 'published provenance snippet', 2000), evidenceHash: r.evidenceHash };
    check(new URL(`https://${record.email.split('@')[1]}`).origin === approval.origin, 'Published address must use the approved institution domain');
    check(/^[a-f0-9]{64}$/.test(record.evidenceHash), 'Evidence SHA-256 required');
    check(record.snippet.includes(record.name) && record.snippet.includes(record.email) && record.snippet.includes(record.role), 'Snippet must explicitly publish name, role and contact together');
    check(!/\b(?:student|pupil|child)\b/i.test((record.name + ' ' + record.role + ' ' + record.snippet).replace(/student information systems?/ig, 'SIS')), 'Student records prohibited');
    return { ...record, persona: segment(record.role, org.kind) };
  });
  let added = 0;
  for (const r of records) {
    if (isSuppressed(s, r.email, org.name)) continue;
    if (s.candidates.some(c => c.email === r.email || (c.organizationId === org.id && norm(c.name) === norm(r.name)))) continue;
    const c = { id: id(), ...r, stage: 'discovered', verification: null, contactId: null, discoveredAt: now() }; s.candidates.push(c); added++;
  }
  audit(s, 'funnel.candidates-quarantined', `${added}`, operator); return { added };
}
export function officialSiteRecords(html, url, org, observedAt = now()) {
  check(typeof html === 'string' && Buffer.byteLength(html) <= 256_000, 'Official page exceeds budget');
  const records = [];
  // Deliberately narrow official adapter: published schema.org Person JSON-LD only.
  // Never infer a name or email from nearby markup, link labels, or address patterns.
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let json; try { json = JSON.parse(match[1]); } catch { continue; }
    const nodes = Array.isArray(json) ? json : Array.isArray(json['@graph']) ? json['@graph'] : [json];
    for (const person of nodes) {
      if (!person || person['@type'] !== 'Person' || typeof person.name !== 'string' || typeof person.jobTitle !== 'string' || typeof person.email !== 'string') continue;
      if (typeof person.worksFor?.name !== 'string' || norm(person.worksFor.name) !== norm(org.name)) continue;
      const address = person.email.replace(/^mailto:/i, '');
      records.push({ name: person.name, role: person.jobTitle, email: address, sourceUrl: url, observedAt, snippet: JSON.stringify({ name: person.name, jobTitle: person.jobTitle, email: address, worksFor: person.worksFor.name }), evidenceHash: hash(html) });
    }
  }
  check(records.length <= 100, 'Official page has too many staff records'); return records;
}
export function verifyCandidate(s, input) {
  const c = get(s, 'candidates', input.id); const h = candidateHash(c); const reviewer = human(input, h);
  check(c.stage === 'discovered' || c.stage === 'verified', 'Only quarantine or verification can be reviewed');
  check(input.publicProfessionalConfirmed === true && input.accurateEvidenceConfirmed === true && input.noStudentData === true, 'Confirm published staff identity, role, exact address and evidence');
  check(Date.now() - Date.parse(c.observedAt) <= 90 * 86400_000, 'Evidence is stale; import a fresh source');
  const org = get(s, 'organizations', c.organizationId); check(!isSuppressed(s, c.email, org.name), 'Contact or organization is suppressed');
  importContacts(s, { contacts: [{ name: c.name, email: c.email, role: c.role, organization: org.name, sourceUrl: c.sourceUrl, tags: c.persona === 'educator' ? ['teaching'] : c.persona === 'regional-org' ? ['community'] : ['integrations'] }], operator: reviewer, publicProfessionalOnly: true, noStudentData: true });
  const contact = s.contacts.find(x => x.email === c.email); check(contact, 'Conflicting name/organization; review duplicate before verification');
  c.contactId = contact.id; c.verification = { hash: h, reviewer, at: now() }; c.stage = 'verified';
  audit(s, 'funnel.candidate-verified', c.id, reviewer); return c;
}
export async function crawlOfficial(store, input, deps = {}) {
  check(input.allowNetwork === true, 'Network discovery disabled; use explicit --allow-network');
  const s = store.read(); const org = get(s, 'organizations', input.organizationId);
  const approval = s.domainApprovals.find(x => x.organizationId === org.id); check(approval && Date.now() - Date.parse(approval.approvedAt) < 30 * 86400_000, 'Current human domain approval required');
  check(Array.isArray(input.urls) && input.urls.length > 0 && input.urls.length <= 3, 'Choose 1–3 explicit official staff pages');
  const urls = input.urls.map(u => approvedUrl(u, approval.origin));
  const getter = deps.get || safeGet; const pause = deps.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const reserve = () => store.transaction(state => {
    const day = now().slice(0, 10); let usage = state.crawlUsage.find(x => x.origin === approval.origin && x.day === day);
    if (!usage) { usage = { origin: approval.origin, day, requests: 0, lastAt: 0 }; state.crawlUsage.push(usage); }
    check(usage.requests < 6, 'Per-domain daily request budget exhausted');
    check(Date.now() - usage.lastAt >= 1000, 'Domain rate limit; retry later'); usage.requests++; usage.lastAt = Date.now();
  });
  reserve(); const robots = await getter(`${approval.origin}/robots.txt`, approval.origin);
  check(robots.type === 'text/plain', 'robots.txt must be plain text; missing/failed robots is a stop');
  const records = [];
  for (const url of urls) {
    const policy = robotsAllows(robots.text, url.pathname); check(policy.allowed, 'robots.txt disallows the requested page');
    await pause(policy.waitSeconds * 1000); reserve(); const page = await getter(url.href, approval.origin);
    check(page.type === 'text/html', 'Staff source must be HTML'); records.push(...officialSiteRecords(page.text, url.href, org));
  }
  return store.transaction(state => {
    const current = state.domainApprovals.find(x => x.organizationId === org.id); check(current?.id === approval.id, 'Domain approval changed during fetch');
    if (!records.length) return { added: 0, note: 'No explicitly published institutional Person records found; use reviewed fixture ingestion' };
    return ingestCandidates(state, { organizationId: org.id, records, operator: input.operator, noStudentData: true });
  });
}
