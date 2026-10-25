// An in-memory Cloudflare account implementing the CloudflareApi port, for tests and local
// harnesses. It enforces the constraints the reconciler depends on: unique names, service and
// storage bindings that must point at existing resources, Durable Object migration tags that must
// chain, versions that cannot be redeployed across a migration, and bearer tokens that can be
// revoked. Faults can be injected at the Nth mutation, with or without the effect landing.
import type {
  AccessApplication,
  AccessApplicationSpec,
  AccessIdentityProvider,
  AccessPolicy,
  AccessPolicySpec,
  CloudflareApi,
  ObservedBinding,
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
  dnsRecords?: { name: string; type: string }[];
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
}

const MUTATIONS = new Set([
  "uploadWorkerScript", "deleteWorkerScript", "createAssetsUploadSession", "uploadAssets", "putWorkerSecret", "deployWorkerVersion",
  "attachWorkerDomain", "createKvNamespace", "createR2Bucket", "createD1Database", "createAccessPolicy",
  "updateAccessPolicy", "createAccessApplication", "updateAccessApplication", "createAiGateway",
]);

const LEDGER_INSERT = /INSERT INTO _educateos_migrations \(id, sha256\) VALUES \(\?, \?\)\s*$/;

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
  readonly #kv = new Map<string, string>();
  readonly #r2 = new Set<string>();
  readonly #d1 = new Map<string, { uuid: string; ledger: Set<string> | undefined; statements: string[] }>();
  readonly #policies = new Map<string, AccessPolicy>();
  readonly #apps = new Map<string, AccessApplication>();
  readonly #gateways = new Set<string>();
  readonly #assets = new Set<string>();
  readonly #assetSessions = new Map<string, { pending: Set<string> }>();
  readonly #completions = new Set<string>();
  #nextId = 1;
  #mutations = 0;
  #fault: { at: number; effectApplied: boolean } | undefined;

  constructor(options: FakeAccountOptions) {
    this.#options = options;
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

  /** What the public hostname serves right now: the router's script and its active release. */
  serving(hostname: string): { scriptName: string; releaseId: string | undefined } | undefined {
    const domain = this.#domains.get(hostname);
    const script = domain && this.#scripts.get(domain.service);
    if (!domain || !script) return undefined;
    return { scriptName: domain.service, releaseId: varOf(activeVersion(script), MARKER_VARS.release) };
  }

  /** How many of each resource kind exist, for duplicate checks. */
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
    };
  }

  /** Statements a D1 database has run, in order. */
  d1Statements(name: string): string[] {
    return [...(this.#d1.get(name)?.statements ?? [])];
  }

  /** Adds a Worker the installer did not create, with the given plain-text vars. */
  seedWorker(name: string, vars: Record<string, string> = {}): void {
    const bindings = Object.entries(vars).map(([k, text]) => ({ type: "plain_text", name: k, text }));
    const version = { id: this.#id(), createdOn: this.#timestamp(), bindings };
    this.#scripts.set(name, { versions: [version], activeVersionId: version.id, secrets: new Map() });
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

  /** Adds an Access application the installer did not create. */
  seedAccessApplication(name: string, domain: string): void {
    const id = this.#id();
    this.#apps.set(id, { id, name, domain, aud: `aud-${id}`, policyIds: [] });
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
      (this.#options.dnsRecords ?? [])
        .filter((r) => r.name === name && this.#zone(r.name)?.id === zoneId)
        .map((r, i) => ({ id: `dns-${i}`, type: r.type, name: r.name })),
    scripts: () => [...this.#scripts].map(([name, s]) => ({ name, ...(s.migrationTag ? { migrationTag: s.migrationTag } : {}) })),
    settings: (name: string) => {
      const script = this.#script(name, "getWorkerSettings");
      const secrets = [...script.secrets.keys()].map((n) => ({ type: "secret_text", name: n }));
      return { bindings: [...activeVersion(script).bindings, ...secrets] };
    },
    upload: (name: string, upload: WorkerUpload) => this.#upload(name, upload),
    deleteScript: (name: string) => {
      this.#script(name, "deleteWorkerScript");
      // Cloudflare refuses to delete a Worker another Worker's deployed version binds, or that a
      // custom domain routes to, unless forced. The exact error codes are unverified.
      const boundBy = [...this.#scripts].some(([other, script]) =>
        other !== name && activeVersion(script).bindings.some((b) => b.type === "service" && b.service === name));
      if (boundBy) throw new CloudflareApiError("deleteWorkerScript", 400, [10064]);
      if ([...this.#domains.values()].some((d) => d.service === name)) throw new CloudflareApiError("deleteWorkerScript", 400, [10065]);
      this.#scripts.delete(name);
    },
    assetsSession: (manifest: Record<string, { hash: string; size: number }>) => {
      const pending = new Set(Object.values(manifest).map((e) => e.hash).filter((h) => !this.#assets.has(h)));
      const jwt = `assets-session-${this.#id()}`;
      this.#assetSessions.set(jwt, { pending });
      if (pending.size === 0) this.#completions.add(jwt);
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
      this.#completions.add(completion);
      return completion;
    },
    secrets: (name: string) => [...this.#script(name, "listWorkerSecrets").secrets.keys()],
    putSecret: (name: string, secret: string, value: string) => {
      const script = this.#script(name, "putWorkerSecret");
      script.secrets.set(secret, value);
      this.#addVersion(script, activeVersion(script).bindings, script.migrationTag);
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
    kv: () => [...this.#kv].map(([title, id]) => ({ id, title })),
    createKv: (title: string) => {
      if (this.#kv.has(title)) throw new CloudflareApiError("createKvNamespace", 400, [10014]);
      const id = `kv-${this.#id()}`;
      this.#kv.set(title, id);
      return { id, title };
    },
    r2: () => {
      this.#requireR2("listR2Buckets");
      return [...this.#r2].map((name) => ({ name }));
    },
    createR2: (name: string) => {
      this.#requireR2("createR2Bucket");
      if (this.#r2.has(name)) throw new CloudflareApiError("createR2Bucket", 409, [10004]);
      this.#r2.add(name);
      return { name };
    },
    d1: () => [...this.#d1].map(([name, db]) => ({ uuid: db.uuid, name })),
    createD1: (name: string) => {
      if (this.#d1.has(name)) throw new CloudflareApiError("createD1Database", 400, [7502]);
      const uuid = `d1-${this.#id()}`;
      this.#d1.set(name, { uuid, ledger: undefined, statements: [] });
      return { uuid, name };
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
    apps: () => [...this.#apps.values()],
    putApp: (id: string | undefined, spec: AccessApplicationSpec) => {
      if (id === undefined && [...this.#apps.values()].some((a) => a.domain === spec.domain)) {
        throw new CloudflareApiError("createAccessApplication", 400, [12130]);
      }
      const existing = id === undefined ? undefined : this.#apps.get(id);
      if (id !== undefined && !existing) throw new CloudflareApiError("updateAccessApplication", 404, []);
      for (const policyId of spec.policyIds) {
        if (!this.#policies.has(policyId)) throw new CloudflareApiError("createAccessApplication", 400, [12131]);
      }
      const appId = id ?? `app-${this.#id()}`;
      const app = { id: appId, name: spec.name, domain: spec.domain, aud: existing?.aud ?? `aud-${appId}`, policyIds: [...spec.policyIds] };
      this.#apps.set(appId, app);
      return app;
    },
    gateways: () => [...this.#gateways].map((id) => ({ id })),
    createGateway: (id: string) => {
      if (this.#gateways.has(id)) throw new CloudflareApiError("createAiGateway", 400, [7001]);
      this.#gateways.add(id);
      return { id };
    },
  };

  #upload(name: string, upload: WorkerUpload): void {
    const { metadata } = upload;
    // A binding to a resource that does not exist fails the upload, as on Cloudflare.
    const dangling = metadata.bindings.some((binding) =>
      (binding.type === "service" && !this.#scripts.has(String(binding.service))) ||
      (binding.type === "kv_namespace" && ![...this.#kv.values()].includes(String(binding.namespace_id))) ||
      (binding.type === "r2_bucket" && !this.#r2.has(String(binding.bucket_name))) ||
      (binding.type === "d1" && ![...this.#d1.values()].some((db) => db.uuid === binding.id)));
    if (dangling) throw new CloudflareApiError("uploadWorkerScript", 400, [10021]);
    if (metadata.assets && !this.#completions.has(metadata.assets.jwt)) throw new CloudflareApiError("uploadWorkerScript", 400, [10200]);
    if (!upload.modules.some((m) => m.name === metadata.main_module)) throw new CloudflareApiError("uploadWorkerScript", 400, [10021]);

    const existing = this.#scripts.get(name);
    const migrations = metadata.migrations;
    if (migrations) {
      // Durable Object migrations must chain from the script's current tag.
      if ((migrations.old_tag ?? undefined) !== existing?.migrationTag) throw new CloudflareApiError("uploadWorkerScript", 400, [10079]);
    }
    const migrationTag = migrations?.new_tag ?? existing?.migrationTag;
    const bindings = metadata.bindings.map((b) => ({ ...b }) as ObservedBinding);
    if (!existing) {
      const script: Script = { versions: [], activeVersionId: "", secrets: new Map(), ...(migrationTag ? { migrationTag } : {}) };
      this.#addVersion(script, bindings, migrationTag);
      this.#scripts.set(name, script);
      return;
    }
    if (migrationTag) existing.migrationTag = migrationTag;
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
    if (sql.startsWith("SELECT name FROM sqlite_master")) return db.ledger && params[0] === "_educateos_migrations" ? [{ name: params[0] }] : [];
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS _educateos_migrations")) {
      db.ledger ??= new Set();
      return [];
    }
    if (sql === "SELECT id FROM _educateos_migrations") {
      if (!db.ledger) throw new CloudflareApiError("queryD1", 400, [7500]);
      return [...db.ledger].map((id) => ({ id }));
    }
    if (LEDGER_INSERT.test(sql)) {
      if (!db.ledger) throw new CloudflareApiError("queryD1", 400, [7500]);
      if (db.ledger.has(params[0]!)) throw new CloudflareApiError("queryD1", 400, [7500]);
      db.statements.push(sql.replace(LEDGER_INSERT, "").trim());
      db.ledger.add(params[0]!);
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
  listWorkerSecrets(a: string, s: string) { return this.#call(a, "listWorkerSecrets", () => this.#fake.op.secrets(s)); }
  putWorkerSecret(a: string, s: string, n: string, v: string) { return this.#call(a, "putWorkerSecret", () => this.#fake.op.putSecret(s, n, v)); }
  listWorkerVersions(a: string, s: string) { return this.#call(a, "listWorkerVersions", () => this.#fake.op.versions(s)); }
  deployWorkerVersion(a: string, s: string, v: string) { return this.#call(a, "deployWorkerVersion", () => this.#fake.op.deploy(s, v)); }
  listWorkerDomains(a: string) { return this.#call(a, "listWorkerDomains", () => this.#fake.op.domains()); }
  attachWorkerDomain(a: string, d: Omit<WorkerDomain, "id">) { return this.#call(a, "attachWorkerDomain", () => this.#fake.op.attachDomain(d)); }
  listKvNamespaces(a: string) { return this.#call(a, "listKvNamespaces", () => this.#fake.op.kv()); }
  createKvNamespace(a: string, t: string) { return this.#call(a, "createKvNamespace", () => this.#fake.op.createKv(t)); }
  listR2Buckets(a: string) { return this.#call(a, "listR2Buckets", () => this.#fake.op.r2()); }
  createR2Bucket(a: string, n: string) { return this.#call(a, "createR2Bucket", () => this.#fake.op.createR2(n)); }
  listD1Databases(a: string) { return this.#call(a, "listD1Databases", () => this.#fake.op.d1()); }
  createD1Database(a: string, n: string) { return this.#call(a, "createD1Database", () => this.#fake.op.createD1(n)); }
  queryD1(a: string, id: string, sql: string, params: string[] = []) { return this.#call(a, "queryD1", () => this.#fake.op.queryD1(id, sql, params)); }
  getAccessOrganization(a: string) { return this.#call(a, "getAccessOrganization", () => this.#fake.op.organization()); }
  listAccessIdentityProviders(a: string) { return this.#call(a, "listAccessIdentityProviders", () => this.#fake.op.idps()); }
  listAccessPolicies(a: string) { return this.#call(a, "listAccessPolicies", () => this.#fake.op.policies()); }
  createAccessPolicy(a: string, spec: AccessPolicySpec) { return this.#call(a, "createAccessPolicy", () => this.#fake.op.putPolicy(undefined, spec)); }
  updateAccessPolicy(a: string, id: string, spec: AccessPolicySpec) { return this.#call(a, "updateAccessPolicy", () => this.#fake.op.putPolicy(id, spec)); }
  listAccessApplications(a: string) { return this.#call(a, "listAccessApplications", () => this.#fake.op.apps()); }
  createAccessApplication(a: string, spec: AccessApplicationSpec) { return this.#call(a, "createAccessApplication", () => this.#fake.op.putApp(undefined, spec)); }
  updateAccessApplication(a: string, id: string, spec: AccessApplicationSpec) { return this.#call(a, "updateAccessApplication", () => this.#fake.op.putApp(id, spec)); }
  listAiGateways(a: string) { return this.#call(a, "listAiGateways", () => this.#fake.op.gateways()); }
  createAiGateway(a: string, id: string) { return this.#call(a, "createAiGateway", () => this.#fake.op.createGateway(id)); }
}
