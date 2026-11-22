// The CloudflareApi port over `fetch` and api.cloudflare.com/client/v4. Responses are third-party
// shapes, so they are parsed with non-strict Zod objects: unknown fields are stripped, missing
// required ones fail. Every error is a CloudflareApiError carrying the operation, HTTP status and
// Cloudflare's numeric codes; the bearer token never appears in an error, a log line or a return
// value.
import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import type {
  AccessApplication,
  AccessApplicationSpec,
  AccessPolicy,
  AccessPolicySpec,
  AccessRule,
  CloudflareApi,
  CustomHostname,
  DataJurisdiction,
  DnsRecordSpec,
  FallbackOrigin,
  WorkerDomain,
  WorkerUpload,
} from "./cloudflare-api.ts";
import { CloudflareApiError, providerToken } from "./errors.ts";
import type { ModuleType } from "./manifest.ts";
import type { TokenProvider } from "./token.ts";

/** The Cloudflare API base URL. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

const Envelope = z.object({
  success: z.boolean(),
  // Some endpoints (Workers custom domains, for one) answer a success with `"errors": null`.
  errors: z.array(z.object({ code: z.number() })).nullish().transform((errors) => errors ?? []),
  // Error answers may leave `result` out entirely; their codes must still be read.
  result: z.unknown().optional(),
  result_info: z.object({
    page: z.number().optional(),
    total_pages: z.number().optional(),
    cursor: z.string().optional(),
  }).nullish(),
});

const Id = z.object({ id: z.string() });
const ProviderConfig = z.object({ id: z.string(), provider_slug: z.string(), alias: z.string(), secret_preview: z.string().nullish() });
/** The gateway settings an update sends back unchanged (the first five are required by the PUT). */
const GATEWAY_SETTINGS = [
  "cache_invalidate_on_update", "cache_ttl", "collect_logs", "rate_limiting_interval", "rate_limiting_limit",
  "authentication", "byok_only", "dlp", "guardrails", "log_classification", "log_management", "log_management_strategy",
  "logpush", "logpush_public_key", "multiprovider_enabled", "otel", "rate_limiting_technique", "retry_backoff",
  "retry_delay", "retry_max_attempts", "spend_limits", "workers_ai_billing_mode", "zdr",
] as const;
const StoreSecret = z.object({ id: z.string(), name: z.string() });
const providerKey = (config: z.infer<typeof ProviderConfig>) =>
  ({ id: config.id, providerSlug: config.provider_slug, alias: config.alias, secretPreview: config.secret_preview ?? undefined });
const Account = z.object({ id: z.string(), name: z.string() });
const SubscriptionWire = z.object({ rate_plan: z.object({ id: z.string() }).optional() });
const ZoneWire = z.object({ id: z.string(), name: z.string(), status: z.string() });
const DnsRecordWire = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().default(""),
  proxied: z.boolean().default(false),
  comment: z.string().nullish(),
});
const FallbackOriginWire = z.object({ origin: z.string().nullish() }).nullish();
const CustomHostnameWire = z.object({
  id: z.string(),
  hostname: z.string(),
  status: z.string(),
  ssl: z.object({
    status: z.string(),
    validation_records: z.array(z.object({ txt_name: z.string().optional(), txt_value: z.string().optional() })).default([]),
  }),
  ownership_verification: z.object({ type: z.string(), name: z.string(), value: z.string() }).optional(),
});
const RouteWire = z.object({ id: z.string(), pattern: z.string(), script: z.string().nullish() });
const ScriptWire = z.object({ id: z.string(), migration_tag: z.string().optional() });
const BindingWire = z.looseObject({ type: z.string(), name: z.string(), text: z.string().optional() });
const SettingsWire = z.object({ bindings: z.array(BindingWire).default([]) });
const SecretWire = z.object({ name: z.string() });
const SchedulesWire = z.object({ schedules: z.array(z.object({ cron: z.string() })).default([]) });
const VersionSummary = z.object({ id: z.string(), metadata: z.object({ created_on: z.string() }) });
const VersionDetail = z.object({ resources: z.object({ bindings: z.array(BindingWire).default([]) }) });
const DomainWire = z.object({ id: z.string(), hostname: z.string(), service: z.string(), zone_id: z.string() });
// A jurisdiction is listed for KV namespaces and D1 databases that have one (ADR-0015).
const withJurisdiction = <T extends { jurisdiction?: string | null }>({ jurisdiction, ...rest }: T) =>
  (jurisdiction ? { ...rest, jurisdiction } : rest);
