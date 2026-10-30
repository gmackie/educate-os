import { readFileSync, statSync } from 'node:fs';
import { funnelMutations } from './funnel.mjs';
import { crawlOfficial, ingestCandidates, officialSiteRecords, robotsAllows, approvedUrl } from './discovery.mjs';
import { exportOutreach } from './campaigns.mjs';
import { metrics } from './operations.mjs';
import { check } from './safety.mjs';
import { get } from './funnel-common.mjs';

function jsonFile(path) { check(typeof path === 'string' && statSync(path).size <= 200_000, 'Private JSON input must be <=200 KB'); return JSON.parse(readFileSync(path, 'utf8')); }
export const FUNNEL_HELP = `
Local sourcing / interest pipeline (JSON files under .private/; see examples):
  sources                                    print official source catalog (offline)
  funnel <action> <private-input.json>        same actions as dashboard; e.g. sender.configure
  registry-import <private-input.json>       import approved organization CSV + provenance
  candidate-import <private-input.json>      quarantine public institutional staff fixtures
  official-fixture <private-input.json>      parse approved official-site HTML + robots fixture
  interest-import <private-export.json> <operator>  quarantine website-interest v1 records
  responses-import <private-input.json>      CSV or JSON replies, all ambiguous except explicit opt-out
  daily <private-input.json>                 idempotent local imports, drafts and review queues
  metrics                                    honest distinct counts; unknown sends stay unknown
  outreach-export <private-input.json>       approved local EML/CSV/JSON, never a send
  crawl --allow-network <private-input.json> one approved origin, robots + request budgets

All reviews need humanReviewed, reviewer, reviewedHash from current dashboard state.
No approval, selection, export, network or consent inference occurs automatically.
`;
export async function runFunnelCommand(store, command, args) {
  if (command === 'sources') { const { SOURCE_CATALOG } = await import('./registry.mjs'); check(!args.length, 'sources takes no arguments'); return SOURCE_CATALOG; }
  if (command === 'metrics') { check(!args.length, 'metrics takes no arguments'); return metrics(store.read()); }
  if (command === 'crawl') { check(args.length === 2 && args[0] === '--allow-network', 'Use crawl --allow-network <private-input.json>'); return crawlOfficial(store, { ...jsonFile(args[1]), allowNetwork: true }); }
  if (command === 'interest-import') { check(args.length === 2, 'Use interest-import <private-export.json> <operator>'); return store.transaction(s => funnelMutations['interest.import'](s, { envelope: jsonFile(args[0]), operator: args[1] })); }
  const aliases = { 'registry-import': 'registry.import', 'candidate-import': 'candidates.import', 'responses-import': 'responses.import', daily: 'daily.run' };
  if (command === 'official-fixture') {
    check(args.length === 1, 'Use official-fixture <private-input.json>'); const input = jsonFile(args[0]);
    return store.transaction(s => {
      const org = get(s, 'organizations', input.organizationId); const approval = s.domainApprovals.find(x => x.organizationId === org.id); check(approval, 'Explicit domain approval required');
      const url = approvedUrl(input.url, approval.origin); check(robotsAllows(input.robotsTxt, url.pathname).allowed, 'robots.txt disallows fixture');
      const records = officialSiteRecords(input.html, url.href, org, input.observedAt);
      if (!records.length) return { added: 0 };
      return ingestCandidates(s, { organizationId: org.id, operator: input.operator, noStudentData: true, records });
    });
  }
  if (command === 'outreach-export') {
    check(args.length === 1, 'Use outreach-export <private-input.json>'); const input = jsonFile(args[0]);
    return store.transaction(s => {
      const content = exportOutreach(s, input); const file = store.exportFile(content, input.format);
      for (const h of s.handoffs.filter(h => input.ids.includes(h.outreachId))) h.fileName = file.name;
      return { name: file.name, location: '.private/exports/' };
    });
  }
  const action = command === 'funnel' ? args[0] : aliases[command];
  check(action && Object.hasOwn(funnelMutations, action), 'Unknown pipeline command; see help');
  check(args.length === (command === 'funnel' ? 2 : 1), 'Provide one private JSON input file');
  const input = jsonFile(args[command === 'funnel' ? 1 : 0]);
  const result = store.transaction(s => funnelMutations[action](s, input));
  if (action === 'privacy.erase' && !input.preview) store.purgeExports(); return result;
}
