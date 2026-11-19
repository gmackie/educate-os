// An in-memory Cloudflare account implementing the CloudflareApi port, for tests and local
// harnesses. It enforces the constraints the reconciler depends on: unique names, service and
// storage bindings that must point at existing resources, Durable Object migration tags that must
// chain, versions that cannot be redeployed across a migration, and bearer tokens that can be
// revoked. Faults can be injected at the Nth mutation, with or without the effect landing. For the
// managed hostname it also models DNS records (a CNAME owns its name), Cloudflare for SaaS (off
// unless the zone is listed, TXT-validated custom hostnames) and zone Worker routes; see
// managed-hostname.ts for which of those behaviours are unverified on a real account.
import type {
  AccessApplication,
  AccessApplicationSpec,
  AccessIdentityProvider,
  AccessPolicy,
  AccessPolicySpec,
  CloudflareApi,
  CustomHostname,
  DataJurisdiction,
  DnsRecord,
  DnsRecordSpec,
  ObservedBinding,
  WorkerRoute,
  WorkerDomain,
  WorkerUpload,
} from "./cloudflare-api.ts";
import { R2_NOT_ENABLED_CODE } from "./cloudflare-http.ts";
import { MARKER_VARS } from "./desired.ts";
import { CloudflareApiError, providerToken } from "./errors.ts";
import type { TokenProvider } from "./token.ts";

/** How a {@link FakeCloudflare} account starts out. */
export interface FakeAccountOptions {
  accountId: string;
  /** Rate plan IDs. Defaults to Workers Paid plus a paid Zero Trust plan. */
  ratePlans?: string[];
  /** Defaults to true. */
  r2Enabled?: boolean;
  /** The Zero Trust team, or null for an account that never set up Zero Trust. */
  accessTeam: string | null;
  /** Defaults to one-time PIN plus one OIDC provider. */
  identityProviders?: Omit<AccessIdentityProvider, "id">[];
  /** Zones in the account. Status defaults to `active`. */
  zones?: { name: string; status?: string }[];
  /** DNS records already present, by full name. */
  dnsRecords?: { name: string; type: string; content?: string; comment?: string }[];
  /** Zones with Cloudflare for SaaS enabled, by name. */
  saasZones?: string[];
}

/** One recorded port call. */
export interface FakeCall {
  operation: string;
  mutation: boolean;
  outcome: "ok" | "rejected" | "interrupted" | "failed";
}

interface Version {
  id: string;
  createdOn: string;
  bindings: ObservedBinding[];
  migrationTag?: string;
}

interface Script {
  versions: Version[];
  activeVersionId: string;
  migrationTag?: string;
  secrets: Map<string, string>;
  assetsConfig?: Record<string, unknown>;
  /** The paths of the static assets the last upload that carried assets serves, sorted. */
  assetPaths?: string[];
  /** Cron Triggers. Not versioned: an upload or a rollback leaves them as they are. */
  schedules: string[];
}

const MUTATIONS = new Set([
  "uploadWorkerScript", "deleteWorkerScript", "createAssetsUploadSession", "uploadAssets", "putWorkerSecret", "putWorkerSchedules", "deployWorkerVersion",
  "attachWorkerDomain", "createKvNamespace", "createR2Bucket", "createD1Database", "createAccessPolicy",
  "updateAccessPolicy", "createAccessApplication", "updateAccessApplication", "createAiGateway",
  "createDnsRecord", "updateDnsRecord", "deleteDnsRecord", "setFallbackOrigin", "createCustomHostname",
  "deleteCustomHostname", "createWorkerRoute", "deleteWorkerRoute", "detachWorkerDomain", "deleteWorkerSecret",
  "deleteKvNamespace", "deleteR2Bucket", "deleteD1Database", "deleteAccessPolicy", "deleteAccessApplication", "deleteAiGateway",
  "storeAiGatewayProviderKey",
]);

const LEDGER_INSERT = /INSERT INTO _educateos_migrations \(id, sha256\) VALUES \('([0-9a-z_]+)', '[0-9a-f]{64}'\)\s*$/;

/** An in-memory Cloudflare account. Hand out an API per credential with {@link FakeCloudflare.api}. */
export class FakeCloudflare {
  /** Every port call, in order. */
  readonly calls: FakeCall[] = [];
  /** Runs before each mutation is checked or applied, e.g. to revoke a token mid-run. */
  beforeMutation?: (operation: string, ordinal: number) => void;

  readonly #options: FakeAccountOptions;
  readonly #tokens = new Set<string>();
  readonly #scripts = new Map<string, Script>();
  readonly #domains = new Map<string, WorkerDomain>();
  readonly #kv = new Map<string, { id: string; jurisdiction?: string }>();
  /** R2 buckets, as `<jurisdiction>/<name>`: R2 names buckets per jurisdiction (`default` for none). */
  readonly #r2 = new Set<string>();
  /** How many objects each R2 bucket holds, by the same key. Absent means empty. */
  readonly #r2Objects = new Map<string, number>();
  readonly #d1 = new Map<string, { uuid: string; jurisdiction?: string; ledger: Set<string> | undefined; statements: string[] }>();
  readonly #policies = new Map<string, AccessPolicy>();
  readonly #apps = new Map<string, AccessApplication>();
  readonly #gateways = new Set<string>();
  /** Stored provider keys, by `<gateway>/<provider>`: the default alias only, as the installer stores them. */
  readonly #providerKeys = new Map<string, { id: string; secret: string }>();
  readonly #assets = new Set<string>();
  readonly #assetSessions = new Map<string, { pending: Set<string>; paths: string[] }>();
  /** Completion tokens an upload may carry, each with the asset paths its session was for. */
  readonly #completions = new Map<string, string[]>();
  readonly #dns = new Map<string, DnsRecord & { zoneId: string }>();
  readonly #fallbackOrigins = new Map<string, string>();
  readonly #customHostnames = new Map<string, CustomHostname & { zoneId: string }>();
  readonly #routes = new Map<string, WorkerRoute & { zoneId: string }>();
  #nextId = 1;
  #mutations = 0;
  #fault: { at: number; effectApplied: boolean } | undefined;

  constructor(options: FakeAccountOptions) {
    this.#options = options;
    for (const record of options.dnsRecords ?? []) {
      const id = `dns-${this.#id()}`;
      const zoneId = this.#zone(record.name)?.id ?? "zone-unknown";
      this.#dns.set(id, { id, zoneId, type: record.type, name: record.name, content: record.content ?? "", proxied: false, comment: record.comment ?? "" });
    }
  }

