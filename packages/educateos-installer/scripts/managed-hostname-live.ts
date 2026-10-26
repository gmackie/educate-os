// Drives a cross-account managed hostname, `<slug>.educateos.io`, against real Cloudflare accounts
// (SCHO-241), through the installer's own plan and apply for both halves: the district half in the
// district's account (managed-hostname.ts) and the educateos.io half in the managed zone
// (managed-zone.ts). It proves on a live second account what the installer's fake only models.
//
//   EDUCATEOS_DISTRICT_CF_API_TOKEN=... EDUCATEOS_MANAGED_CF_API_TOKEN=... \
//   node packages/educateos-installer/scripts/managed-hostname-live.ts \
//     --account <district account ID> --zone <district zone> --script <district Worker> \
//     --instance <instance ID> --slug <slug> --managed-account <educateos.io's account ID> \
//     [--release] [--apply]
//
// Without --apply it prints both plans and changes nothing. --release plans the slug's release:
// the district's custom hostname and route, then the managed zone's records. The district's Access
// application is not touched; add or drop the alias there around attach and release. Output holds
// plans, statuses and record names, never a token.
import { parseArgs } from "node:util";
import { CloudflareHttpApi } from "../src/cloudflare-http.ts";
import type { DesiredManagedHostname } from "../src/desired.ts";
import { applyManagedHostname, managedHostnameRecords, planManagedHostname } from "../src/managed-hostname.ts";
import { applyManagedZone, planManagedZone } from "../src/managed-zone.ts";
import { DistrictSlug, MANAGED_ZONE, managedHostname } from "../src/slug.ts";
import { staticTokenProvider } from "../src/token.ts";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    zone: { type: "string" },
    script: { type: "string" },
    instance: { type: "string" },
    "managed-account": { type: "string" },
    slug: { type: "string" },
    release: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
  },
});
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
  return value;
};
const accountId = need("account");
const zoneName = need("zone");
const scriptName = need("script");
const instanceId = need("instance");
const managedAccount = need("managed-account");
const hostname = managedHostname(DistrictSlug.parse(need("slug")));

const token = (variable: string) => {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is not set`);
  return new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", value) });
};
const district = token("EDUCATEOS_DISTRICT_CF_API_TOKEN");
const managed = token("EDUCATEOS_MANAGED_CF_API_TOKEN");

const zone = await district.findZone(accountId, zoneName);
if (!zone) throw new Error(`zone ${zoneName} is not in account ${accountId}`);
const managedZone = await managed.findZone(managedAccount, MANAGED_ZONE);
if (!managedZone) throw new Error(`the managed-zone token cannot see ${MANAGED_ZONE}`);

const context = { accountId, instanceId, domains: await district.listWorkerDomains(accountId), zone };
const resource = (phase: "release" | "attach"): DesiredManagedHostname => ({
  kind: "managed_hostname",
  key: phase === "release" ? "domain:managed:release" : "domain:managed",
  dependsOn: [],
  phase,
  // Releasing keeps nothing; attaching keeps the slug's hostname.
  hostname: values.release ? null : hostname,
  scriptName,
  zoneName,
} as DesiredManagedHostname);

const phase = values.release ? "release" : "attach";
const plan = await planManagedHostname(district, resource(phase), context);
console.log(JSON.stringify({ half: "district", phase, hostname, action: plan.action, reason: plan.reason, ops: plan.ops.map((o) => o.op) }));
if (values.apply && plan.ops.length > 0) await applyManagedHostname(district, accountId, instanceId, scriptName, plan.ops);

// The managed zone follows the district: on release once the custom hostname is gone, on attach
// with whatever validation records Cloudflare has issued so far (re-run until both are active).
if (plan.action === "needs-input" || plan.action === "refuse") process.exit(plan.action === "refuse" ? 1 : 0);
const records = values.release ? null : await managedHostnameRecords(district, zone.id, hostname);
if (!values.release && !records) {
  console.log(JSON.stringify({ half: "managed", note: values.apply ? "custom hostname not readable yet; re-run" : "apply the district half first" }));
} else {
  const zonePlan = await planManagedZone(managed, { zoneId: managedZone.id, instanceId, hostname, records: records ?? null });
  console.log(JSON.stringify({
    half: "managed",
    steps: zonePlan.steps.map((s) => ({ action: s.action, ...("spec" in s ? { type: s.spec.type, name: s.spec.name } : { type: s.record.type, name: s.record.name }) })),
  }));
  if (values.apply) console.log(JSON.stringify({ half: "managed", changed: await applyManagedZone(managed, zonePlan) }));
}

const custom = await district.findCustomHostname(zone.id, hostname).catch(() => undefined);
console.log(JSON.stringify({ hostname, customHostname: custom ? { status: custom.status, ssl: custom.sslStatus, pendingTxt: [custom.ownership, ...custom.certificateValidation].filter(Boolean).map((r) => r!.name) } : null }));