const KvWire = z.object({ id: z.string(), title: z.string(), jurisdiction: z.string().nullish() }).transform(withJurisdiction);
const R2List = z.object({ buckets: z.array(z.object({ name: z.string() })).default([]) });
const D1Wire = z.object({ uuid: z.string(), name: z.string(), jurisdiction: z.string().nullish() }).transform(withJurisdiction);
const D1QueryWire = z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).default([]) }));
const OrganizationWire = z.object({ auth_domain: z.string() });
const IdpWire = z.object({ id: z.string(), name: z.string(), type: z.string() });
const EmailDomainRuleWire = z.object({ email_domain: z.object({ domain: z.string() }) });
const EmailRuleWire = z.object({ email: z.object({ email: z.string() }) });
const EveryoneRuleWire = z.object({ everyone: z.object({}) });
const PolicyWire = z.object({
  id: z.string(),
  name: z.string(),
  decision: z.string(),
  // Rules of other kinds are dropped; a policy with only those reads as admitting no domain.
  include: z.array(z.unknown()).default([]),
});
const AppWire = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().default(""),
  destinations: z.array(z.object({ type: z.string(), uri: z.string().optional() })).default([]),
  aud: z.string(),
  policies: z.array(z.object({ id: z.string() })).default([]),
});
const AssetsSessionWire = z.object({ jwt: z.string(), buckets: z.array(z.array(z.string())).default([]) });
const AssetsUploadWire = z.object({ jwt: z.string().optional() }).nullish();

/**
 * Cloudflare's code for "this feature is available with SSL for SaaS" on a zone without it. Reading
 * the fallback origin of educateos.io (a Free zone) returned it with HTTP 401 on 2026-10-25, so it is
 * checked before the status, which would otherwise read as a failed credential.
 */
export const SAAS_NOT_ENABLED_CODE = 1456;

/**
 * Cloudflare's "no quota has been allocated for this zone" (SSL for SaaS). Listing custom hostnames
 * on educateos.io, a zone without SaaS, returned it with HTTP 403 on 2026-10-25.
 */
export const SAAS_NO_QUOTA_CODE = 1404;

/** Cloudflare's code for "R2 is not enabled on this account". */
export const R2_NOT_ENABLED_CODE = 10042;

/**
 * Cloudflare's code on an HTTP 503 from creating an account's first AI Gateway (SCHO-440, 2026-11).
 * The same request succeeded a minute later, so it is read as transient.
 */
export const AI_GATEWAY_UNAVAILABLE_CODE = 7015;

/** How many times a transient failure is tried in all, and the first wait between tries. */
export const TRANSIENT_ATTEMPTS = 4;
const TRANSIENT_BASE_DELAY_MS = 3_000;
// A Retry-After longer than this is capped, so the whole retry stays near half a minute.
const TRANSIENT_MAX_DELAY_MS = 15_000;

/**
 * True for a failure worth trying again: any 5xx, a 429, or code 7015. Other 4xx answers (a bad
 * request, a missing permission) would fail the same way again.
 */
export function isTransientFailure(error: unknown): error is CloudflareApiError {
  if (!(error instanceof CloudflareApiError)) return false;
  return error.status >= 500 || error.status === 429 || error.cloudflareCodes.includes(AI_GATEWAY_UNAVAILABLE_CODE);
}

/** The wait before try `attempt + 1` (attempt counts from 1): Retry-After when sent, else 3 s, 6 s, 12 s. */
export function transientDelayMs(attempt: number, error: CloudflareApiError): number {
  const requested = error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1000;
  return Math.min(requested ?? TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1), TRANSIENT_MAX_DELAY_MS);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MIME_BY_MODULE_TYPE: Record<ModuleType, string> = {
  esm: "application/javascript+module",
  text: "text/plain",
  wasm: "application/wasm",
  data: "application/octet-stream",
};

/** What a {@link CloudflareHttpApi} needs. */
export interface CloudflareHttpApiOptions {
  tokens: TokenProvider;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Defaults to {@link CLOUDFLARE_API_BASE}. */
  baseUrl?: string;
  /** Waits between retries of a transient failure. Defaults to a timer; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

interface CallOptions {
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  /** Overrides the provider's token, for the assets upload, which authenticates with a session JWT. */
  bearer?: string;
  /** Request headers besides authorization and content type. */
  headers?: Record<string, string>;
  /**
   * Reads a 2xx with an empty body as success. `DELETE /workers/domains/{id}` answers that way: HTTP
   * 200 and no envelope (seen live on 2026-10-31, SCHO-66).
   */
  emptyBodyIsSuccess?: boolean;
}

