// The district half of the managed default hostname, `<slug>.educateos.io` (ADR-0013 addendum A1;
// docs/educateos/spikes/managed-hostnames-cloudflare.md). Planning observes which path applies and
// lists the exact operations; applying runs them, with the district's credential, in the district's
// account. (The same-account path attaches a custom domain on the managed zone, which that account
// then holds.)
//
// - Same account (the managed zone is an active zone in the district's account, as for the demo): a
//   Workers custom domain on the router. Cloudflare creates its DNS record and certificate.
// - Cross account: a Cloudflare for SaaS custom hostname on the district's own zone, validated by
//   TXT, an originless fallback origin if the zone has none, and a hostname route to the router. The
//   managed zone then publishes the records from {@link managedHostnameRecords} (managed-zone.ts).
//
// Ownership is observed, not stored: a managed hostname is this instance's when it routes to this
// instance's router, whose Worker carries the instance marker.
import type { CloudflareApi, CustomHostname, ValidationRecord, WorkerDomain, Zone } from "./cloudflare-api.ts";
import type { DesiredManagedHostname } from "./desired.ts";
import { SAAS_NO_QUOTA_CODE } from "./cloudflare-http.ts";
import { CloudflareApiError } from "./errors.ts";
import { ownerComment } from "./managed-zone.ts";
import { guarded, type PlanAction } from "./plan.ts";
import { MANAGED_ZONE } from "./slug.ts";

/** One change to the district's account for its managed hostname. */
export type ManagedHostnameOp =
  | { op: "attach-domain"; hostname: string; zoneId: string }
  | { op: "detach-domain"; hostname: string; domainId: string }
  | { op: "create-origin-record"; zoneId: string; name: string }
  | { op: "set-fallback-origin"; zoneId: string; origin: string }
  | { op: "create-custom-hostname"; zoneId: string; hostname: string }
  | { op: "delete-custom-hostname"; zoneId: string; hostname: string; customHostnameId: string }
  | { op: "create-route"; zoneId: string; hostname: string }
  | { op: "delete-route"; zoneId: string; hostname: string; routeId: string };

/** The plan for one phase of the managed hostname: what to do and why. */
export interface ManagedHostnamePlan {
  action: PlanAction;
  reason: string;
  ops: ManagedHostnameOp[];
}

/** What planning has already observed, so the managed hostname adds no duplicate reads. */
export interface ManagedHostnameContext {
  accountId: string;
  instanceId: string;
  /** Every Workers custom domain in the account. */
  domains: WorkerDomain[];
  /** The district's own zone, if it is in the account. */
  zone: Zone | undefined;
}

/**
 * The records the managed zone publishes for a cross-account managed hostname: a DNS-only CNAME to
 * the district's fallback origin, and the TXT records that validate ownership and the certificate.
 */
export interface ManagedHostnameRecords {
  hostname: string;
  cnameTarget: string;
  txt: ValidationRecord[];
}

/** Whether a hostname is a managed hostname, a single label under {@link MANAGED_ZONE}. */
export function isManagedHostname(hostname: string): boolean {
  if (!hostname.endsWith(`.${MANAGED_ZONE}`)) return false;
  const label = hostname.slice(0, -(MANAGED_ZONE.length + 1));
  return label.length > 0 && !label.includes(".");
}

/** The Worker route pattern that sends a custom hostname to the router. */
export function managedRoutePattern(hostname: string): string {
  return `${hostname}/*`;
}

/**
 * The fallback origin record the installer creates on a zone that has none. It is originless
 * (`AAAA 100::`), as Cloudflare documents for a Worker origin: the route answers every request, and
 * a custom hostname without its route reaches nothing. Release leaves it, and the zone's fallback
 * origin, in place: both are inert, and another custom hostname on the zone may use them.
 */
export function originHostname(zoneName: string): string {
  return `educateos-origin.${zoneName}`;
}

const NONE: ManagedHostnamePlan = { action: "noop", reason: "no managed hostname to release", ops: [] };

/** Observes the account and plans one phase of the managed hostname. Read-only. */
export async function planManagedHostname(
  api: CloudflareApi,
  resource: DesiredManagedHostname,
  context: ManagedHostnameContext,
): Promise<ManagedHostnamePlan> {
  if (resource.phase === "release") return await planRelease(api, resource, context);
  if (resource.hostname === null) return NONE;
  return await planAttach(api, resource, resource.hostname, context);
}

