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
  errors: z.array(z.object({ code: z.number() })).default([]),
  result: z.unknown(),
  result_info: z.object({
    page: z.number().optional(),
    total_pages: z.number().optional(),
    cursor: z.string().optional(),
  }).optional(),
});

const Id = z.object({ id: z.string() });
const Account = z.object({ id: z.string(), name: z.string() });
const SubscriptionWire = z.object({ rate_plan: z.object({ id: z.string() }).optional() });
const ZoneWire = z.object({ id: z.string(), name: z.string(), status: z.string() });
const DnsRecordWire = z.object({ id: z.string(), type: z.string(), name: z.string() });
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
  aud: z.string(),
  policies: z.array(z.object({ id: z.string() })).default([]),
});
const AssetsSessionWire = z.object({ jwt: z.string(), buckets: z.array(z.array(z.string())).default([]) });
const AssetsUploadWire = z.object({ jwt: z.string().optional() }).nullish();

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
    );
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
      return { id: item.id, createdOn: item.metadata.created_on, vars: plainTextVars(detail.resources.bindings) };
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
      response = await this.#fetch(url, { method, headers, body });
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

function toDomain(wire: z.infer<typeof DomainWire>): WorkerDomain {
  return { id: wire.id, hostname: wire.hostname, service: wire.service, zoneId: wire.zone_id };
}

function toPolicy(wire: z.infer<typeof PolicyWire>): AccessPolicy {
  const include = wire.include.flatMap((rule) => {
    const parsed = EmailDomainRuleWire.safeParse(rule);
    return parsed.success ? [{ email_domain: { domain: parsed.data.email_domain.domain } }] : [];
  });
  return { id: wire.id, name: wire.name, decision: wire.decision, include };
}

function toApp(wire: z.infer<typeof AppWire>): AccessApplication {
  return { id: wire.id, name: wire.name, domain: wire.domain, aud: wire.aud, policyIds: wire.policies.map((p) => p.id) };
}

function appBody(spec: AccessApplicationSpec) {
  return {
    name: spec.name,
    domain: spec.domain,
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