/** The {@link CloudflareApi} port implemented against the real Cloudflare API. */
export class CloudflareHttpApi implements CloudflareApi {
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: CloudflareHttpApiOptions) {
    this.#tokens = options.tokens;
    // Called as `this.#fetch(...)`, the global fetch would get this client as its `this`, which
    // workerd refuses ("Illegal invocation"); bind it to the global object (SCHO-206).
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#base = options.baseUrl ?? CLOUDFLARE_API_BASE;
    this.#sleep = options.sleep ?? realSleep;
  }

  async getAccount(accountId: string) {
    return Account.parse(await this.#result("getAccount", "GET", `/accounts/${seg(accountId)}`));
  }

  async listSubscriptions(accountId: string) {
    const items = z.array(SubscriptionWire).parse(
      await this.#result("listSubscriptions", "GET", `/accounts/${seg(accountId)}/subscriptions`),
    );
    return items.flatMap((item) => (item.rate_plan ? [{ ratePlanId: item.rate_plan.id }] : []));
  }

  async findZone(accountId: string, name: string) {
    const zones = z.array(ZoneWire).parse(
      await this.#result("findZone", "GET", "/zones", { query: { name, "account.id": accountId } }),
    );
    return zones.find((zone) => zone.name === name);
  }

  async listDnsRecords(zoneId: string, name: string) {
    return z.array(DnsRecordWire).parse(
      await this.#result("listDnsRecords", "GET", `/zones/${seg(zoneId)}/dns_records`, { query: { name } }),
    ).map(toDnsRecord);
  }

  async createDnsRecord(zoneId: string, spec: DnsRecordSpec) {
    return toDnsRecord(DnsRecordWire.parse(
      await this.#result("createDnsRecord", "POST", `/zones/${seg(zoneId)}/dns_records`, { json: spec }),
    ));
  }

  async updateDnsRecord(zoneId: string, recordId: string, spec: DnsRecordSpec) {
    return toDnsRecord(DnsRecordWire.parse(
      await this.#result("updateDnsRecord", "PUT", `/zones/${seg(zoneId)}/dns_records/${seg(recordId)}`, { json: spec }),
    ));
  }

  async deleteDnsRecord(zoneId: string, recordId: string) {
    await this.#result("deleteDnsRecord", "DELETE", `/zones/${seg(zoneId)}/dns_records/${seg(recordId)}`);
  }

  async getFallbackOrigin(zoneId: string): Promise<FallbackOrigin> {
    try {
      const wire = FallbackOriginWire.parse(
        await this.#result("getFallbackOrigin", "GET", `/zones/${seg(zoneId)}/custom_hostnames/fallback_origin`),
      );
      return wire?.origin ? { saas: true, origin: wire.origin } : { saas: true };
    } catch (error) {
      if (error instanceof CloudflareApiError && error.cloudflareCodes.includes(SAAS_NOT_ENABLED_CODE)) return { saas: false };
      // A SaaS zone with no fallback origin answers 404 with code 1551 (hbtply.com, 2026-10-26);
      // 7003 is a missing zone.
      if (error instanceof CloudflareApiError && error.status === 404 && !error.cloudflareCodes.includes(7003)) return { saas: true };
      throw error;
    }
  }

  async setFallbackOrigin(zoneId: string, origin: string) {
    await this.#result("setFallbackOrigin", "PUT", `/zones/${seg(zoneId)}/custom_hostnames/fallback_origin`, { json: { origin } });
  }

  async findCustomHostname(zoneId: string, hostname: string) {
    const found = z.array(CustomHostnameWire).parse(
      await this.#result("findCustomHostname", "GET", `/zones/${seg(zoneId)}/custom_hostnames`, { query: { hostname } }),
    );
    const match = found.find((custom) => custom.hostname === hostname);
    return match ? toCustomHostname(match) : undefined;
  }

  async createCustomHostname(zoneId: string, hostname: string) {
    return toCustomHostname(CustomHostnameWire.parse(
      await this.#result("createCustomHostname", "POST", `/zones/${seg(zoneId)}/custom_hostnames`, {
        // TXT for both, so validation can finish before the managed zone's CNAME points here.
        json: { hostname, ssl: { method: "txt", type: "dv" } },
      }),
    ));
  }

  async deleteCustomHostname(zoneId: string, customHostnameId: string) {
    await this.#result("deleteCustomHostname", "DELETE", `/zones/${seg(zoneId)}/custom_hostnames/${seg(customHostnameId)}`);
  }

  async listWorkerRoutes(zoneId: string) {
    const routes = z.array(RouteWire).parse(await this.#result("listWorkerRoutes", "GET", `/zones/${seg(zoneId)}/workers/routes`));
    return routes.map((r) => ({ id: r.id, pattern: r.pattern, ...(r.script ? { script: r.script } : {}) }));
  }

  async createWorkerRoute(zoneId: string, pattern: string, script: string) {
    const route = RouteWire.parse(
      await this.#result("createWorkerRoute", "POST", `/zones/${seg(zoneId)}/workers/routes`, { json: { pattern, script } }),
    );
    return { id: route.id, pattern, script };
  }

  async deleteWorkerRoute(zoneId: string, routeId: string) {
    await this.#result("deleteWorkerRoute", "DELETE", `/zones/${seg(zoneId)}/workers/routes/${seg(routeId)}`);
  }

  async listWorkerScripts(accountId: string) {
    const scripts = z.array(ScriptWire).parse(
      await this.#result("listWorkerScripts", "GET", `/accounts/${seg(accountId)}/workers/scripts`),
    );
    return scripts.map((s) => ({ name: s.id, ...(s.migration_tag ? { migrationTag: s.migration_tag } : {}) }));
  }

  async getWorkerSettings(accountId: string, scriptName: string) {
    return SettingsWire.parse(
      await this.#result("getWorkerSettings", "GET", `${scriptPath(accountId, scriptName)}/settings`),
    );
  }

  async uploadWorkerScript(accountId: string, scriptName: string, upload: WorkerUpload) {
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(upload.metadata)], { type: "application/json" }));
    for (const module of upload.modules) {
      form.set(module.name, new Blob([module.bytes], { type: MIME_BY_MODULE_TYPE[module.type] }), module.name);
    }
    await this.#result("uploadWorkerScript", "PUT", scriptPath(accountId, scriptName), { form });
  }

  async deleteWorkerScript(accountId: string, scriptName: string) {
    await this.#result("deleteWorkerScript", "DELETE", scriptPath(accountId, scriptName));
  }

  async createAssetsUploadSession(accountId: string, scriptName: string, manifest: Record<string, { hash: string; size: number }>) {
    return AssetsSessionWire.parse(
      await this.#result("createAssetsUploadSession", "POST", `${scriptPath(accountId, scriptName)}/assets-upload-session`, {
        json: { manifest },
      }),
    );
  }

  async uploadAssets(accountId: string, sessionJwt: string, files: Map<string, Uint8Array<ArrayBuffer>>) {
    const form = new FormData();
    for (const [hash, bytes] of files) {
      form.set(hash, new Blob([toBase64(bytes)], { type: "application/null" }), hash);
    }
    const result = AssetsUploadWire.parse(
      await this.#result("uploadAssets", "POST", `/accounts/${seg(accountId)}/workers/assets/upload`, {
        query: { base64: "true" },
        form,
        bearer: sessionJwt,
      }),
    );
    return result?.jwt;
  }

  async deleteWorkerSecret(accountId: string, scriptName: string, name: string) {
    await this.#result("deleteWorkerSecret", "DELETE", `${scriptPath(accountId, scriptName)}/secrets/${seg(name)}`);
  }

  async listWorkerSecrets(accountId: string, scriptName: string) {
    const secrets = z.array(SecretWire).parse(
      await this.#result("listWorkerSecrets", "GET", `${scriptPath(accountId, scriptName)}/secrets`),
    );
    return secrets.map((s) => s.name);
  }

  async putWorkerSecret(accountId: string, scriptName: string, name: string, value: string) {
    await this.#result("putWorkerSecret", "PUT", `${scriptPath(accountId, scriptName)}/secrets`, {
      json: { name, text: value, type: "secret_text" },
    });
  }

  async getWorkerSchedules(accountId: string, scriptName: string) {
    const result = SchedulesWire.parse(
      await this.#result("getWorkerSchedules", "GET", `${scriptPath(accountId, scriptName)}/schedules`),
    );
    return result.schedules.map((s) => s.cron);
  }

  async putWorkerSchedules(accountId: string, scriptName: string, crons: string[]) {
    // The body is the whole list, which replaces the Worker's schedules (as `wrangler deploy` does).
    await this.#result("putWorkerSchedules", "PUT", `${scriptPath(accountId, scriptName)}/schedules`, {
      json: crons.map((cron) => ({ cron })),
    });
  }

  async listWorkerVersions(accountId: string, scriptName: string) {
    const list = z.object({ items: z.array(VersionSummary) }).parse(
      await this.#result("listWorkerVersions", "GET", `${scriptPath(accountId, scriptName)}/versions`),
    );
    // The installer's release markers are plain-text vars, which only the version detail carries.
    // Ten recent versions are enough to find the previous release's.
    return await Promise.all(list.items.slice(0, 10).map(async (item) => {
      const detail = VersionDetail.parse(
        await this.#result("listWorkerVersions", "GET", `${scriptPath(accountId, scriptName)}/versions/${seg(item.id)}`),
      );
      return {
        id: item.id,
        createdOn: item.metadata.created_on,
        vars: plainTextVars(detail.resources.bindings),
        serviceBindings: serviceBindings(detail.resources.bindings),
      };
    }));
  }

  async deployWorkerVersion(accountId: string, scriptName: string, versionId: string) {
    await this.#result("deployWorkerVersion", "POST", `${scriptPath(accountId, scriptName)}/deployments`, {
      json: { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] },
    });
  }

  async listWorkerDomains(accountId: string) {
    const domains = z.array(DomainWire).parse(
      await this.#result("listWorkerDomains", "GET", `/accounts/${seg(accountId)}/workers/domains`),
    );
    return domains.map(toDomain);
  }

  async attachWorkerDomain(accountId: string, domain: Omit<WorkerDomain, "id">) {
    return toDomain(DomainWire.parse(
      await this.#result("attachWorkerDomain", "PUT", `/accounts/${seg(accountId)}/workers/domains`, {
        json: { hostname: domain.hostname, service: domain.service, zone_id: domain.zoneId, environment: "production" },
      }),
    ));
  }

  async detachWorkerDomain(accountId: string, domainId: string) {
    await this.#result("detachWorkerDomain", "DELETE", `/accounts/${seg(accountId)}/workers/domains/${seg(domainId)}`, {
      emptyBodyIsSuccess: true,
    });
  }

  async listKvNamespaces(accountId: string) {
    return await this.#paged("listKvNamespaces", `/accounts/${seg(accountId)}/storage/kv/namespaces`, KvWire);
  }

  async createKvNamespace(accountId: string, title: string, jurisdiction?: DataJurisdiction) {
    return KvWire.parse(
      await this.#result("createKvNamespace", "POST", `/accounts/${seg(accountId)}/storage/kv/namespaces`, {
        json: { title, ...(jurisdiction ? { jurisdiction } : {}) },
      }),
    );
  }

  async deleteKvNamespace(accountId: string, namespaceId: string) {
    await this.#result("deleteKvNamespace", "DELETE", `/accounts/${seg(accountId)}/storage/kv/namespaces/${seg(namespaceId)}`);
  }

  async listR2Buckets(accountId: string, jurisdiction?: DataJurisdiction) {
    const buckets: { name: string }[] = [];
    let cursor: string | undefined;
    do {
      const envelope = await this.#envelope("listR2Buckets", "GET", `/accounts/${seg(accountId)}/r2/buckets`, {
        query: { per_page: "1000", ...(cursor ? { cursor } : {}) },
        headers: r2JurisdictionHeader(jurisdiction),
      });
      buckets.push(...R2List.parse(envelope.result).buckets);
      cursor = envelope.result_info?.cursor || undefined;
    } while (cursor);
    return buckets;
  }

  async createR2Bucket(accountId: string, name: string, jurisdiction?: DataJurisdiction) {
    await this.#result("createR2Bucket", "POST", `/accounts/${seg(accountId)}/r2/buckets`, {
      json: { name },
      headers: r2JurisdictionHeader(jurisdiction),
    });
    return { name };
  }

  async deleteR2Bucket(accountId: string, name: string, jurisdiction?: DataJurisdiction) {
    await this.#result("deleteR2Bucket", "DELETE", `/accounts/${seg(accountId)}/r2/buckets/${seg(name)}`, {
      headers: r2JurisdictionHeader(jurisdiction),
    });
  }

  async deleteR2Object(accountId: string, bucket: string, key: string, jurisdiction?: DataJurisdiction) {
    await this.#result("deleteR2Object", "DELETE", `/accounts/${seg(accountId)}/r2/buckets/${seg(bucket)}/objects/${seg(key)}`, {
      headers: r2JurisdictionHeader(jurisdiction),
    });
  }

  async listD1Databases(accountId: string) {
    return await this.#paged("listD1Databases", `/accounts/${seg(accountId)}/d1/database`, D1Wire);
  }

  async createD1Database(accountId: string, name: string, jurisdiction?: DataJurisdiction) {
    return D1Wire.parse(
      await this.#result("createD1Database", "POST", `/accounts/${seg(accountId)}/d1/database`, {
        json: { name, ...(jurisdiction ? { jurisdiction } : {}) },
      }),
    );
  }

  async queryD1(accountId: string, databaseId: string, sql: string, params: string[] = []) {
    const results = D1QueryWire.parse(
      await this.#result("queryD1", "POST", `/accounts/${seg(accountId)}/d1/database/${seg(databaseId)}/query`, {
        json: { sql, params },
      }),
    );
    return results.flatMap((r) => r.results);
  }

  async deleteD1Database(accountId: string, databaseId: string) {
    await this.#result("deleteD1Database", "DELETE", `/accounts/${seg(accountId)}/d1/database/${seg(databaseId)}`);
  }

  async getAccessOrganization(accountId: string) {
    try {
      const org = OrganizationWire.parse(
        await this.#result("getAccessOrganization", "GET", `/accounts/${seg(accountId)}/access/organizations`),
      );
      return { authDomain: org.auth_domain };
    } catch (error) {
      if (error instanceof CloudflareApiError && error.code === "not-found") return undefined;
      throw error;
    }
  }

  async listAccessIdentityProviders(accountId: string) {
    return z.array(IdpWire).parse(
      await this.#result("listAccessIdentityProviders", "GET", `/accounts/${seg(accountId)}/access/identity_providers`),
    );
  }

  async listAccessPolicies(accountId: string) {
    return (await this.#paged("listAccessPolicies", `/accounts/${seg(accountId)}/access/policies`, PolicyWire)).map(toPolicy);
  }

  async createAccessPolicy(accountId: string, spec: AccessPolicySpec) {
    return toPolicy(PolicyWire.parse(
      await this.#result("createAccessPolicy", "POST", `/accounts/${seg(accountId)}/access/policies`, { json: spec }),
    ));
  }

  async updateAccessPolicy(accountId: string, policyId: string, spec: AccessPolicySpec) {
    return toPolicy(PolicyWire.parse(
      await this.#result("updateAccessPolicy", "PUT", `/accounts/${seg(accountId)}/access/policies/${seg(policyId)}`, { json: spec }),
    ));
  }

  async deleteAccessPolicy(accountId: string, policyId: string) {
    await this.#result("deleteAccessPolicy", "DELETE", `/accounts/${seg(accountId)}/access/policies/${seg(policyId)}`);
  }

  async listAccessApplications(accountId: string) {
    return (await this.#paged("listAccessApplications", `/accounts/${seg(accountId)}/access/apps`, AppWire)).map(toApp);
  }

  async createAccessApplication(accountId: string, spec: AccessApplicationSpec) {
    return toApp(AppWire.parse(
      await this.#result("createAccessApplication", "POST", `/accounts/${seg(accountId)}/access/apps`, { json: appBody(spec) }),
    ));
  }

  async updateAccessApplication(accountId: string, appId: string, spec: AccessApplicationSpec) {
    return toApp(AppWire.parse(
      await this.#result("updateAccessApplication", "PUT", `/accounts/${seg(accountId)}/access/apps/${seg(appId)}`, {
        json: appBody(spec),
      }),
    ));
  }

  async deleteAccessApplication(accountId: string, appId: string) {
    await this.#result("deleteAccessApplication", "DELETE", `/accounts/${seg(accountId)}/access/apps/${seg(appId)}`);
  }

  async listAiGateways(accountId: string) {
    return await this.#paged("listAiGateways", `/accounts/${seg(accountId)}/ai-gateway/gateways`, Id);
  }

  async createAiGateway(accountId: string, gatewayId: string) {
    const create = async () => Id.parse(
      await this.#result("createAiGateway", "POST", `/accounts/${seg(accountId)}/ai-gateway/gateways`, {
        // Logging stays off: gateway logs would hold prompts. A district may turn it on itself.
        json: {
          id: gatewayId,
          collect_logs: false,
          cache_ttl: 0,
          cache_invalidate_on_update: false,
          rate_limiting_interval: 0,
          rate_limiting_limit: 0,
        },
      }),
    );
    for (let attempt = 1; ; attempt++) {
      try {
        return await create();
      } catch (error) {
        // A 5xx may still have created the gateway, so a retry refused with a 4xx checks for it.
        if (attempt > 1 && error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && !isTransientFailure(error)) {
          const existing = await this.listAiGateways(accountId).catch(() => []);
          if (existing.some((gateway) => gateway.id === gatewayId)) return { id: gatewayId };
        }
        if (!isTransientFailure(error) || attempt >= TRANSIENT_ATTEMPTS) throw error;
        await this.#sleep(transientDelayMs(attempt, error));
      }
    }
  }

  async listAiGatewayProviderKeys(accountId: string, gatewayId: string) {
    const keys = await this.#paged("listAiGatewayProviderKeys",
      `/accounts/${seg(accountId)}/ai-gateway/gateways/${seg(gatewayId)}/provider_configs`, ProviderConfig);
    return keys.map(providerKey);
  }

  async storeAiGatewayProviderKey(accountId: string, gatewayId: string, providerSlug: string, secret: string) {
    // Through the API the key goes into the gateway's Secrets Store first, as the secret
    // `<gateway>_<provider>_<alias>`, which is how the gateway finds it (code 7001 otherwise); the
    // provider config then references it. The key goes in request bodies only; #result never logs
    // or echoes a request body.
    const gatewayPath = `/accounts/${seg(accountId)}/ai-gateway/gateways/${seg(gatewayId)}`;
    const gateway = z.object({ store_id: z.string().nullish() }).passthrough().parse(await this.#result("getAiGateway", "GET", gatewayPath));
    if (!gateway.store_id) {
      throw new EducateOsError("conflict", `AI Gateway ${gatewayId} has no Secrets Store to keep the key in: attach one first`);
    }
    const secretsPath = `/accounts/${seg(accountId)}/secrets_store/stores/${seg(gateway.store_id)}/secrets`;
    const name = `${gatewayId}_${providerSlug}_default`;
    const found = z.array(StoreSecret).parse((await this.#envelope("listStoreSecrets", "GET", secretsPath,
      { query: { search: name, per_page: "100" } })).result ?? []).find((s) => s.name === name);
    let secretId: string;
    if (found) {
      // Left by a run that stopped before the provider config, which the caller checked is absent.
      await this.#result("putStoreSecret", "PATCH", `${secretsPath}/${seg(found.id)}`, { json: { value: secret, scopes: ["ai_gateway"] } });
      secretId = found.id;
    } else {
      const created = z.array(StoreSecret).parse(await this.#result("putStoreSecret", "POST", secretsPath,
        { json: [{ name, value: secret, scopes: ["ai_gateway"], comment: "AI Gateway provider key, stored by launch-educate-os" }] }));
      if (!created[0]) throw new EducateOsError("unavailable", "Secrets Store returned no secret");
      secretId = created[0].id;
    }
    return providerKey(ProviderConfig.parse(await this.#result("storeAiGatewayProviderKey", "POST", `${gatewayPath}/provider_configs`,
      { json: { provider_slug: providerSlug, alias: "default", default_config: true, secret_id: secretId } })));
  }

  async attachAiGatewayStore(accountId: string, gatewayId: string) {
    const path = `/accounts/${seg(accountId)}/ai-gateway/gateways/${seg(gatewayId)}`;
    const gateway = z.record(z.string(), z.unknown()).parse(await this.#result("getAiGateway", "GET", path));
    if (typeof gateway.store_id === "string" && gateway.store_id !== "") return { attached: false, storeCreated: false };
    const stores = await this.#paged("listSecretsStores", `/accounts/${seg(accountId)}/secrets_store/stores`, Id);
    let storeId = stores[0]?.id;
    const storeCreated = storeId === undefined;
    storeId ??= Id.parse(await this.#result("createSecretsStore", "POST", `/accounts/${seg(accountId)}/secrets_store/stores`,
      { json: { name: "default_secrets_store" } })).id;
    // The update is a PUT: send the gateway's settings back as read, so only store_id changes.
    const update: Record<string, unknown> = { store_id: storeId };
    for (const field of GATEWAY_SETTINGS) if (gateway[field] !== undefined && gateway[field] !== null) update[field] = gateway[field];
    await this.#result("attachAiGatewayStore", "PUT", path, { json: update });
    return { attached: true, storeCreated };
  }

  async deleteAiGateway(accountId: string, gatewayId: string) {
    await this.#result("deleteAiGateway", "DELETE", `/accounts/${seg(accountId)}/ai-gateway/gateways/${seg(gatewayId)}`);
  }

  async #paged<T extends z.ZodType>(operation: string, path: string, item: T): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    for (let page = 1; ; page++) {
      const envelope = await this.#envelope(operation, "GET", path, { query: { page: String(page), per_page: "100" } });
      out.push(...z.array(item).parse(envelope.result));
      const totalPages = envelope.result_info?.total_pages ?? 1;
      if (page >= totalPages) return out;
    }
  }

  async #result(operation: string, method: string, path: string, options: CallOptions = {}): Promise<unknown> {
    return (await this.#envelope(operation, method, path, options)).result;
  }

  async #envelope(operation: string, method: string, path: string, options: CallOptions) {
    const url = new URL(this.#base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const token = options.bearer ?? (await providerToken(this.#tokens, operation));
    const headers: Record<string, string> = { ...options.headers, authorization: `Bearer ${token}` };
    let body: RequestInit["body"];
    if (options.form) body = options.form;
    else if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    let response: Response;
    try {
      // Never follow a redirect: it could carry the Authorization header off api.cloudflare.com. A
      // 3xx has no JSON envelope, so it fails below like any other refusal.
      response = await this.#fetch(url, { method, headers, body, redirect: "manual" });
    } catch {
      throw new CloudflareApiError(operation, 0, []);
    }
    const text = await response.text().catch(() => "");
    if (response.ok && options.emptyBodyIsSuccess && text.trim() === "") return { success: true, errors: [], result: undefined };
    const parsed = Envelope.safeParse(parseJson(text));
    if (!response.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareApiError(
        operation,
        response.status,
        parsed.success ? parsed.data.errors.map((e) => e.code) : [],
        retryAfterSeconds(response.headers.get("retry-after")),
      );
    }
    return parsed.data;
  }
}