/** The managed zone, when it is an active zone in the district's own account. */
async function sameAccountZone(api: CloudflareApi, accountId: string): Promise<Zone | undefined> {
  const zone = await guarded(() => api.findZone(accountId, MANAGED_ZONE));
  return zone?.status === "active" ? zone : undefined;
}

/**
 * A custom hostname, or `no-quota` when Cloudflare for SaaS has none allocated on the zone (code 1404,
 * which is also how a zone without SaaS answers, with HTTP 403, so it must not read as a credential
 * failure).
 */
async function findCustomHostname(api: CloudflareApi, zoneId: string, hostname: string): Promise<CustomHostname | undefined | "no-quota"> {
  try {
    return await api.findCustomHostname(zoneId, hostname);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.cloudflareCodes.includes(SAAS_NO_QUOTA_CODE)) return "no-quota";
    return await guarded(() => Promise.reject(error));
  }
}

/** Managed-hostname routes on the district's zone that run the router. */
async function managedRoutes(api: CloudflareApi, zoneId: string, scriptName: string) {
  const routes = await guarded(() => api.listWorkerRoutes(zoneId));
  return routes.flatMap((route) => {
    const hostname = route.pattern.endsWith("/*") ? route.pattern.slice(0, -2) : "";
    return route.script === scriptName && isManagedHostname(hostname) ? [{ id: route.id, hostname }] : [];
  });
}

/**
 * Releases every managed hostname on the router except the one the attach phase keeps, on whichever
 * path it is: a path is never switched implicitly, since a missed observation (a token that cannot
 * see the managed zone) must not tear down a working alias.
 */
async function planRelease(api: CloudflareApi, resource: DesiredManagedHostname, context: ManagedHostnameContext): Promise<ManagedHostnamePlan> {
  const keep = resource.hostname;
  const ops: ManagedHostnameOp[] = [];
  const released = new Set<string>();
  for (const domain of context.domains) {
    if (domain.service !== resource.scriptName || !isManagedHostname(domain.hostname) || domain.hostname === keep) continue;
    ops.push({ op: "detach-domain", hostname: domain.hostname, domainId: domain.id });
    released.add(domain.hostname);
  }
  const zoneId = context.zone?.id;
  if (zoneId) {
    for (const route of await managedRoutes(api, zoneId, resource.scriptName)) {
      if (route.hostname === keep) continue;
      // The route is how a custom hostname is found, so it is created first and deleted last: an
      // interruption always leaves it behind for the next run, and without it the hostname is inert.
      const custom = await findCustomHostname(api, zoneId, route.hostname);
      if (custom && custom !== "no-quota") ops.push({ op: "delete-custom-hostname", zoneId, hostname: route.hostname, customHostnameId: custom.id });
      ops.push({ op: "delete-route", zoneId, hostname: route.hostname, routeId: route.id });
      released.add(route.hostname);
    }
  }
  if (ops.length === 0) return NONE;
  return { action: "delete", reason: `releases ${[...released].toSorted().join(", ")} before the Access application drops it`, ops };
}

