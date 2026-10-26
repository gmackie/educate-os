// The educateos.io half of a cross-account managed hostname (ADR-0013 addendum A1): the DNS
// records on the managed zone, run with educateos.io's credential. It publishes routing and
// validation data only: a DNS-only CNAME to the district's fallback origin, so no educateos.io
// setting or Worker is on the district's path, and the TXT records that validate the district's
// custom hostname and its certificate. The same-account path needs none of this, since the
// district's Workers custom domain owns its record.
//
// A slug is unique here. Every record carries its instance's ownership comment, and a record at
// any of a hostname's names without that comment makes the plan refuse: the slug is taken.
import { EducateOsError } from "@educateos/contracts";
import type { CloudflareApi, DnsRecord, DnsRecordSpec } from "./cloudflare-api.ts";
import { CloudflareApiError } from "./errors.ts";
import type { ManagedHostnameRecords } from "./managed-hostname.ts";
import { guarded } from "./plan.ts";

/** The ownership comment on every managed-zone record of one instance. */
export function ownerComment(instanceId: string): string {
  return `educateos:${instanceId}`;
}

/**
 * What the managed zone should hold for one instance's hostname: its records, or null to release
 * the hostname, deleting every record the instance owns there.
 */
export interface ManagedZoneClaim {
  zoneId: string;
  instanceId: string;
  hostname: string;
  records: ManagedHostnameRecords | null;
}

/** One record change. */
export type ManagedZoneStep =
  | { action: "create"; spec: DnsRecordSpec }
  | { action: "update"; recordId: string; spec: DnsRecordSpec }
  | { action: "delete"; record: DnsRecord }
  | { action: "refuse"; record: DnsRecord; reason: string };

/** The managed zone's plan for one claim. Applying refuses a plan with any `refuse` step. */
export interface ManagedZonePlan {
  claim: ManagedZoneClaim;
  steps: ManagedZoneStep[];
}

/** The names a hostname's records may use. */
export function managedRecordNames(hostname: string): string[] {
  return [hostname, `_cf-custom-hostname.${hostname}`, `_acme-challenge.${hostname}`];
}

function desiredSpecs(claim: ManagedZoneClaim): DnsRecordSpec[] {
  const { records } = claim;
  if (!records) return [];
  if (records.hostname !== claim.hostname) throw new EducateOsError("validation-failed", `records are for ${records.hostname}, not ${claim.hostname}`);
  const names = new Set(managedRecordNames(claim.hostname));
  const comment = ownerComment(claim.instanceId);
  const txt = records.txt.map((record) => {
    // A validation record outside the hostname's own names is not this hostname's to publish.
    if (!names.has(record.name) || record.name === claim.hostname) throw new EducateOsError("validation-failed", `unexpected validation record ${record.name}`);
    return { type: "TXT" as const, name: record.name, content: record.value, proxied: false as const, comment };
  });
  // DNS-only: a proxied CNAME would run educateos.io's zone first (Orange-to-Orange).
  return [{ type: "CNAME", name: claim.hostname, content: records.cnameTarget, proxied: false, comment }, ...txt];
}

/** Observes the managed zone and plans one claim's records. Read-only. */
export async function planManagedZone(api: CloudflareApi, claim: ManagedZoneClaim): Promise<ManagedZonePlan> {
  const want = desiredSpecs(claim);
  const comment = ownerComment(claim.instanceId);
  const observed = (await Promise.all(managedRecordNames(claim.hostname).map((name) =>
    guarded(() => api.listDnsRecords(claim.zoneId, name))))).flat();

  const steps: ManagedZoneStep[] = [];
  const unmatched = [...want];
  const stale: DnsRecord[] = [];
  for (const record of observed) {
    if (record.comment !== comment) {
      // Releasing never touches another owner's record; claiming refuses to share a name with one.
      if (claim.records) steps.push({ action: "refuse", record, reason: `${record.type} ${record.name} is not ${claim.instanceId}'s: the slug is taken` });
      continue;
    }
    const match = unmatched.findIndex((spec) => sameRecord(spec, record));
    if (match >= 0) unmatched.splice(match, 1);
    else stale.push(record);
  }
  for (const spec of unmatched) {
    // A changed value replaces the old record in place, so the CNAME never disappears.
    const replace = stale.findIndex((record) => record.type === spec.type && record.name === spec.name);
    if (replace >= 0) steps.push({ action: "update", recordId: stale.splice(replace, 1)[0]!.id, spec });
    else steps.push({ action: "create", spec });
  }
  for (const record of stale) steps.push({ action: "delete", record });
  return { claim, steps };
}

function sameRecord(spec: DnsRecordSpec, record: DnsRecord): boolean {
  return spec.type === record.type && spec.name === record.name && spec.content === record.content && spec.proxied === record.proxied;
}

/** Applies a managed zone plan. Refuses, before any change, a plan with a `refuse` step. */
export async function applyManagedZone(api: CloudflareApi, plan: ManagedZonePlan): Promise<number> {
  const refused = plan.steps.flatMap((s) => (s.action === "refuse" ? [s.reason] : []));
  if (refused.length > 0) throw new EducateOsError("conflict", `managed zone plan is blocked: ${refused.join("; ")}`);
  const { zoneId } = plan.claim;
  let changed = 0;
  for (const step of plan.steps) {
    if (step.action === "create") await guarded(() => api.createDnsRecord(zoneId, step.spec));
    else if (step.action === "update") await guarded(() => api.updateDnsRecord(zoneId, step.recordId, step.spec));
    else if (step.action === "delete") {
      try {
        await guarded(() => api.deleteDnsRecord(zoneId, step.record.id));
      } catch (error) {
        if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
      }
    }
    changed += 1;
  }
  return changed;
}