  /** Mints a valid bearer token, like creating an API token or completing an OAuth grant. */
  issueToken(): string {
    const token = `fake-token-${this.#id()}-${crypto.randomUUID()}`;
    this.#tokens.add(token);
    return token;
  }

  /** Revokes a token. Later calls with it fail as Cloudflare fails a revoked credential. */
  revokeToken(token: string): void {
    this.#tokens.delete(token);
  }

  /**
   * Fails the `ordinal`-th mutation from now (1 = the next one) as a dropped connection. With
   * `effectApplied`, the change lands first and only the response is lost.
   */
  interruptMutation(ordinal: number, options: { effectApplied: boolean }): void {
    this.#fault = { at: this.#mutations + ordinal, effectApplied: options.effectApplied };
  }

  /** The port, authenticated by whatever token the provider supplies on each call. */
  api(tokens: TokenProvider): CloudflareApi {
    return new FakeCloudflareApi(this, tokens);
  }

  /**
   * What a hostname this account terminates serves right now: the Worker and its active release.
   * That is a custom domain, or an active custom hostname with a route for it on the same zone.
   */
  serving(hostname: string): { scriptName: string; releaseId: string | undefined } | undefined {
    const custom = [...this.#customHostnames.values()]
      .find((c) => c.hostname === hostname && c.status === "active" && c.sslStatus === "active");
    const route = custom && [...this.#routes.values()].find((r) => r.zoneId === custom.zoneId && r.pattern === `${hostname}/*`);
    // Without its route, an active custom hostname is proxied to the zone's fallback origin.
    const origin = custom && !route ? this.#fallbackOrigins.get(custom.zoneId) : undefined;
    const service = this.#domains.get(hostname)?.service ?? route?.script ?? (origin ? this.#domains.get(origin)?.service : undefined);
    const script = service && this.#scripts.get(service);
    if (!service || !script) return undefined;
    return { scriptName: service, releaseId: varOf(activeVersion(script), MARKER_VARS.release) };
  }

  /** Every DNS record, as the zone's resolver would answer. */
  dnsRecords(): DnsRecord[] {
    return [...this.#dns.values()].map(({ zoneId: _zoneId, ...record }) => record);
  }

  /**
   * Validates pending custom hostnames against TXT values published elsewhere (the managed zone's
   * account), as Cloudflare's checks would: ownership, then the certificate.
   */
  validateCustomHostnames(publishedTxt: (name: string) => string[]): void {
    for (const custom of this.#customHostnames.values()) {
      if (custom.ownership && publishedTxt(custom.ownership.name).includes(custom.ownership.value)) {
        delete custom.ownership;
        custom.status = "active";
      }
      if (custom.certificateValidation.length > 0 && custom.certificateValidation.every((r) => publishedTxt(r.name).includes(r.value))) {
        custom.certificateValidation = [];
        custom.sslStatus = "active";
      }
    }
  }

  /** How many of each resource kind exist, for duplicate checks. */
  /** The provider key a gateway holds for a provider, for tests that check what was stored. */
  storedProviderKey(gatewayId: string, providerSlug: string): string | undefined {
    return this.#providerKeys.get(`${gatewayId}/${providerSlug}`)?.secret;
  }

  inventory() {
    return {
      workers: this.#scripts.size,
      kvNamespaces: this.#kv.size,
      r2Buckets: this.#r2.size,
      d1Databases: this.#d1.size,
      accessPolicies: this.#policies.size,
      accessApplications: this.#apps.size,
      aiGateways: this.#gateways.size,
      domains: this.#domains.size,
      customHostnames: this.#customHostnames.size,
      workerRoutes: this.#routes.size,
      secrets: [...this.#scripts.values()].reduce((n, s) => n + s.secrets.size, 0),
    };
  }

  /** A Worker's secret names and active release, for assertions. */
  worker(name: string) {
    const script = this.#scripts.get(name);
    if (!script) return undefined;
    const active = activeVersion(script);
    return {
      secretNames: [...script.secrets.keys()].toSorted(),
      releaseId: varOf(active, MARKER_VARS.release),
      migrationTag: script.migrationTag,
      versions: script.versions.length,
      bindings: active.bindings,
      schedules: [...script.schedules],
      /** The static-assets config of the last upload that carried assets. */
      assetsConfig: script.assetsConfig,
      /** The paths of the static assets that upload serves. */
      assetPaths: script.assetPaths,
    };
  }

  /**
   * What a Worker's static assets answer for `path`, as Cloudflare routes it: the asset's path, or
   * undefined when the Worker runs instead (a `run_worker_first` pattern, or no asset and no
   * single-page fallback). `/dir/` serves `/dir/index.html`, and a single-page app's fallback is its
   * root `/index.html`. Patterns are exact or end in `*`, the only forms the installer sends.
   */
  assetFor(name: string, path: string): string | undefined {
    const script = this.#scripts.get(name);
    if (!script?.assetPaths) return undefined;
    const config = script.assetsConfig as { not_found_handling?: string; run_worker_first?: string[] | boolean } | undefined;
    const first = config?.run_worker_first;
    if (first === true) return undefined;
    if (Array.isArray(first) && first.some((p) => p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : p === path)) return undefined;
    const candidate = path.endsWith("/") ? `${path}index.html` : path;
    if (script.assetPaths.includes(candidate)) return candidate;
    return config?.not_found_handling === "single-page-application" && script.assetPaths.includes("/index.html") ? "/index.html" : undefined;
  }

  /** A Worker secret's value, for assertions about generated secrets. Cloudflare never returns one. */
  secretValue(name: string, secret: string): string | undefined {
    return this.#scripts.get(name)?.secrets.get(secret);
  }

  /** The jurisdictions of the R2 buckets of one name (`default` for none), for assertions. */
  r2Jurisdictions(name: string): string[] {
    return [...this.#r2].flatMap((key) => (key.endsWith(`/${name}`) ? [key.slice(0, key.indexOf("/"))] : [])).toSorted();
  }

  /** Adds an R2 bucket the installer did not create, in a jurisdiction or in none. */
  seedR2Bucket(name: string, jurisdiction?: string): void {
    this.#r2.add(r2Key(name, jurisdiction));
  }

  /**
   * Puts `count` objects in an R2 bucket, as the district's own Workers would. The installer has no
   * object operation, so only a test (standing in for the operator) can add or remove them.
   */
  putR2Objects(name: string, count: number, jurisdiction?: string): void {
    if (!this.#r2.has(r2Key(name, jurisdiction))) throw new Error(`no R2 bucket ${name}`);
    this.#r2Objects.set(r2Key(name, jurisdiction), count);
  }

  /** Empties an R2 bucket, as an operator's lifecycle rule or dashboard deletion would. */
  emptyR2Bucket(name: string, jurisdiction?: string): void {
    this.#r2Objects.delete(r2Key(name, jurisdiction));
  }

  /** Adds a KV namespace the installer did not create. */
  seedKvNamespace(title: string): void {
    this.#kv.set(title, { id: `kv-${this.#id()}` });
  }

  /** Adds an Access policy the installer did not create, admitting one email domain. */
  seedAccessPolicy(name: string, domain = "example.org"): string {
    const id = `pol-${this.#id()}`;
    this.#policies.set(id, { id, name, decision: "allow", include: [{ email_domain: { domain } }] });
    return id;
  }

  /** Every DNS record's name and comment, for assertions about what the installer leaves. */
  dnsNames(): string[] {
    return [...this.#dns.values()].map((r) => r.name).toSorted();
  }

  /** A KV namespace's jurisdiction, for assertions; undefined for none or no such namespace. */
  kvJurisdiction(title: string): string | undefined {
    return this.#kv.get(title)?.jurisdiction;
  }

  /** A D1 database's jurisdiction, for assertions; undefined for none or no such database. */
  d1Jurisdiction(name: string): string | undefined {
    return this.#d1.get(name)?.jurisdiction;
  }

  /** Statements a D1 database has run, in order. */
  d1Statements(name: string): string[] {
    return [...(this.#d1.get(name)?.statements ?? [])];
  }

  /** Adds a Worker the installer did not create, with the given plain-text vars. */
  seedWorker(name: string, vars: Record<string, string> = {}): void {
    const bindings = Object.entries(vars).map(([k, text]) => ({ type: "plain_text", name: k, text }));
    const version = { id: this.#id(), createdOn: this.#timestamp(), bindings };
    this.#scripts.set(name, { versions: [version], activeVersionId: version.id, secrets: new Map(), schedules: [] });
  }

  /** Replaces a Worker's Cron Triggers, as a dashboard edit would. */
  editWorkerSchedules(name: string, crons: string[]): void {
    const script = this.#scripts.get(name);
    if (!script) throw new Error(`no Worker ${name}`);
    script.schedules = [...crons];
  }

  /**
   * Deploys a new version of a Worker with edited bindings, as a dashboard edit would: the
   * installer's marker vars, including its digest, survive unchanged.
   */
  editWorkerBindings(name: string, edit: (bindings: ObservedBinding[]) => ObservedBinding[]): void {
    const script = this.#scripts.get(name);
    if (!script) throw new Error(`no Worker ${name}`);
    this.#addVersion(script, edit(activeVersion(script).bindings.map((b) => ({ ...b }))), script.migrationTag);
  }

  /**
   * Adds a Worker deployed outside the installer, as a Wrangler deploy leaves one: its secrets, and
   * the Durable Object migration tag it reached.
   */
  seedDeployedWorker(name: string, options: { vars?: Record<string, string>; secrets?: Record<string, string>; migrationTag?: string }): void {
    this.seedWorker(name, options.vars);
    const script = this.#scripts.get(name)!;
    for (const [secret, value] of Object.entries(options.secrets ?? {})) script.secrets.set(secret, value);
    if (options.migrationTag) {
      script.migrationTag = options.migrationTag;
      activeVersion(script).migrationTag = options.migrationTag;
    }
  }

  /** Adds an Access application the installer did not create. */
  seedAccessApplication(name: string, domain: string): void {
    const id = this.#id();
    this.#apps.set(id, { id, name, domain, destinations: [domain], aud: `aud-${id}`, policyIds: [] });
  }

  /** An Access application's protected hostnames, for assertions. */
  accessApplication(name: string): { destinations: string[]; aud: string } | undefined {
    const app = [...this.#apps.values()].find((a) => a.name === name);
    return app && { destinations: [...app.destinations], aud: app.aud };
  }

  /** Adds a Worker route the installer did not create. */
  seedWorkerRoute(zoneName: string, pattern: string, script: string): void {
    const zoneId = this.#zones().find((z) => z.name === zoneName)!.id;
    const id = `route-${this.#id()}`;
    this.#routes.set(id, { id, zoneId, pattern, script });
  }

  /** Adds a Worker custom domain the installer did not create. */
  seedWorkerDomain(hostname: string, service: string): void {
    this.#domains.set(hostname, { id: this.#id(), hostname, service, zoneId: this.#zone(hostname)?.id ?? "zone-unknown" });
  }

  /** @internal Authenticates, records and runs one port call. */
  async call<T>(tokens: TokenProvider, accountId: string | undefined, operation: string, run: () => T): Promise<T> {
    const mutation = MUTATIONS.has(operation);
    if (mutation) this.beforeMutation?.(operation, this.#mutations + 1);
    let token: string;
    try {
      token = await providerToken(tokens, operation);
    } catch (error) {
      this.calls.push({ operation, mutation, outcome: "rejected" });
      throw error;
    }
    if (!this.#tokens.has(token)) {
      this.calls.push({ operation, mutation, outcome: "rejected" });
      throw new CloudflareApiError(operation, 401, [9109]);
    }
    if (accountId !== undefined && accountId !== this.#options.accountId) {
      this.calls.push({ operation, mutation, outcome: "rejected" });
      throw new CloudflareApiError(operation, 403, [10000]);
    }
    if (mutation) {
      this.#mutations += 1;
      const fault = this.#fault;
      if (fault && fault.at === this.#mutations) {
        this.#fault = undefined;
        if (fault.effectApplied) {
          try {
            run();
          } catch {
            // The effect failing as well changes nothing about the dropped response.
          }
        }
        this.calls.push({ operation, mutation, outcome: "interrupted" });
        throw new CloudflareApiError(operation, 0, []);
      }
    }
    try {
      const result = run();
      this.calls.push({ operation, mutation, outcome: "ok" });
      return result;
    } catch (error) {
      this.calls.push({ operation, mutation, outcome: "failed" });
      throw error;
    }
  }

  // The operations, unauthenticated; FakeCloudflareApi wraps each in call().

  /** @internal */ op = {
    account: () => ({ id: this.#options.accountId, name: "Synthetic district account" }),
    subscriptions: () => (this.#options.ratePlans ?? ["workers_paid", "teams_standard"]).map((ratePlanId) => ({ ratePlanId })),
    findZone: (name: string) => this.#zones().find((z) => z.name === name),
    dnsRecords: (zoneId: string, name: string) =>
      [...this.#dns.values()].filter((r) => r.zoneId === zoneId && r.name === name).map(({ zoneId: _zoneId, ...r }) => r),
    putDns: (zoneId: string, id: string | undefined, spec: DnsRecordSpec) => {
      const operation = id === undefined ? "createDnsRecord" : "updateDnsRecord";
      if (!this.#zones().some((z) => z.id === zoneId)) throw new CloudflareApiError(operation, 404, [7003]);
      if (id !== undefined && this.#dns.get(id)?.zoneId !== zoneId) throw new CloudflareApiError(operation, 404, [81044]);
      const others = [...this.#dns.values()].filter((r) => r.zoneId === zoneId && r.name === spec.name && r.id !== id);
      // A CNAME owns its name: it cannot share it with any other record (Cloudflare code 81053).
      if (others.length > 0 && (spec.type === "CNAME" || others.some((r) => r.type === "CNAME"))) {
        throw new CloudflareApiError(operation, 400, [81053]);
      }
      if (others.some((r) => r.type === spec.type && r.content === spec.content)) throw new CloudflareApiError(operation, 400, [81058]);
      const record = { id: id ?? `dns-${this.#id()}`, zoneId, ...spec };
      this.#dns.set(record.id, record);
      const { zoneId: _zoneId, ...observed } = record;
      return observed;
    },
    deleteDns: (zoneId: string, id: string) => {
      if (this.#dns.get(id)?.zoneId !== zoneId) throw new CloudflareApiError("deleteDnsRecord", 404, [81044]);
      this.#dns.delete(id);
    },
    fallbackOrigin: (zoneId: string) => {
      if (!this.#saas(zoneId)) return { saas: false as const };
      const origin = this.#fallbackOrigins.get(zoneId);
      return origin ? { saas: true as const, origin } : { saas: true as const };
    },
    setFallbackOrigin: (zoneId: string, origin: string) => {
      if (!this.#saas(zoneId)) throw new CloudflareApiError("setFallbackOrigin", 400, [1456]);
      // The origin must be a proxied record on the zone.
      const onZone = [...this.#dns.values()].some((r) => r.zoneId === zoneId && r.name === origin && r.proxied);
      if (!onZone) throw new CloudflareApiError("setFallbackOrigin", 400, [1400]);
      this.#fallbackOrigins.set(zoneId, origin);
    },
    findCustomHostname: (zoneId: string, hostname: string) => {
      if (!this.#saas(zoneId)) throw new CloudflareApiError("findCustomHostname", 403, [1404]);
      const found = [...this.#customHostnames.values()].find((c) => c.zoneId === zoneId && c.hostname === hostname);
      return found && withoutZone(found);
    },
    createCustomHostname: (zoneId: string, hostname: string) => {
      if (!this.#saas(zoneId)) throw new CloudflareApiError("createCustomHostname", 400, [1456]);
      const zone = this.#zones().find((z) => z.id === zoneId)!;
      if (hostname === zone.name || hostname.endsWith(`.${zone.name}`)) throw new CloudflareApiError("createCustomHostname", 400, [1414]);
      if ([...this.#customHostnames.values()].some((c) => c.hostname === hostname)) throw new CloudflareApiError("createCustomHostname", 409, [1406]);
      const id = `ch-${this.#id()}`;
      const custom = {
        id,
        zoneId,
        hostname,
        status: "pending",
        sslStatus: "pending_validation",
        ownership: { name: `_cf-custom-hostname.${hostname}`, value: crypto.randomUUID() },
        certificateValidation: [{ name: `_acme-challenge.${hostname}`, value: crypto.randomUUID() }],
      };
      this.#customHostnames.set(id, custom);
      return withoutZone(custom);
    },
    deleteCustomHostname: (zoneId: string, id: string) => {
      if (this.#customHostnames.get(id)?.zoneId !== zoneId) throw new CloudflareApiError("deleteCustomHostname", 404, [1436]);
      this.#customHostnames.delete(id);
    },
    routes: (zoneId: string) =>
      [...this.#routes.values()].filter((r) => r.zoneId === zoneId).map(({ zoneId: _zoneId, ...r }) => r),
    createRoute: (zoneId: string, pattern: string, script: string) => {
      if (!this.#zones().some((z) => z.id === zoneId)) throw new CloudflareApiError("createWorkerRoute", 404, [7003]);
      if (!this.#scripts.has(script)) throw new CloudflareApiError("createWorkerRoute", 400, [10019]);
      if ([...this.#routes.values()].some((r) => r.zoneId === zoneId && r.pattern === pattern)) {
        throw new CloudflareApiError("createWorkerRoute", 409, [10020]);
      }
      const id = `route-${this.#id()}`;
      this.#routes.set(id, { id, zoneId, pattern, script });
      return { id, pattern, script };
    },
    deleteRoute: (zoneId: string, id: string) => {
      if (this.#routes.get(id)?.zoneId !== zoneId) throw new CloudflareApiError("deleteWorkerRoute", 404, [10021]);
      this.#routes.delete(id);
    },
    detachDomain: (id: string) => {
      const domain = [...this.#domains.values()].find((d) => d.id === id);
      if (!domain) throw new CloudflareApiError("detachWorkerDomain", 404, [100116]);
      this.#domains.delete(domain.hostname);
    },
    scripts: () => [...this.#scripts].map(([name, s]) => ({ name, ...(s.migrationTag ? { migrationTag: s.migrationTag } : {}) })),
    settings: (name: string) => {
      const script = this.#script(name, "getWorkerSettings");
      const secrets = [...script.secrets.keys()].map((n) => ({ type: "secret_text", name: n }));
      return { bindings: [...activeVersion(script).bindings, ...secrets] };
    },
    upload: (name: string, upload: WorkerUpload) => this.#upload(name, upload),
    deleteScript: (name: string) => {
      this.#script(name, "deleteWorkerScript");
      // Without force, Cloudflare refuses to delete a Worker another Worker's deployed version binds
      // (HTTP 400, code 10142), but deletes one a custom domain routes to, and the domain with it
      // (both seen live on 2026-10-31, SCHO-66).
      const boundBy = [...this.#scripts].some(([other, script]) =>
        other !== name && activeVersion(script).bindings.some((b) => b.type === "service" && b.service === name));
      if (boundBy) throw new CloudflareApiError("deleteWorkerScript", 400, [10142]);
      for (const [hostname, domain] of this.#domains) if (domain.service === name) this.#domains.delete(hostname);
      this.#scripts.delete(name);
    },
    assetsSession: (manifest: Record<string, { hash: string; size: number }>) => {
      const pending = new Set(Object.values(manifest).map((e) => e.hash).filter((h) => !this.#assets.has(h)));
      const jwt = `assets-session-${this.#id()}`;
      const paths = Object.keys(manifest).toSorted();
      this.#assetSessions.set(jwt, { pending, paths });
      if (pending.size === 0) this.#completions.set(jwt, paths);
      return { jwt, buckets: pending.size > 0 ? [[...pending].toSorted()] : [] };
    },
    uploadAssets: (jwt: string, files: Map<string, Uint8Array<ArrayBuffer>>) => {
      const session = this.#assetSessions.get(jwt);
      if (!session) throw new CloudflareApiError("uploadAssets", 401, []);
      for (const hash of files.keys()) {
        this.#assets.add(hash);
        session.pending.delete(hash);
      }
      if (session.pending.size > 0) return undefined;
      const completion = `assets-complete-${this.#id()}`;
      this.#completions.set(completion, session.paths);
      return completion;
    },
    deleteSecret: (name: string, secret: string) => {
      const script = this.#script(name, "deleteWorkerSecret");
      // A missing secret answers 404; its error code is unverified, so the fake reports none.
      if (!script.secrets.delete(secret)) throw new CloudflareApiError("deleteWorkerSecret", 404, []);
      this.#addVersion(script, activeVersion(script).bindings, script.migrationTag);
    },
    secrets: (name: string) => [...this.#script(name, "listWorkerSecrets").secrets.keys()],
    putSecret: (name: string, secret: string, value: string) => {
      const script = this.#script(name, "putWorkerSecret");
      script.secrets.set(secret, value);
      this.#addVersion(script, activeVersion(script).bindings, script.migrationTag);
    },
    schedules: (name: string) => [...this.#script(name, "getWorkerSchedules").schedules],
    putSchedules: (name: string, crons: string[]) => {
      const script = this.#script(name, "putWorkerSchedules");
      // Cloudflare refuses an expression it can't parse with HTTP 400; its error code is unverified,
      // so the fake checks only the field count and reports no code.
      if (crons.some((cron) => cron.trim().split(/\s+/).length !== 5)) throw new CloudflareApiError("putWorkerSchedules", 400, []);
      script.schedules = [...crons];
    },
    versions: (name: string) =>
      this.#script(name, "listWorkerVersions").versions.map((v) => ({
        id: v.id,
        createdOn: v.createdOn,
        vars: Object.fromEntries(v.bindings.flatMap((b) => (b.type === "plain_text" && b.text !== undefined ? [[b.name, b.text]] : []))),
        serviceBindings: v.bindings.flatMap((b) => (b.type === "service" ? [{ name: b.name, service: String(b.service) }] : [])),
      })),
    deploy: (name: string, versionId: string) => {
      const script = this.#script(name, "deployWorkerVersion");
      const version = script.versions.find((v) => v.id === versionId);
      if (!version) throw new CloudflareApiError("deployWorkerVersion", 404, [10007]);
      if (version.migrationTag !== script.migrationTag) throw new CloudflareApiError("deployWorkerVersion", 400, [10211]);
      script.activeVersionId = versionId;
    },
    domains: () => [...this.#domains.values()],
    attachDomain: (domain: Omit<WorkerDomain, "id">) => {
      if (!this.#scripts.has(domain.service)) throw new CloudflareApiError("attachWorkerDomain", 400, [100114]);
      if (!this.#zones().some((z) => z.id === domain.zoneId)) throw new CloudflareApiError("attachWorkerDomain", 400, [100115]);
      const existing = this.#domains.get(domain.hostname);
      if (existing && existing.service !== domain.service) throw new CloudflareApiError("attachWorkerDomain", 409, [100117]);
      if (existing) return existing;
      const created = { id: this.#id(), ...domain };
      this.#domains.set(domain.hostname, created);
      return created;
    },
    kv: () => [...this.#kv].map(([title, ns]) => ({ id: ns.id, title, ...(ns.jurisdiction ? { jurisdiction: ns.jurisdiction } : {}) })),
    // Cloudflare's not-found codes for these deletes are unverified; the fake answers 404 with none.
    deleteKv: (id: string) => {
      const entry = [...this.#kv].find(([, ns]) => ns.id === id);
      if (!entry) throw new CloudflareApiError("deleteKvNamespace", 404, []);
      this.#kv.delete(entry[0]);
    },
    createKv: (title: string, jurisdiction?: string) => {
      if (this.#kv.has(title)) throw new CloudflareApiError("createKvNamespace", 400, [10014]);
      const id = `kv-${this.#id()}`;
      this.#kv.set(title, { id, ...(jurisdiction ? { jurisdiction } : {}) });
      return { id, title, ...(jurisdiction ? { jurisdiction } : {}) };
    },
    // As R2 does: listing and creating are scoped to one jurisdiction, `default` when none is given.
    r2: (jurisdiction?: string) => {
      this.#requireR2("listR2Buckets");
      const prefix = `${jurisdiction ?? "default"}/`;
      return [...this.#r2].flatMap((key) => (key.startsWith(prefix) ? [{ name: key.slice(prefix.length) }] : []));
    },
    createR2: (name: string, jurisdiction?: string) => {
      this.#requireR2("createR2Bucket");
      if (this.#r2.has(r2Key(name, jurisdiction))) throw new CloudflareApiError("createR2Bucket", 409, [10004]);
      this.#r2.add(r2Key(name, jurisdiction));
      return { name };
    },
    deleteR2: (name: string, jurisdiction?: string) => {
      this.#requireR2("deleteR2Bucket");
      const key = r2Key(name, jurisdiction);
      if (!this.#r2.has(key)) throw new CloudflareApiError("deleteR2Bucket", 404, [10006]);
      // R2 refuses to delete a bucket that still holds objects: HTTP 409, code 10008 (BucketNotEmpty).
      if ((this.#r2Objects.get(key) ?? 0) > 0) throw new CloudflareApiError("deleteR2Bucket", 409, [10008]);
      this.#r2.delete(key);
    },
    deleteD1: (uuid: string) => {
      const entry = [...this.#d1].find(([, db]) => db.uuid === uuid);
      if (!entry) throw new CloudflareApiError("deleteD1Database", 404, [7404]);
      this.#d1.delete(entry[0]);
    },
    d1: () => [...this.#d1].map(([name, db]) => ({ uuid: db.uuid, name, ...(db.jurisdiction ? { jurisdiction: db.jurisdiction } : {}) })),
    createD1: (name: string, jurisdiction?: string) => {
      if (this.#d1.has(name)) throw new CloudflareApiError("createD1Database", 400, [7502]);
      const uuid = `d1-${this.#id()}`;
      this.#d1.set(name, { uuid, ...(jurisdiction ? { jurisdiction } : {}), ledger: undefined, statements: [] });
      return { uuid, name, ...(jurisdiction ? { jurisdiction } : {}) };
    },
    queryD1: (uuid: string, sql: string, params: string[]) => this.#queryD1(uuid, sql, params),
    organization: () => (this.#options.accessTeam ? { authDomain: `${this.#options.accessTeam}.cloudflareaccess.com` } : undefined),
    idps: () => (this.#options.identityProviders ?? [{ name: "One-time PIN", type: "onetimepin" }, { name: "District SSO", type: "oidc" }])
      .map((idp, i) => ({ id: `idp-${i}`, ...idp })),
    policies: () => [...this.#policies.values()],
    putPolicy: (id: string | undefined, spec: AccessPolicySpec) => {
      if (id === undefined && [...this.#policies.values()].some((p) => p.name === spec.name)) {
        throw new CloudflareApiError("createAccessPolicy", 400, [12130]);
      }
      if (id !== undefined && !this.#policies.has(id)) throw new CloudflareApiError("updateAccessPolicy", 404, []);
      const policy = { id: id ?? `pol-${this.#id()}`, name: spec.name, decision: spec.decision, include: structuredClone(spec.include) };
      this.#policies.set(policy.id, policy);
      return policy;
    },
    deletePolicy: (id: string) => {
      if (!this.#policies.has(id)) throw new CloudflareApiError("deleteAccessPolicy", 404, []);
      // Assumed: a reusable policy an application still uses can't be deleted (code unverified).
      if ([...this.#apps.values()].some((a) => a.policyIds.includes(id))) throw new CloudflareApiError("deleteAccessPolicy", 400, []);
      this.#policies.delete(id);
    },
    deleteApp: (id: string) => {
      if (!this.#apps.delete(id)) throw new CloudflareApiError("deleteAccessApplication", 404, []);
    },
    apps: () => [...this.#apps.values()],
    putApp: (id: string | undefined, spec: AccessApplicationSpec) => {
      // A hostname belongs to one application at a time.
      if ([...this.#apps.values()].some((a) => a.id !== id && a.destinations.some((d) => spec.destinations.includes(d)))) {
        throw new CloudflareApiError(id === undefined ? "createAccessApplication" : "updateAccessApplication", 400, [12130]);
      }
      const existing = id === undefined ? undefined : this.#apps.get(id);
      if (id !== undefined && !existing) throw new CloudflareApiError("updateAccessApplication", 404, []);
      for (const policyId of spec.policyIds) {
        if (!this.#policies.has(policyId)) throw new CloudflareApiError("createAccessApplication", 400, [12131]);
      }
      const appId = id ?? `app-${this.#id()}`;
      const app = {
        id: appId,
        name: spec.name,
        domain: spec.domain,
        destinations: [...spec.destinations],
        aud: existing?.aud ?? `aud-${appId}`,
        policyIds: [...spec.policyIds],
      };
      this.#apps.set(appId, app);
      return app;
    },
    gateways: () => [...this.#gateways].map((id) => ({ id })),
    deleteGateway: (id: string) => {
      if (!this.#gateways.delete(id)) throw new CloudflareApiError("deleteAiGateway", 404, []);
    },
    createGateway: (id: string) => {
      if (this.#gateways.has(id)) throw new CloudflareApiError("createAiGateway", 400, [7001]);
      this.#gateways.add(id);
      return { id };
    },
    providerKeys: (gatewayId: string) => {
      if (!this.#gateways.has(gatewayId)) throw new CloudflareApiError("listAiGatewayProviderKeys", 404, []);
      return [...this.#providerKeys].filter(([key]) => key.startsWith(`${gatewayId}/`)).map(([key, value]) => fakeProviderKey(key, value));
    },
    storeProviderKey: (gatewayId: string, providerSlug: string, secret: string) => {
      if (!this.#gateways.has(gatewayId)) throw new CloudflareApiError("storeAiGatewayProviderKey", 404, []);
      const key = `${gatewayId}/${providerSlug}`;
      // Cloudflare refuses a second default key for one provider; it is replaced in the dashboard.
      if (this.#providerKeys.has(key)) throw new CloudflareApiError("storeAiGatewayProviderKey", 409, []);
      const stored = { id: `pk-${this.#id()}`, secret };
      this.#providerKeys.set(key, stored);
      return fakeProviderKey(key, stored);
    },
  };

  #upload(name: string, upload: WorkerUpload): void {
    const { metadata } = upload;
    // A binding to a resource that does not exist fails the upload, as on Cloudflare.
    const dangling = metadata.bindings.some((binding) =>
      (binding.type === "service" && !this.#scripts.has(String(binding.service))) ||
      (binding.type === "kv_namespace" && ![...this.#kv.values()].some((ns) => ns.id === binding.namespace_id)) ||
      (binding.type === "r2_bucket" && !this.#r2.has(r2Key(String(binding.bucket_name), binding.jurisdiction as string | undefined))) ||
      (binding.type === "d1" && ![...this.#d1.values()].some((db) => db.uuid === binding.id)));
    if (dangling) throw new CloudflareApiError("uploadWorkerScript", 400, [10021]);
    if (metadata.assets && !this.#completions.has(metadata.assets.jwt)) throw new CloudflareApiError("uploadWorkerScript", 400, [10200]);
    if (!upload.modules.some((m) => m.name === metadata.main_module)) throw new CloudflareApiError("uploadWorkerScript", 400, [10021]);

    const existing = this.#scripts.get(name);
    // A binding named like a secret the upload keeps is assumed refused, as two bindings of one name
    // (unverified: the installer deletes such a secret first, so it never depends on this either way).
    if (existing && metadata.keep_bindings.includes("secret_text") && metadata.bindings.some((b) => existing.secrets.has(b.name))) {
      throw new CloudflareApiError("uploadWorkerScript", 400, []);
    }
    const migrations = metadata.migrations;
    if (migrations) {
      // Durable Object migrations must chain from the script's current tag.
      if ((migrations.old_tag ?? undefined) !== existing?.migrationTag) throw new CloudflareApiError("uploadWorkerScript", 400, [10079]);
    }
    const migrationTag = migrations?.new_tag ?? existing?.migrationTag;
    const bindings = metadata.bindings.map((b) => ({ ...b }) as ObservedBinding);
    if (!existing) {
      const script: Script = {
        versions: [], activeVersionId: "", secrets: new Map(), schedules: [], ...(migrationTag ? { migrationTag } : {}),
        ...(metadata.assets ? { assetsConfig: structuredClone(metadata.assets.config), assetPaths: this.#completions.get(metadata.assets.jwt)! } : {}),
      };
      this.#addVersion(script, bindings, migrationTag);
      this.#scripts.set(name, script);
      return;
    }
    if (migrationTag) existing.migrationTag = migrationTag;
    if (metadata.assets) {
      existing.assetsConfig = structuredClone(metadata.assets.config);
      existing.assetPaths = this.#completions.get(metadata.assets.jwt)!;
    }
    this.#addVersion(existing, bindings, migrationTag);
  }

  #addVersion(script: Script, bindings: ObservedBinding[], migrationTag: string | undefined): void {
    const version: Version = { id: `ver-${this.#id()}`, createdOn: this.#timestamp(), bindings, ...(migrationTag ? { migrationTag } : {}) };
    script.versions.push(version);
    script.activeVersionId = version.id;
  }

  #queryD1(uuid: string, sql: string, params: string[]): Record<string, unknown>[] {
    const db = [...this.#d1.values()].find((d) => d.uuid === uuid);
    if (!db) throw new CloudflareApiError("queryD1", 404, [7404]);
    // As D1 does: `params` with more than one statement is refused.
    if (params.length > 0 && /;\s*\S/.test(sql.trim().replace(/;$/, ""))) throw new CloudflareApiError("queryD1", 400, [7500]);
    if (sql.startsWith("SELECT name FROM sqlite_master")) return db.ledger && params[0] === "_educateos_migrations" ? [{ name: params[0] }] : [];
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS _educateos_migrations")) {
      db.ledger ??= new Set();
      return [];
    }
    if (sql === "SELECT id FROM _educateos_migrations") {
      if (!db.ledger) throw new CloudflareApiError("queryD1", 400, [7500]);
      return [...db.ledger].map((id) => ({ id }));
    }
    const ledgerRow = LEDGER_INSERT.exec(sql);
    if (ledgerRow) {
      if (!db.ledger) throw new CloudflareApiError("queryD1", 400, [7500]);
      if (db.ledger.has(ledgerRow[1]!)) throw new CloudflareApiError("queryD1", 400, [7500]);
      db.statements.push(sql.replace(LEDGER_INSERT, "").trim());
      db.ledger.add(ledgerRow[1]!);
      return [];
    }
    db.statements.push(sql);
    return [];
  }

  #requireR2(operation: string): void {
    if (this.#options.r2Enabled === false) throw new CloudflareApiError(operation, 403, [R2_NOT_ENABLED_CODE]);
  }

  #script(name: string, operation: string): Script {
    const script = this.#scripts.get(name);
    if (!script) throw new CloudflareApiError(operation, 404, [10007]);
    return script;
  }

  #zones() {
    return (this.#options.zones ?? []).map((z, i) => ({ id: `zone-${i}`, name: z.name, status: z.status ?? "active" }));
  }

  #saas(zoneId: string): boolean {
    const zone = this.#zones().find((z) => z.id === zoneId);
    return zone !== undefined && (this.#options.saasZones ?? []).includes(zone.name);
  }

  #zone(hostname: string) {
    return this.#zones().find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`));
  }

  #id(): string {
    return String(this.#nextId++).padStart(4, "0");
  }

  #timestamp(): string {
    return new Date(Date.UTC(2026, 9, 20) + this.#nextId * 1000).toISOString();
  }
}

function activeVersion(script: Script): Version {
  return script.versions.find((v) => v.id === script.activeVersionId)!;
}

function withoutZone({ zoneId: _zoneId, ...custom }: CustomHostname & { zoneId: string }): CustomHostname {
  return structuredClone(custom);
}

function varOf(version: Version, name: string): string | undefined {
  return version.bindings.find((b) => b.type === "plain_text" && b.name === name)?.text;
}

class FakeCloudflareApi implements CloudflareApi {
  readonly #fake: FakeCloudflare;
  readonly #tokens: TokenProvider;

  constructor(fake: FakeCloudflare, tokens: TokenProvider) {
    this.#fake = fake;
    this.#tokens = tokens;
  }

  #call<T>(accountId: string | undefined, operation: string, run: () => T): Promise<T> {
    return this.#fake.call(this.#tokens, accountId, operation, run);
  }

  getAccount(a: string) { return this.#call(a, "getAccount", () => this.#fake.op.account()); }
  listSubscriptions(a: string) { return this.#call(a, "listSubscriptions", () => this.#fake.op.subscriptions()); }
  findZone(a: string, name: string) { return this.#call(a, "findZone", () => this.#fake.op.findZone(name)); }
  listDnsRecords(zoneId: string, name: string) { return this.#call(undefined, "listDnsRecords", () => this.#fake.op.dnsRecords(zoneId, name)); }
  createDnsRecord(zoneId: string, spec: DnsRecordSpec) { return this.#call(undefined, "createDnsRecord", () => this.#fake.op.putDns(zoneId, undefined, spec)); }
  updateDnsRecord(zoneId: string, id: string, spec: DnsRecordSpec) { return this.#call(undefined, "updateDnsRecord", () => this.#fake.op.putDns(zoneId, id, spec)); }
  deleteDnsRecord(zoneId: string, id: string) { return this.#call(undefined, "deleteDnsRecord", () => this.#fake.op.deleteDns(zoneId, id)); }
  getFallbackOrigin(zoneId: string) { return this.#call(undefined, "getFallbackOrigin", () => this.#fake.op.fallbackOrigin(zoneId)); }
  setFallbackOrigin(zoneId: string, origin: string) { return this.#call(undefined, "setFallbackOrigin", () => this.#fake.op.setFallbackOrigin(zoneId, origin)); }
  findCustomHostname(zoneId: string, hostname: string) { return this.#call(undefined, "findCustomHostname", () => this.#fake.op.findCustomHostname(zoneId, hostname)); }
  createCustomHostname(zoneId: string, hostname: string) { return this.#call(undefined, "createCustomHostname", () => this.#fake.op.createCustomHostname(zoneId, hostname)); }
  deleteCustomHostname(zoneId: string, id: string) { return this.#call(undefined, "deleteCustomHostname", () => this.#fake.op.deleteCustomHostname(zoneId, id)); }
  listWorkerRoutes(zoneId: string) { return this.#call(undefined, "listWorkerRoutes", () => this.#fake.op.routes(zoneId)); }
  createWorkerRoute(zoneId: string, pattern: string, script: string) { return this.#call(undefined, "createWorkerRoute", () => this.#fake.op.createRoute(zoneId, pattern, script)); }
  deleteWorkerRoute(zoneId: string, id: string) { return this.#call(undefined, "deleteWorkerRoute", () => this.#fake.op.deleteRoute(zoneId, id)); }
  listWorkerScripts(a: string) { return this.#call(a, "listWorkerScripts", () => this.#fake.op.scripts()); }
  getWorkerSettings(a: string, s: string) { return this.#call(a, "getWorkerSettings", () => this.#fake.op.settings(s)); }
  uploadWorkerScript(a: string, s: string, u: WorkerUpload) { return this.#call(a, "uploadWorkerScript", () => this.#fake.op.upload(s, u)); }
  deleteWorkerScript(a: string, s: string) { return this.#call(a, "deleteWorkerScript", () => this.#fake.op.deleteScript(s)); }
  createAssetsUploadSession(a: string, _s: string, m: Record<string, { hash: string; size: number }>) {
    return this.#call(a, "createAssetsUploadSession", () => this.#fake.op.assetsSession(m));
  }
  uploadAssets(a: string, jwt: string, files: Map<string, Uint8Array<ArrayBuffer>>) {
    return this.#call(a, "uploadAssets", () => this.#fake.op.uploadAssets(jwt, files));
  }
  deleteWorkerSecret(a: string, s: string, n: string) { return this.#call(a, "deleteWorkerSecret", () => this.#fake.op.deleteSecret(s, n)); }
  listWorkerSecrets(a: string, s: string) { return this.#call(a, "listWorkerSecrets", () => this.#fake.op.secrets(s)); }
  putWorkerSecret(a: string, s: string, n: string, v: string) { return this.#call(a, "putWorkerSecret", () => this.#fake.op.putSecret(s, n, v)); }
  getWorkerSchedules(a: string, s: string) { return this.#call(a, "getWorkerSchedules", () => this.#fake.op.schedules(s)); }
  putWorkerSchedules(a: string, s: string, c: string[]) { return this.#call(a, "putWorkerSchedules", () => this.#fake.op.putSchedules(s, c)); }
  listWorkerVersions(a: string, s: string) { return this.#call(a, "listWorkerVersions", () => this.#fake.op.versions(s)); }
  deployWorkerVersion(a: string, s: string, v: string) { return this.#call(a, "deployWorkerVersion", () => this.#fake.op.deploy(s, v)); }
  listWorkerDomains(a: string) { return this.#call(a, "listWorkerDomains", () => this.#fake.op.domains()); }
  attachWorkerDomain(a: string, d: Omit<WorkerDomain, "id">) { return this.#call(a, "attachWorkerDomain", () => this.#fake.op.attachDomain(d)); }
  detachWorkerDomain(a: string, id: string) { return this.#call(a, "detachWorkerDomain", () => this.#fake.op.detachDomain(id)); }
  listKvNamespaces(a: string) { return this.#call(a, "listKvNamespaces", () => this.#fake.op.kv()); }
  createKvNamespace(a: string, t: string, j?: DataJurisdiction) { return this.#call(a, "createKvNamespace", () => this.#fake.op.createKv(t, j)); }
  deleteKvNamespace(a: string, id: string) { return this.#call(a, "deleteKvNamespace", () => this.#fake.op.deleteKv(id)); }
  listR2Buckets(a: string, j?: DataJurisdiction) { return this.#call(a, "listR2Buckets", () => this.#fake.op.r2(j)); }
  createR2Bucket(a: string, n: string, j?: DataJurisdiction) { return this.#call(a, "createR2Bucket", () => this.#fake.op.createR2(n, j)); }
  deleteR2Bucket(a: string, n: string, j?: DataJurisdiction) { return this.#call(a, "deleteR2Bucket", () => this.#fake.op.deleteR2(n, j)); }
  listD1Databases(a: string) { return this.#call(a, "listD1Databases", () => this.#fake.op.d1()); }
  createD1Database(a: string, n: string, j?: DataJurisdiction) { return this.#call(a, "createD1Database", () => this.#fake.op.createD1(n, j)); }
  deleteD1Database(a: string, id: string) { return this.#call(a, "deleteD1Database", () => this.#fake.op.deleteD1(id)); }
  queryD1(a: string, id: string, sql: string, params: string[] = []) { return this.#call(a, "queryD1", () => this.#fake.op.queryD1(id, sql, params)); }
  getAccessOrganization(a: string) { return this.#call(a, "getAccessOrganization", () => this.#fake.op.organization()); }
  listAccessIdentityProviders(a: string) { return this.#call(a, "listAccessIdentityProviders", () => this.#fake.op.idps()); }
  listAccessPolicies(a: string) { return this.#call(a, "listAccessPolicies", () => this.#fake.op.policies()); }
  createAccessPolicy(a: string, spec: AccessPolicySpec) { return this.#call(a, "createAccessPolicy", () => this.#fake.op.putPolicy(undefined, spec)); }
  updateAccessPolicy(a: string, id: string, spec: AccessPolicySpec) { return this.#call(a, "updateAccessPolicy", () => this.#fake.op.putPolicy(id, spec)); }
  deleteAccessPolicy(a: string, id: string) { return this.#call(a, "deleteAccessPolicy", () => this.#fake.op.deletePolicy(id)); }
  listAccessApplications(a: string) { return this.#call(a, "listAccessApplications", () => this.#fake.op.apps()); }
  createAccessApplication(a: string, spec: AccessApplicationSpec) { return this.#call(a, "createAccessApplication", () => this.#fake.op.putApp(undefined, spec)); }
  updateAccessApplication(a: string, id: string, spec: AccessApplicationSpec) { return this.#call(a, "updateAccessApplication", () => this.#fake.op.putApp(id, spec)); }
  deleteAccessApplication(a: string, id: string) { return this.#call(a, "deleteAccessApplication", () => this.#fake.op.deleteApp(id)); }
  listAiGateways(a: string) { return this.#call(a, "listAiGateways", () => this.#fake.op.gateways()); }
  createAiGateway(a: string, id: string) { return this.#call(a, "createAiGateway", () => this.#fake.op.createGateway(id)); }
  deleteAiGateway(a: string, id: string) { return this.#call(a, "deleteAiGateway", () => this.#fake.op.deleteGateway(id)); }
  listAiGatewayProviderKeys(a: string, g: string) { return this.#call(a, "listAiGatewayProviderKeys", () => this.#fake.op.providerKeys(g)); }
  storeAiGatewayProviderKey(a: string, g: string, p: string, secret: string) {
    return this.#call(a, "storeAiGatewayProviderKey", () => this.#fake.op.storeProviderKey(g, p, secret));
  }
}

function fakeProviderKey(key: string, stored: { id: string; secret: string }) {
  return { id: stored.id, providerSlug: key.slice(key.indexOf("/") + 1), alias: "default", secretPreview: `${stored.secret.slice(0, 4)}…${stored.secret.slice(-2)}` };
}

function r2Key(name: string, jurisdiction: string | undefined): string {
  return `${jurisdiction ?? "default"}/${name}`;
}
