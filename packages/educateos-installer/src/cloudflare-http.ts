// The CloudflareApi port over `fetch` and api.cloudflare.com/client/v4. Responses are third-party
// shapes, so they are parsed with non-strict Zod objects: unknown fields are stripped, missing
// required ones fail. Every error is a CloudflareApiError carrying the operation, HTTP status and
// Cloudflare's numeric codes; the bearer token never appears in an error, a log line or a return
// value.
import { z } from "zod";
import type {
  AccessApplication,
  AccessApplicationSpec,
  AccessPolicy,
  AccessPolicySpec,
  CloudflareApi,
  CustomHostname,
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
const VersionSummary = z.object({ id: z.string(), metadata: z.object({ created_on: z.string() }) });
const VersionDetail = z.object({ resources: z.object({ bindings: z.array(BindingWire).default([]) }) });
const DomainWire = z.object({ id: z.string(), hostname: z.string(), service: z.string(), zone_id: z.string() });
const KvWire = z.object({ id: z.string(), title: z.string() });
const R2List = z.object({ buckets: z.array(z.object({ name: z.string() })).default([]) });
const D1Wire = z.object({ uuid: z.string(), name: z.string() });
const D1QueryWire = z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).default([]) }));
const OrganizationWire = z.object({ auth_domain: z.string() });
const IdpWire = z.object({ id: z.string(), name: z.string(), type: z.string() });
const EmailDomainRuleWire = z.object({ email_domain: z.object({ domain: z.string() }) });
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
}

interface CallOptions {
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  /** Overrides the provider's token, for the assets upload, which authenticates with a session JWT. */
  bearer?: string;
}

/** The {@link CloudflareApi} port implemented against the real Cloudflare API. */
export class CloudflareHttpApi implements CloudflareApi {
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: CloudflareHttpApiOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#base = options.baseUrl ?? CLOUDFLARE_API_BASE;
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
    await this.#result("detachWorkerDomain", "DELETE", `/accounts/${seg(accountId)}/workers/domains/${seg(domainId)}`);
  }

  async listKvNamespaces(accountId: string) {
    return await this.#paged("listKvNamespaces", `/accounts/${seg(accountId)}/storage/kv/namespaces`, KvWire);
  }

  async createKvNamespace(accountId: string, title: string) {
    return KvWire.parse(
      await this.#result("createKvNamespace", "POST", `/accounts/${seg(accountId)}/storage/kv/namespaces`, { json: { title } }),
    );
  }

  async listR2Buckets(accountId: string) {
    const buckets: { name: string }[] = [];
    let cursor: string | undefined;
    do {
      const envelope = await this.#envelope("listR2Buckets", "GET", `/accounts/${seg(accountId)}/r2/buckets`, {
        query: { per_page: "1000", ...(cursor ? { cursor } : {}) },
      });
      buckets.push(...R2List.parse(envelope.result).buckets);
      cursor = envelope.result_info?.cursor || undefined;
    } while (cursor);
    return buckets;
  }

  async createR2Bucket(accountId: string, name: string) {
    await this.#result("createR2Bucket", "POST", `/accounts/${seg(accountId)}/r2/buckets`, { json: { name } });
    return { name };
  }

  async listD1Databases(accountId: string) {
    return await this.#paged("listD1Databases", `/accounts/${seg(accountId)}/d1/database`, D1Wire);
  }

  async createD1Database(accountId: string, name: string) {
    return D1Wire.parse(
      await this.#result("createD1Database", "POST", `/accounts/${seg(accountId)}/d1/database`, { json: { name } }),
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

  async listAiGateways(accountId: string) {
    return await this.#paged("listAiGateways", `/accounts/${seg(accountId)}/ai-gateway/gateways`, Id);
  }

  async createAiGateway(accountId: string, gatewayId: string) {
    return Id.parse(
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
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
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
    const parsed = Envelope.safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareApiError(operation, response.status, parsed.success ? parsed.data.errors.map((e) => e.code) : []);
    }
    return parsed.data;
  }
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
  const include = wire.include.flatMap((rule) => {
    const parsed = EmailDomainRuleWire.safeParse(rule);
    return parsed.success ? [{ email_domain: { domain: parsed.data.email_domain.domain } }] : [];
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
