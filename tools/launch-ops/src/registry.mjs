import { readFileSync } from 'node:fs';
import { audit } from './store.mjs';
import { check, hash, human, id, now, oneOf, parseCsv, sourceUrl } from './safety.mjs';
import { date, get, norm, safe, single } from './funnel-common.mjs';

export const SOURCE_CATALOG = JSON.parse(readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
export const ORG_HEADERS = ['ncesId', 'name', 'state', 'kind', 'website'];
export function importRegistry(s, input) {
  const source = SOURCE_CATALOG.sources.find(x => x.id === input.sourceId); check(source, 'Unknown source catalog ID');
  check(input.approvedSource === true && input.noStudentData === true, 'Operator must approve organization-only source import');
  const operator = safe(input.operator, 'operator', 120); const observedAt = date(input.observedAt);
  const attribution = safe(input.attribution, 'source attribution', 500);
  const mapping = input.mapping || Object.fromEntries(ORG_HEADERS.map(k => [k, k]));
  check(Object.keys(mapping).length === ORG_HEADERS.length && ORG_HEADERS.every(k => typeof mapping[k] === 'string') && new Set(Object.values(mapping)).size === ORG_HEADERS.length, 'Mapping must provide five distinct organization columns');
  const raw = parseCsv(input.csv, Object.values(mapping));
  const rows = raw.map(r => {
    const v = Object.fromEntries(ORG_HEADERS.map(k => [k, r[mapping[k]]]));
    check(v.ncesId === '' || /^[A-Za-z0-9-]{5,20}$/.test(v.ncesId), 'Invalid NCES/PSS identifier; preserve leading zeros');
    const state = oneOf(v.state, source.coverage, 'source state'); const kind = oneOf(v.kind, source.kinds, 'organization kind');
    return { ...v, name: single(v.name, 'organization', 160), state, kind, website: sourceUrl(v.website) };
  });
  const contentHash = hash({ sourceId: source.id, observedAt, attribution, rows });
  const old = s.sourceImports.find(x => x.contentHash === contentHash); if (old) return { id: old.id, replay: true, added: 0 };
  const batch = { id: id(), sourceId: source.id, sourceUrl: source.url, observedAt, attribution, contentHash, operator, importedAt: now(), rows: rows.length };
  let added = 0;
  for (const row of rows) {
    const domain = new URL(row.website).hostname;
    const org = s.organizations.find(o => (row.ncesId && o.ncesId === row.ncesId) || new URL(o.website).hostname === domain || (norm(o.name) === norm(row.name) && o.state === row.state));
    if (org) { if (!org.importIds.includes(batch.id)) org.importIds.push(batch.id); continue; }
    s.organizations.push({ id: id(), ...row, importIds: [batch.id], createdAt: now() }); added++;
  }
  s.sourceImports.push(batch); audit(s, 'funnel.registry-imported', batch.id, operator); return { ...batch, added };
}
export function approveDomain(s, input) {
  const org = get(s, 'organizations', input.organizationId);
  const origin = new URL(sourceUrl(input.origin)).origin;
  check(origin === new URL(org.website).origin && new URL(input.origin).pathname === '/', 'Approve the exact registry origin (HTTPS, root path)');
  const basis = { organizationId: org.id, origin, purpose: 'public-institutional-staff-only', policy: 'robots-required-no-logins-no-members-v1' };
  const reviewedHash = hash(basis);
  if (input.preview === true) return { ...basis, hash: reviewedHash };
  const reviewer = human(input, reviewedHash);
  check(input.officialDomainConfirmed === true && input.noMemberLists === true, 'Confirm official school/regional domain and no member directories');
  check(!/linkedin\.com$|(?:^|\.)(?:facebook|instagram|x)\.com$/.test(new URL(origin).hostname), 'Social scraping is prohibited');
  const approval = { id: id(), ...basis, hash: reviewedHash, reviewer, approvedAt: now() };
  s.domainApprovals = s.domainApprovals.filter(x => x.organizationId !== org.id); s.domainApprovals.push(approval);
  audit(s, 'funnel.domain-approved', approval.id, reviewer); return approval;
}
