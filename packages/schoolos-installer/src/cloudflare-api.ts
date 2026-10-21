// The Cloudflare operations the installer uses, and nothing else. Every method maps to one
// documented `api.cloudflare.com/client/v4` endpoint (see cloudflare-http.ts), and every failure
// is a CloudflareApiError. The port deliberately has no operation that reads district data: no KV
// value or R2 object read, and D1 queries only for the migration ledger.
import type { ModuleType } from "./manifest.ts";

/** An account the credential can reach. */
export interface AccountInfo {
  id: string;
  name: string;
}

/** One of the account's product subscriptions, by Cloudflare rate plan ID (e.g. `workers_paid`). */
export interface Subscription {
  ratePlanId: string;
}

/** A DNS zone. */
export interface Zone {
  id: string;
  name: string;
  /** `active` once the zone's nameservers are delegated to Cloudflare. */
  status: string;
}

/** A DNS record. */
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
}

/** A Worker script as the account lists it. */
export interface WorkerScriptSummary {
  name: string;
  /** The last Durable Object migration tag applied, if any. */
  migrationTag?: string;
}

/** A binding as Cloudflare reports it. Plain-text bindings carry their `text`. */
export type ObservedBinding = { type: string; name: string; text?: string } & Record<string, unknown>;

/** A Worker's current settings. */
export interface WorkerSettings {
  bindings: ObservedBinding[];
}

/** A binding as uploaded in script metadata. */
export type UploadBinding = { type: string; name: string } & Record<string, unknown>;

/** The `migrations` stanza of a script upload. */
export interface WorkerMigrations {
  old_tag?: string;
  new_tag: string;
  steps: Record<string, unknown>[];
}

/** Script-upload metadata, in the API's own (snake_case) vocabulary. */
export interface WorkerUploadMetadata {
  main_module: string;
  compatibility_date?: string;
  compatibility_flags: string[];
  bindings: UploadBinding[];
  /** Binding types kept from the previous version; the installer keeps `secret_text`. */
  keep_bindings: string[];
  migrations?: WorkerMigrations;
  observability: Record<string, unknown>;
  assets?: { jwt: string; config: Record<string, unknown> };
}

/** One module part of a script upload. */
export interface WorkerModulePart {
  name: string;
  type: ModuleType;
  bytes: Uint8Array<ArrayBuffer>;
}

/** A complete script upload. Uploading deploys the new version at 100%. */
export interface WorkerUpload {
  metadata: WorkerUploadMetadata;
  modules: WorkerModulePart[];
}

/** One version of a Worker, with its plain-text vars (where the installer records release IDs). */
export interface WorkerVersion {
  id: string;
  createdOn: string;
  vars: Record<string, string>;
}

/** A Worker custom domain. */
export interface WorkerDomain {
  id: string;
  hostname: string;
  /** The Worker the domain routes to. */
  service: string;
  zoneId: string;
}

/** A Workers KV namespace. */
export interface KvNamespace {
  id: string;
  title: string;
}

/** An R2 bucket. */
export interface R2Bucket {
  name: string;
}

/** A D1 database. */
export interface D1Database {
  uuid: string;
  name: string;
}

/** The account's Zero Trust organization. */
export interface AccessOrganization {
  /** `<team>.cloudflareaccess.com`. */
  authDomain: string;
}

/** A Zero Trust identity provider. `onetimepin` is Cloudflare's built-in email code login. */
export interface AccessIdentityProvider {
  id: string;
  name: string;
  type: string;
}

/** An `include` rule admitting users whose verified email is in one domain. */
export interface EmailDomainRule {
  email_domain: { domain: string };
}

/** A reusable Access policy. */
export interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  include: EmailDomainRule[];
}

/** What the installer writes to an Access policy. */
export interface AccessPolicySpec {
  name: string;
  decision: "allow";
  include: EmailDomainRule[];
}