async function planAttach(
  api: CloudflareApi,
  resource: DesiredManagedHostname,
  hostname: string,
  context: ManagedHostnameContext,
): Promise<ManagedHostnamePlan> {
  const { scriptName } = resource;
  const refuse = (reason: string): ManagedHostnamePlan => ({ action: "refuse", reason, ops: [] });

  const managedZone = await sameAccountZone(api, context.accountId);
  if (managedZone) {
    const found = context.domains.find((d) => d.hostname === hostname);
    if (found) {
      return found.service === scriptName
        ? { action: "noop", reason: "custom domain attached", ops: [] }
        : refuse(`${hostname} routes to Worker ${found.service}: the slug is taken`);
    }
    const records = await guarded(() => api.listDnsRecords(managedZone.id, hostname));
    if (records.length > 0) return refuse(`${hostname} already has DNS records (${records.map((r) => r.type).join(", ")}): the slug is taken`);
    return { action: "create", reason: "custom domain not attached", ops: [{ op: "attach-domain", hostname, zoneId: managedZone.id }] };
  }

  if (!context.zone) return { action: "needs-input", reason: `add the zone ${resource.zoneName} to the account`, ops: [] };
  const zoneId = context.zone.id;
  const fallback = await guarded(() => api.getFallbackOrigin(zoneId));
  if (!fallback.saas) {
    return {
      action: "needs-input",
      reason: `enable Cloudflare for SaaS on ${resource.zoneName} (it needs a payment method; 100 custom hostnames are included)`,
      ops: [],
    };
  }
  const route = (await guarded(() => api.listWorkerRoutes(zoneId))).find((r) => r.pattern === managedRoutePattern(hostname));
  if (route && route.script !== scriptName) return refuse(`route ${route.pattern} runs ${route.script ?? "no Worker"}, not ${scriptName}`);

  const ops: ManagedHostnameOp[] = [];
  if (!fallback.origin) {
    const origin = originHostname(resource.zoneName);
    const existing = await guarded(() => api.listDnsRecords(zoneId, origin));
    if (existing.some((r) => r.comment !== ownerComment(context.instanceId))) return refuse(`${origin} has DNS records this instance did not create`);
    if (existing.length === 0) ops.push({ op: "create-origin-record", zoneId, name: origin });
    ops.push({ op: "set-fallback-origin", zoneId, origin });
  }
  const custom = await findCustomHostname(api, zoneId, hostname);
  if (custom === "no-quota") return { action: "needs-input", reason: `Cloudflare for SaaS has no custom hostname quota on ${resource.zoneName}`, ops: [] };
  if (!route) ops.push({ op: "create-route", zoneId, hostname });
  if (!custom) ops.push({ op: "create-custom-hostname", zoneId, hostname });
  if (!custom || ops.length > 0) return { action: custom ? "update" : "create", reason: "custom hostname, route or fallback origin missing", ops };
  if (custom.status === "active" && custom.sslStatus === "active") return { action: "noop", reason: "custom hostname active", ops: [] };
  return { action: "noop", reason: `custom hostname ${custom.status}, certificate ${custom.sslStatus}: publish its records in ${MANAGED_ZONE}`, ops: [] };
}

/** Runs a managed hostname plan's operations, in order, for the router's script. */
export async function applyManagedHostname(
  api: CloudflareApi,
  accountId: string,
  instanceId: string,
  scriptName: string,
  ops: ManagedHostnameOp[],
): Promise<void> {
  for (const op of ops) {
    switch (op.op) {
      case "attach-domain":
        await guarded(() => api.attachWorkerDomain(accountId, { hostname: op.hostname, service: scriptName, zoneId: op.zoneId }));
        break;
      case "detach-domain":
        await gone(() => api.detachWorkerDomain(accountId, op.domainId));
        break;
      case "create-origin-record":
        await guarded(() => api.createDnsRecord(op.zoneId, {
          type: "AAAA",
          name: op.name,
          content: "100::",
          proxied: true,
          comment: ownerComment(instanceId),
        }));
        break;
      case "set-fallback-origin":
        await guarded(() => api.setFallbackOrigin(op.zoneId, op.origin));
        break;
      case "create-custom-hostname":
        await guarded(() => api.createCustomHostname(op.zoneId, op.hostname));
        break;
      case "delete-custom-hostname":
        await gone(() => api.deleteCustomHostname(op.zoneId, op.customHostnameId));
        break;
      case "create-route":
        await guarded(() => api.createWorkerRoute(op.zoneId, managedRoutePattern(op.hostname), scriptName));
        break;
      case "delete-route":
        await gone(() => api.deleteWorkerRoute(op.zoneId, op.routeId));
        break;
    }
  }
}

/** A delete whose response was lost landed, so a 404 on the retry means done. */
async function gone(call: () => Promise<void>): Promise<void> {
  try {
    await guarded(call);
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
  }
}

/**
 * The records the managed zone must publish for a cross-account managed hostname, read from the
 * district's zone after an apply. Undefined until the custom hostname exists. Cloudflare may add
 * validation values only after creation, and issues new certificate values at each renewal, so the
 * managed zone re-reads them on a schedule.
 */
export async function managedHostnameRecords(api: CloudflareApi, zoneId: string, hostname: string): Promise<ManagedHostnameRecords | undefined> {
  const [custom, fallback] = await Promise.all([
    guarded(() => api.findCustomHostname(zoneId, hostname)),
    guarded(() => api.getFallbackOrigin(zoneId)),
  ]);
  if (!custom || !fallback.saas || !fallback.origin) return undefined;
  return {
    hostname,
    cnameTarget: fallback.origin,
    txt: [...(custom.ownership ? [custom.ownership] : []), ...custom.certificateValidation],
  };
}
