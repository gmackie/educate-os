// Releases a departing district's `<slug>.educateos.io` from educateos.io's own DNS zone (SCHO-368,
// district offboarding, docs/educateos/runbooks/district-offboarding.md step 7). Run by Gmacko
// Ventures with educateos.io's DNS token, never a district's: it deletes the CNAME and validation
// TXT records that carry the instance's ownership comment (`educateos:<instanceId>`), through the
// managed zone's own planner (`planManagedZone` with no records), and leaves every other record,
// including another owner's at the same names, alone.
//
//   EDUCATEOS_MANAGED_CF_API_TOKEN=... \
//   node packages/educateos-installer/scripts/release-managed-slug.ts \
//     --managed-account <educateos.io's account ID> --instance <ins_...> --slug <slug> [--apply]
//
// Without --apply it prints the plan and changes nothing. Run it after the district has removed the
// custom hostname on its side (`launch-educate-os uninstall`), and after deregistering the
// installation in the control plane, if it had one. Output holds record names and actions, never a
// token. Not yet run against the live zone.
import { parseArgs } from "node:util";
import { CloudflareHttpApi } from "../src/cloudflare-http.ts";
import { applyManagedZone, planManagedZone } from "../src/managed-zone.ts";
import { DistrictSlug, MANAGED_ZONE, managedHostname } from "../src/slug.ts";
import { staticTokenProvider } from "../src/token.ts";

const { values } = parseArgs({
  options: {
    "managed-account": { type: "string" },
    instance: { type: "string" },
    slug: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const need = (name: "managed-account" | "instance" | "slug") => {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
  return value;
};
const instanceId = need("instance");
if (!/^ins_[a-z0-9][a-z0-9-]{0,19}$/.test(instanceId)) throw new Error("--instance must be an instance ID, ins_...");
const hostname = managedHostname(DistrictSlug.parse(need("slug")));
const token = process.env.EDUCATEOS_MANAGED_CF_API_TOKEN;
if (!token) throw new Error("EDUCATEOS_MANAGED_CF_API_TOKEN is not set");
const managed = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", token) });

const zone = await managed.findZone(need("managed-account"), MANAGED_ZONE);
if (!zone) throw new Error(`the token cannot see ${MANAGED_ZONE} in that account`);
const plan = await planManagedZone(managed, { zoneId: zone.id, instanceId, hostname, records: null });
console.log(JSON.stringify({
  hostname,
  instanceId,
  steps: plan.steps.map((s) => ({ action: s.action, ...("spec" in s ? { type: s.spec.type, name: s.spec.name } : { type: s.record.type, name: s.record.name }) })),
}));
if (plan.steps.length === 0) console.log(JSON.stringify({ note: `no record of ${instanceId}'s at ${hostname}: nothing to release` }));
else if (values.apply) console.log(JSON.stringify({ deleted: await applyManagedZone(managed, plan) }));
else console.log(JSON.stringify({ note: "plan only; pass --apply to delete these records" }));