/** A self-hosted Access application. */
export interface AccessApplication {
  id: string;
  name: string;
  domain: string;
  /** The application audience tag the backend verifies Access JWTs against. */
  aud: string;
  policyIds: string[];
}

/** What the installer writes to an Access application. */
export interface AccessApplicationSpec {
  name: string;
  domain: string;
  type: "self_hosted";
  sessionDuration: string;
  policyIds: string[];
}

/** An AI Gateway. */
export interface AiGateway {
  id: string;
}

/** A Workers static-assets upload session. `buckets` lists the hashes Cloudflare still needs. */
export interface AssetsUploadSession {
  jwt: string;
  buckets: string[][];
}

/** The installer's view of the Cloudflare API, scoped to one credential. */
export interface CloudflareApi {
  getAccount(accountId: string): Promise<AccountInfo>;
  listSubscriptions(accountId: string): Promise<Subscription[]>;

  findZone(accountId: string, name: string): Promise<Zone | undefined>;
  listDnsRecords(zoneId: string, name: string): Promise<DnsRecord[]>;

  listWorkerScripts(accountId: string): Promise<WorkerScriptSummary[]>;
  getWorkerSettings(accountId: string, scriptName: string): Promise<WorkerSettings>;
  uploadWorkerScript(accountId: string, scriptName: string, upload: WorkerUpload): Promise<void>;
  createAssetsUploadSession(
    accountId: string,
    scriptName: string,
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<AssetsUploadSession>;
  /** Uploads one bucket of assets with a session JWT. Returns the completion JWT after the last. */
  uploadAssets(accountId: string, sessionJwt: string, files: Map<string, Uint8Array<ArrayBuffer>>): Promise<string | undefined>;
  listWorkerSecrets(accountId: string, scriptName: string): Promise<string[]>;
  putWorkerSecret(accountId: string, scriptName: string, name: string, value: string): Promise<void>;
  listWorkerVersions(accountId: string, scriptName: string): Promise<WorkerVersion[]>;
  deployWorkerVersion(accountId: string, scriptName: string, versionId: string): Promise<void>;

  listWorkerDomains(accountId: string): Promise<WorkerDomain[]>;
  attachWorkerDomain(accountId: string, domain: Omit<WorkerDomain, "id">): Promise<WorkerDomain>;

  listKvNamespaces(accountId: string): Promise<KvNamespace[]>;
  createKvNamespace(accountId: string, title: string): Promise<KvNamespace>;
  listR2Buckets(accountId: string): Promise<R2Bucket[]>;
  createR2Bucket(accountId: string, name: string): Promise<R2Bucket>;
  listD1Databases(accountId: string): Promise<D1Database[]>;
  createD1Database(accountId: string, name: string): Promise<D1Database>;
  /** Runs SQL against a D1 database. The installer uses it only for migrations and their ledger. */
  queryD1(accountId: string, databaseId: string, sql: string, params?: string[]): Promise<Record<string, unknown>[]>;

  /** The account's Zero Trust organization, or undefined if Zero Trust was never set up. */
  getAccessOrganization(accountId: string): Promise<AccessOrganization | undefined>;
  listAccessIdentityProviders(accountId: string): Promise<AccessIdentityProvider[]>;
  listAccessPolicies(accountId: string): Promise<AccessPolicy[]>;
  createAccessPolicy(accountId: string, spec: AccessPolicySpec): Promise<AccessPolicy>;
  updateAccessPolicy(accountId: string, policyId: string, spec: AccessPolicySpec): Promise<AccessPolicy>;
  listAccessApplications(accountId: string): Promise<AccessApplication[]>;
  createAccessApplication(accountId: string, spec: AccessApplicationSpec): Promise<AccessApplication>;
  updateAccessApplication(accountId: string, appId: string, spec: AccessApplicationSpec): Promise<AccessApplication>;

  listAiGateways(accountId: string): Promise<AiGateway[]>;
  createAiGateway(accountId: string, gatewayId: string): Promise<AiGateway>;
}