/** A `Retry-After` header in seconds; the HTTP-date form is read relative to now. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * R2's jurisdiction header. R2 scopes both listing and creating buckets by it; without it a call
 * sees only buckets with no jurisdiction.
 */
function r2JurisdictionHeader(jurisdiction: DataJurisdiction | undefined): Record<string, string> {
  return jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {};
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function scriptPath(accountId: string, scriptName: string): string {
  return `/accounts/${seg(accountId)}/workers/scripts/${seg(scriptName)}`;
}

function plainTextVars(bindings: z.infer<typeof BindingWire>[]): Record<string, string> {
  return Object.fromEntries(bindings.flatMap((b) => (b.type === "plain_text" && b.text !== undefined ? [[b.name, b.text]] : [])));
}

function serviceBindings(bindings: z.infer<typeof BindingWire>[]): { name: string; service: string }[] {
  return bindings.flatMap((b) => (b.type === "service" && typeof b.service === "string" ? [{ name: b.name, service: b.service }] : []));
}

function toDomain(wire: z.infer<typeof DomainWire>): WorkerDomain {
  return { id: wire.id, hostname: wire.hostname, service: wire.service, zoneId: wire.zone_id };
}

function toDnsRecord(wire: z.infer<typeof DnsRecordWire>) {
  return { id: wire.id, type: wire.type, name: wire.name, content: wire.content, proxied: wire.proxied, comment: wire.comment ?? "" };
}

function toCustomHostname(wire: z.infer<typeof CustomHostnameWire>): CustomHostname {
  return {
    id: wire.id,
    hostname: wire.hostname,
    status: wire.status,
    sslStatus: wire.ssl.status,
    ...(wire.ownership_verification ? { ownership: { name: wire.ownership_verification.name, value: wire.ownership_verification.value } } : {}),
    certificateValidation: wire.ssl.validation_records.flatMap((r) => (r.txt_name && r.txt_value ? [{ name: r.txt_name, value: r.txt_value }] : [])),
  };
}

function toPolicy(wire: z.infer<typeof PolicyWire>): AccessPolicy {
  const include = wire.include.flatMap((rule): AccessRule[] => {
    const parsed = EmailDomainRuleWire.safeParse(rule);
    if (parsed.success) return [{ email_domain: { domain: parsed.data.email_domain.domain } }];
    const email = EmailRuleWire.safeParse(rule);
    if (email.success) return [{ email: { email: email.data.email.email } }];
    return EveryoneRuleWire.safeParse(rule).success ? [{ everyone: {} }] : [];
  });
  return { id: wire.id, name: wire.name, decision: wire.decision, include };
}

function toApp(wire: z.infer<typeof AppWire>): AccessApplication {
  const destinations = wire.destinations.flatMap((d) => (d.type === "public" && d.uri ? [d.uri] : []));
  return {
    id: wire.id,
    name: wire.name,
    domain: wire.domain,
    destinations: destinations.length > 0 ? destinations : [wire.domain],
    aud: wire.aud,
    policyIds: wire.policies.map((p) => p.id),
  };
}

function appBody(spec: AccessApplicationSpec) {
  return {
    name: spec.name,
    domain: spec.domain,
    // Supersedes the deprecated self_hosted_domains. One application, so one audience for all.
    destinations: spec.destinations.map((uri) => ({ type: "public", uri })),
    type: spec.type,
    session_duration: spec.sessionDuration,
    policies: spec.policyIds.map((id, i) => ({ id, precedence: i + 1 })),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
