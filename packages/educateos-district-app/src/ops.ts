// The district's signed operations API (SCHO-263, plan section 6 "Signed ops API"): `/api/ops/*`,
// which an enrolled admin edition (admin.educateos.io, or the OSS admin in the district's own
// account) calls with requests signed by its Ed25519 ops key. docs/educateos/admin.md describes the
// protocol; `@educateos/fleet/ops` is its shared half (signing, the verifier, the route → scope table
// and the bodies), and this module is the district's half:
//
// - the keyring: which admin keys a district administrator enrolled, under which scopes, from
//   district `/admin` → Operations (`admin.*Ops*` routes);
// - the one choke point, `DistrictOps.serve`. `/api/ops/*` is an Access bypass path, so every
//   request is verified here (signature, age, nonce, key, scope) before any handler runs;
// - the district-side audit log of every request that carried a valid signature;
// - the handlers, answering exactly the fleet schemas, each body parsed before it is sent.
//
// Like the rest of the application this module uses only web-standard APIs (ADR-0009).
import { z } from "zod";
import {
  EducateOsError,
  PrincipalId,
  type AuthorityMap,
  type DistrictDirectorySnapshot,
  type ErrorCode,
  type Principal,
  type RoleAssignment,
} from "@educateos/contracts";
import { ERROR_STATUS, isDistrictAdmin, type AcademicStore } from "@educateos/academics";
import {
  createOpsVerifier,
  DirectoryActionBodies,
  Ed25519PublicKey,
  KeyId,
  keyIdFor,
  matchOpsRoute,
  OPS_HEADERS,
  OPS_RESPONSES,
  OpsAnalyticsQuery,
  OpsDevicesQuery,
  OpsDirectoryQuery,
  OpsRevokeBelowVersionBody,
  OpsRevokeDeviceBody,
  OpsScope,
  type AnalyticsRange,
  type DeviceEntry,
  type DirectoryAction,
  type DirectoryEntry,
  type DirectoryRole,
  type NonceStore,
  type OpsAnalyticsResponse,
  type OpsKey,
  type OpsRejectionReason,
  type OpsRouteMatch,
  type OpsRouteName,
} from "@educateos/fleet/ops";
import { DeviceId, type DeviceCredentials, type DeviceRecord } from "./devices.ts";

/** The path prefix of the ops API. */
export const OPS_API_PREFIX = "/api/ops/";

/** Whether a path is under the ops API, which only {@link DistrictOps.serve} may serve. */
export function isOpsApiPath(pathname: string): boolean {
  return pathname === "/api/ops" || pathname.startsWith(OPS_API_PREFIX);
}

/** How many entries one directory or devices page holds. */
export const OPS_PAGE_SIZE = 50;
/** How long the district keeps its ops audit log. */
export const OPS_AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
/** How many audit entries the Operations page shows. */
export const OPS_AUDIT_PAGE = 100;

// ---------------------------------------------------------------------------------------------
// Records

/** An enrolled admin key's public half, as a JWK. Only the public members are kept. */
export const OpsPublicJwk = z.strictObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: Ed25519PublicKey });
/** An ops public JWK. */
export type OpsPublicJwk = z.infer<typeof OpsPublicJwk>;

/** One admin key a district administrator enrolled. A removed key stays, for the audit log's sake. */
export interface OpsKeyRecord {
  keyId: KeyId;
  publicJwk: OpsPublicJwk;
  /** What the district granted: what the key may do now. */
  scopes: OpsScope[];
  /** What the admin edition asked for, from its registration. A later change may grant no more. */
  requestedScopes: OpsScope[];
  /** The district's own name for the admin. */
  label: string;
  /** Where the admin says its requests come from. Recorded, never trusted for anything. */
  adminOrigin: string;
  enrolledAt: string;
  /** The district administrator who enrolled it. */
  enrolledBy: PrincipalId;
  /** When it was removed, or null while it is enrolled. */
  revokedAt: string | null;
  /** Who removed it. */
  revokedBy: PrincipalId | null;
}

/** One request the district accepted or refused after its signature verified. */
export interface OpsAuditRecord {
  /** `opa_` and 96 random bits: the `auditId` an action answers with. */
  id: string;
  keyId: string;
  /** The acting operator, as the signed header names them. */
  operator: string;
  /** The ops route's name, such as `directory.action`, or `unknown-route`. */
  route: string;
  /** What the request was aimed at: a principal ID and action, a device ID, a version. Never free text. */
  target: string | null;
  /** `ok`, `applied`, `unchanged`, `refused:<reason>` or `error:<code>`. */
  result: string;
  at: string;
}

/**
 * Where the district keeps its ops keys, the nonces it has seen and its ops audit log. Each method is
 * one transaction; {@link OpsStore.claimNonce} in particular must be atomic, so of two copies of one
 * signed request exactly one is served.
 */
export interface OpsStore {
  /** Every key, enrolled or removed, newest first. */
  listKeys(): Promise<OpsKeyRecord[]>;
  findKey(keyId: string): Promise<OpsKeyRecord | undefined>;
  /** Stores a new key, or re-enrolls a removed one. `conflict` if the key is enrolled already. */
  enrollKey(record: OpsKeyRecord): Promise<void>;
  /** Changes an enrolled key's scopes. False if it is not enrolled. */
  setScopes(keyId: string, scopes: readonly OpsScope[]): Promise<boolean>;
  /** Removes an enrolled key. False if it was not enrolled. */
  removeKey(keyId: string, at: string, by: PrincipalId): Promise<boolean>;
  /** Records a nonce until `expiresAtMs`, forgetting expired ones. False if the key already used it. */
  claimNonce(keyId: string, nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  /** Appends an audit entry, forgetting entries older than `retainAfter`. */
  appendAudit(entry: OpsAuditRecord, retainAfter: string): Promise<void>;
  /** The newest audit entries, newest first. */
  listAudit(limit: number): Promise<OpsAuditRecord[]>;
}

/** An {@link OpsStore} in memory, for tests and the harness. */
export class InMemoryOpsStore implements OpsStore {
  readonly #keys = new Map<string, OpsKeyRecord>();
  readonly #nonces = new Map<string, number>();
  #audit: OpsAuditRecord[] = [];

  async listKeys(): Promise<OpsKeyRecord[]> {
    return [...this.#keys.values()].toReversed().map((k) => structuredClone(k));
  }

  async findKey(keyId: string): Promise<OpsKeyRecord | undefined> {
    const key = this.#keys.get(keyId);
    return key === undefined ? undefined : structuredClone(key);
  }

  async enrollKey(record: OpsKeyRecord): Promise<void> {
    const existing = this.#keys.get(record.keyId);
    if (existing !== undefined && existing.revokedAt === null) throw new EducateOsError("conflict", "That admin key is already enrolled.");
    // Re-enrolled keys move to the top, as the durable store's newest row does.
    this.#keys.delete(record.keyId);
    this.#keys.set(record.keyId, structuredClone(record));
  }

  async setScopes(keyId: string, scopes: readonly OpsScope[]): Promise<boolean> {
    const key = this.#keys.get(keyId);
    if (key === undefined || key.revokedAt !== null) return false;
    key.scopes = [...scopes];
    return true;
  }

  async removeKey(keyId: string, at: string, by: PrincipalId): Promise<boolean> {
    const key = this.#keys.get(keyId);
    if (key === undefined || key.revokedAt !== null) return false;
    key.revokedAt = at;
    key.revokedBy = by;
    return true;
  }

  async claimNonce(keyId: string, nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [key, expires] of this.#nonces) if (expires < nowMs) this.#nonces.delete(key);
    const key = `${keyId}\n${nonce}`;
    if (this.#nonces.has(key)) return false;
    this.#nonces.set(key, expiresAtMs);
    return true;
  }

  async appendAudit(entry: OpsAuditRecord, retainAfter: string): Promise<void> {
    this.#audit = [...this.#audit.filter((e) => e.at >= retainAfter), { ...entry }];
  }

  async listAudit(limit: number): Promise<OpsAuditRecord[]> {
    return this.#audit.slice(-limit).toReversed().map((e) => ({ ...e }));
  }

  /** How many nonces are remembered, for tests. */
  get nonceCount(): number {
    return this.#nonces.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Enrollment

/** Where an admin edition says it runs: `https://<host>`, or a local development origin. */
const AdminOrigin = z.string().max(300).regex(/^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/, "expected an https origin");

/**
 * The registration an admin edition shows when an operator enrolls a district (`OpsRegistration` in
 * `@educateos/admin`'s `src/shared/api.ts`): its origin, its key ID and public key, and the scopes
 * it asks for. A district administrator pastes it into district /admin → Operations as it is.
 */
export const OpsRegistrationBundle = z.strictObject({
  adminOrigin: AdminOrigin,
  keyId: KeyId,
  publicKey: Ed25519PublicKey,
  scopes: z.array(OpsScope).min(1).max(OpsScope.options.length),
});
/** An admin edition's registration. */
export type OpsRegistrationBundle = z.infer<typeof OpsRegistrationBundle>;

/** The scopes a district grants, each once, at least one. */
export const GrantedOpsScopes = z.array(OpsScope).min(1).max(OpsScope.options.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "each scope at most once");

/** `POST /api/admin/ops/keys`: the pasted registration, the scopes granted, and an optional label. */
export const EnrollOpsKeyInput = z.strictObject({
  registration: OpsRegistrationBundle,
  scopes: GrantedOpsScopes,
  label: z.string().trim().min(1).max(80).optional(),
});
/** An enrollment. */
export type EnrollOpsKeyInput = z.infer<typeof EnrollOpsKeyInput>;

/** An enrolled admin key as the Operations page lists it: never its public key material beyond its ID. */
export const OpsKeyBody = z.strictObject({
  keyId: z.string(),
  label: z.string(),
  adminOrigin: z.string(),
  scopes: z.array(OpsScope),
  requestedScopes: z.array(OpsScope),
  enrolledAt: z.string(),
  enrolledBy: z.strictObject({ principalId: PrincipalId, displayName: z.string() }),
  status: z.enum(["enrolled", "removed"]),
  removedAt: z.string().optional(),
});
/** An ops key body. */
export type OpsKeyBody = z.infer<typeof OpsKeyBody>;

/** One entry of the district's ops audit log as the Operations page shows it. */
export const OpsAuditBody = z.strictObject({
  id: z.string(),
  keyId: z.string(),
  /** The admin's label for the key, if it is still in the keyring. */
  label: z.string().optional(),
  operator: z.string(),
  route: z.string(),
  target: z.string().optional(),
  result: z.string(),
  at: z.string(),
});
/** An ops audit body. */
export type OpsAuditBody = z.infer<typeof OpsAuditBody>;

// ---------------------------------------------------------------------------------------------
// Refusals

/** Why an ops request was refused, beyond the verifier's reasons. */
export type OpsFailure = OpsRejectionReason | "not-supported" | "analytics-not-configured" | "analytics-unavailable";

const REJECTION_CODES: Record<OpsRejectionReason, ErrorCode> = {
  "missing-signature": "unauthenticated",
  "malformed-signature": "unauthenticated",
  "stale": "unauthenticated",
  "unknown-key": "unauthenticated",
  "body-too-large": "validation-failed",
  "bad-signature": "unauthenticated",
  "replayed": "unauthenticated",
  "unknown-route": "not-found",
  "scope-denied": "forbidden",
};

const REJECTION_MESSAGES: Record<OpsRejectionReason, string> = {
  "missing-signature": "Sign the request with an enrolled ops key.",
  "malformed-signature": "The ops signature headers are malformed.",
  "stale": "The request's timestamp is too far from the district's clock.",
  "unknown-key": "That ops key is not enrolled at this district.",
  "body-too-large": "The request body is too large.",
  "bad-signature": "The ops signature does not verify.",
  "replayed": "That request was already received.",
  "unknown-route": "No such ops route.",
  "scope-denied": "This district has not granted that key the scope this route needs.",
};

/** A refusal raised inside a handler, answered with its status, code and reason. */
export class OpsRefusal extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly reason: OpsFailure | undefined;

  constructor(status: number, code: ErrorCode, message: string, reason?: OpsFailure) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

function opsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function refusal(status: number, code: ErrorCode, reason: OpsFailure | undefined, message: string): Response {
  return opsJson({ code, ...(reason === undefined ? {} : { reason }), message }, status);
}


// ---------------------------------------------------------------------------------------------
// The district's own facts the ops API reports

/** What the district knows about the release it runs. */
export interface OpsReleaseInfo {
  /** The release version or Worker version tag. Unset, health and releases say `unknown`. */
  version?: string | undefined;
  /** The commit it was built from, if the deploy says. */
  commit?: string | undefined;
  /** When it was installed, if the deploy says. */
  installedAt?: string | undefined;
  /** Its release channel. Defaults to `stable`. */
  channel?: "stable" | "beta" | undefined;
}

/** The parts of an analytics report the district's Cloudflare account supplies: everything but AI. */
export type CloudflareAnalyticsReport = Omit<OpsAnalyticsResponse, "ai">;

/** Where the analytics proxy's Cloudflare figures come from. See `ops-analytics.ts`. */
export interface OpsAnalyticsSource {
  report(range: AnalyticsRange): Promise<CloudflareAnalyticsReport>;
}

/** This month's AI use, from the district's own ledger. */
export interface OpsAiMonth {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** Requests that read from the prompt cache. */
  cacheHits: number;
  costUsdNanos: number;
  budgetUsdNanos?: number | undefined;
}

/** The district's AI use, from its own ledger (authoritative for budgets, ADR-0008). */
export interface OpsAiUsage {
  /** This month's figures, or undefined when the district keeps no AI ledger. */
  month(): Promise<OpsAiMonth | undefined>;
  /** One principal's AI spend this month, in USD nanos. */
  principalMonth(principalId: PrincipalId): Promise<number>;
}

/** What {@link DistrictOps} is built from. */
export interface DistrictOpsOptions {
  store: OpsStore;
  directory: AcademicStore;
  devices: DeviceCredentials;
  /** Which system owns the district's principals: a principal a roster owns is `rostered`. */
  authority: AuthorityMap;
  release: OpsReleaseInfo;
  /** The Cloudflare analytics proxy, when the district holds an analytics token. Unset, analytics is 501. */
  analytics?: OpsAnalyticsSource | undefined;
  ai: OpsAiUsage;
  now(): Date;
}

/** A release version as the fleet schema accepts it, or `unknown`. */
function versionOf(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(value) ? value : "unknown";
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/** How a sign-in issuer is shown: only the issuers the district can name. */
function signInMethodOf(issuer: string): DirectoryEntry["signInMethods"][number] | undefined {
  if (issuer === GOOGLE_ISSUER) return "google";
  const host = (() => {
    try {
      return new URL(issuer).hostname;
    } catch {
      return "";
    }
  })();
  if (host === "clever.com" || host.endsWith(".clever.com")) return "clever";
  if (host.endsWith("classlink.com")) return "classlink";
  return undefined;
}

/** `major.minor.patch` as numbers; anything unreadable is 0.0.0, so a forced update catches it. */
function semver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function below(version: string, minimum: string): boolean {
  const [a, b] = [semver(version), semver(minimum)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

interface HandlerContext {
  match: OpsRouteMatch;
  url: URL;
  body: unknown;
  keyId: string;
  operator: string;
  auditId: string;
  /** Set by a handler that changed something, or found nothing to change. */
  outcome?: "applied" | "unchanged";
  /** What the request was aimed at, for the audit log. */
  target?: string;
}

/**
 * The district's ops API and its keyring. {@link serve} is the `/api/ops/*` choke point; the other
 * methods are what district /admin → Operations calls, behind the district's own sign-in and policy.
 */
export class DistrictOps {
  readonly #options: DistrictOpsOptions;
  readonly #verifier;

  constructor(options: DistrictOpsOptions) {
    this.#options = options;
    const { store, now } = options;
    const nonces: NonceStore = { claim: (keyId, nonce, expiresAtMs) => store.claimNonce(keyId, nonce, expiresAtMs, now().getTime()) };
    this.#verifier = createOpsVerifier({
      keys: {
        find: async (keyId): Promise<OpsKey | undefined> => {
          const record = await store.findKey(keyId);
          if (record === undefined || record.revokedAt !== null) return undefined;
          return { keyId: record.keyId, publicKey: record.publicJwk.x, scopes: record.scopes };
        },
      },
      nonces,
      now,
    });
  }

  // -------------------------------------------------------------------------------------------
  // The keyring, for district /admin → Operations

  /** Every key, enrolled or removed, newest first, with who enrolled each. */
  async keys(snapshot: DistrictDirectorySnapshot): Promise<OpsKeyBody[]> {
    return (await this.#options.store.listKeys()).map((record) => keyBody(record, snapshot));
  }

  /**
   * Enrolls an admin edition's key under the scopes granted, which must be among those it asked for.
   * The key ID must be the one its public key names, so a registration can't be edited to front for
   * another key.
   */
  async enroll(input: EnrollOpsKeyInput, by: PrincipalId, snapshot: DistrictDirectorySnapshot): Promise<OpsKeyBody> {
    const { registration, scopes } = input;
    if (await keyIdFor(registration.publicKey) !== registration.keyId) {
      throw new EducateOsError("validation-failed", "The registration's key ID does not match its public key. Copy the registration again from the admin.");
    }
    const extra = scopes.filter((scope) => !registration.scopes.includes(scope));
    if (extra.length > 0) throw new EducateOsError("validation-failed", `The admin did not ask for ${extra.join(", ")}.`);
    const record: OpsKeyRecord = {
      keyId: registration.keyId,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: registration.publicKey },
      scopes: [...scopes],
      requestedScopes: [...registration.scopes],
      label: input.label ?? new URL(registration.adminOrigin).host,
      adminOrigin: registration.adminOrigin,
      enrolledAt: this.#options.now().toISOString(),
      enrolledBy: by,
      revokedAt: null,
      revokedBy: null,
    };
    await this.#options.store.enrollKey(record);
    return keyBody(record, snapshot);
  }

  /** Changes an enrolled key's scopes, among those it asked for. */
  async setScopes(keyId: string, scopes: readonly OpsScope[], snapshot: DistrictDirectorySnapshot): Promise<OpsKeyBody> {
    const record = await this.#options.store.findKey(keyId);
    if (record === undefined || record.revokedAt !== null) throw new EducateOsError("not-found", "No such admin key is enrolled.");
    const extra = scopes.filter((scope) => !record.requestedScopes.includes(scope));
    if (extra.length > 0) throw new EducateOsError("validation-failed", `The admin did not ask for ${extra.join(", ")}.`);
    await this.#options.store.setScopes(keyId, scopes);
    return keyBody({ ...record, scopes: [...scopes] }, snapshot);
  }

  /** Removes an enrolled key: its next request is refused. The district keeps working without it. */
  async remove(keyId: string, by: PrincipalId, snapshot: DistrictDirectorySnapshot): Promise<OpsKeyBody> {
    const removed = await this.#options.store.removeKey(keyId, this.#options.now().toISOString(), by);
    const record = await this.#options.store.findKey(keyId);
    if (!removed || record === undefined) throw new EducateOsError("not-found", "No such admin key is enrolled.");
    return keyBody(record, snapshot);
  }

  /** The newest entries of the ops audit log, with each key's label. */
  async audit(): Promise<OpsAuditBody[]> {
    const [entries, keys] = await Promise.all([this.#options.store.listAudit(OPS_AUDIT_PAGE), this.#options.store.listKeys()]);
    const labels = new Map(keys.map((k) => [k.keyId as string, k.label]));
    return entries.map((entry) => ({
      id: entry.id,
      keyId: entry.keyId,
      ...(labels.has(entry.keyId) ? { label: labels.get(entry.keyId)! } : {}),
      operator: entry.operator,
      route: entry.route,
      ...(entry.target === null ? {} : { target: entry.target }),
      result: entry.result,
      at: entry.at,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // /api/ops/*

  /**
   * Serves one request under `/api/ops/`: verified first, refused with the verifier's status and
   * reason if it fails, then answered by its route's handler, and recorded in the district's ops
   * audit log. Only requests whose signature verified are recorded: anything else names an operator
   * nobody vouched for.
   */
  async serve(request: Request): Promise<Response> {
    try {
      const verdict = await this.#verifier.verify(request);
      if (!verdict.ok) {
        // These are decided after the signature held, so the key and operator headers are authentic.
        if (verdict.reason === "replayed" || verdict.reason === "unknown-route" || verdict.reason === "scope-denied") {
          const route = verdict.reason === "unknown-route" ? "unknown-route" : this.#routeName(request);
          await this.#record({
            keyId: request.headers.get(OPS_HEADERS.keyId) ?? "",
            operator: request.headers.get(OPS_HEADERS.operator) ?? "",
            route,
            target: null,
            result: `refused:${verdict.reason}`,
          });
        }
        return refusal(verdict.status, REJECTION_CODES[verdict.reason], verdict.reason, REJECTION_MESSAGES[verdict.reason]);
      }
      const text = new TextDecoder().decode(verdict.body);
      let body: unknown = {};
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }
      }
      const context: HandlerContext = {
        match: verdict.match,
        url: new URL(request.url),
        body,
        keyId: verdict.keyId,
        operator: verdict.operator,
        auditId: randomId("opa_"),
      };
      const name = verdict.match.route.name;
      let response: Response;
      let result: string;
      try {
        const answer = await this.#handle(name, context);
        response = opsJson(OPS_RESPONSES[name].parse(answer));
        result = context.outcome ?? "ok";
      } catch (error) {
        if (error instanceof OpsRefusal) {
          response = refusal(error.status, error.code, error.reason, error.message);
          result = `error:${error.reason ?? error.code}`;
        } else if (error instanceof EducateOsError) {
          response = refusal(ERROR_STATUS[error.code], error.code, undefined, error.message);
          result = `error:${error.code}`;
        } else {
          console.error("district ops request failed", { route: name, error });
          response = refusal(503, "unavailable", undefined, "The request could not be completed.");
          result = "error:unavailable";
        }
      }
      await this.#record({
        id: context.auditId,
        keyId: context.keyId,
        operator: context.operator,
        route: name,
        target: context.target ?? null,
        result,
      });
      return response;
    } finally {
      if (!request.bodyUsed) await request.body?.cancel();
    }
  }

  /** The route a request named, for the audit log of a refused one. */
  #routeName(request: Request): string {
    return matchOpsRoute(request.method, new URL(request.url).pathname)?.route.name ?? "unknown-route";
  }

  async #record(entry: Omit<OpsAuditRecord, "id" | "at"> & { id?: string }): Promise<void> {
    const now = this.#options.now();
    await this.#options.store.appendAudit(
      { id: entry.id ?? randomId("opa_"), keyId: entry.keyId, operator: entry.operator, route: entry.route, target: entry.target, result: entry.result, at: now.toISOString() },
      new Date(now.getTime() - OPS_AUDIT_RETENTION_MS).toISOString(),
    );
  }

  async #handle(name: OpsRouteName, ctx: HandlerContext): Promise<unknown> {
    switch (name) {
      case "health": return this.#health();
      case "analytics": return this.#analytics(ctx);
      case "releases": return this.#releases();
      case "directory.list": return this.#directoryList(ctx);
      case "directory.get": return this.#directoryGet(ctx);
      case "directory.action": return this.#directoryAction(ctx);
      case "devices.list": return this.#devicesList(ctx);
      case "devices.revoke": return this.#devicesRevoke(ctx);
      case "devices.revoke-below-version": return this.#revokeBelowVersion(ctx);
    }
  }

  // Health and releases

  async #health(): Promise<unknown> {
    const { snapshot } = await this.#options.directory.load();
    const everyone = people(snapshot);
    const active = everyone.filter((p) => p.status === "active").length;
    const devices = (await this.#options.devices.store.list()).filter((d) => d.status === "active").length;
    const { release } = this.#options;
    return {
      status: "ok",
      releaseVersion: versionOf(release.version),
      ...(release.commit !== undefined && /^[0-9a-f]{7,40}$/.test(release.commit) ? { commit: release.commit } : {}),
      checkedAt: this.#options.now().toISOString(),
      components: [
        { name: "directory", status: "ok", detail: `${active} active of ${everyone.length} people in ${snapshot.schools.length} schools, ${snapshot.offerings.length} classes` },
        {
          name: "devices",
          status: "ok",
          detail: this.#options.devices.available ? `${devices} active devices` : "device sign-in is not configured",
        },
        { name: "analytics", status: "ok", detail: this.#options.analytics === undefined ? "no analytics token is configured" : "configured" },
      ],
    };
  }

  #releases(): unknown {
    const { release } = this.#options;
    return {
      current: { version: versionOf(release.version), ...(release.installedAt === undefined ? {} : { installedAt: release.installedAt }) },
      channel: release.channel ?? "stable",
      // The district doesn't watch the registry yet: what is available is the admin's to know.
      available: [],
    };
  }

  // Analytics

  async #analytics(ctx: HandlerContext): Promise<OpsAnalyticsResponse> {
    const query = OpsAnalyticsQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new OpsRefusal(400, "validation-failed", "Ask for range=24h, 7d or 30d.");
    ctx.target = query.data.range;
    const source = this.#options.analytics;
    if (source === undefined) {
      throw new OpsRefusal(501, "unavailable", "This district has no Cloudflare analytics token (CF_ANALYTICS_TOKEN).", "analytics-not-configured");
    }
    let report: CloudflareAnalyticsReport;
    try {
      report = await source.report(query.data.range);
    } catch (error) {
      console.error("district analytics failed", { error });
      throw new OpsRefusal(502, "unavailable", "Cloudflare's analytics could not be read.", "analytics-unavailable");
    }
    return { ...report, ai: await this.#aiFigures() };
  }

  /**
   * AI figures from the district's own ledger, authoritative for budgets. AI Gateway's own figures
   * are not read here yet, so the gateway cost is the ledger's: the admin shows no discrepancy.
   */
  async #aiFigures(): Promise<OpsAnalyticsResponse["ai"]> {
    const month = await this.#options.ai.month().catch(() => undefined);
    const cost = month?.costUsdNanos ?? 0;
    return {
      requests: month?.requests ?? 0,
      tokensIn: month?.tokensIn ?? 0,
      tokensOut: month?.tokensOut ?? 0,
      cacheHits: month?.cacheHits ?? 0,
      gatewayCostUsdNanos: cost,
      ledgerCostUsdNanos: cost,
      ...(month?.budgetUsdNanos === undefined ? {} : { monthlyBudgetUsdNanos: month.budgetUsdNanos }),
      monthToDateUsdNanos: cost,
    };
  }

  // Directory

  async #directoryList(ctx: HandlerContext): Promise<unknown> {
    const query = OpsDirectoryQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new OpsRefusal(400, "validation-failed", "The directory query is invalid.");
    const { snapshot } = await this.#options.directory.load();
    const needle = query.data.query?.toLowerCase();
    const entries = people(snapshot)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((p) => query.data.cursor === undefined || p.id > query.data.cursor)
      .map((p) => this.#entry(snapshot, p))
      .filter((e) =>
        (needle === undefined || e.displayName.toLowerCase().includes(needle) || (e.email?.toLowerCase().includes(needle) ?? false))
        && (query.data.role === undefined || e.roles.includes(query.data.role))
        && (query.data.status === undefined || e.status === query.data.status)
      );
    const page = entries.slice(0, OPS_PAGE_SIZE);
    return { entries: page, ...(entries.length > OPS_PAGE_SIZE ? { nextCursor: page.at(-1)!.principal } : {}) };
  }

  async #directoryGet(ctx: HandlerContext): Promise<unknown> {
    const { snapshot } = await this.#options.directory.load();
    const principal = this.#person(snapshot, ctx.match.params.principal);
    ctx.target = principal.id;
    const devices = (await this.#options.devices.store.list(principal.id)).filter((d) => d.status === "active").length;
    const identities = principal.externalIdentities.flatMap((identity) => {
      const method = signInMethodOf(identity.issuer);
      return method === undefined ? [] : [{ method, issuer: identity.issuer }];
    });
    return {
      entry: this.#entry(snapshot, principal),
      identities,
      deviceCount: devices,
      aiUsageThisMonthUsdNanos: await this.#options.ai.principalMonth(principal.id).catch(() => 0),
    };
  }

  #person(snapshot: DistrictDirectorySnapshot, id: string | undefined): Principal {
    const principal = people(snapshot).find((p) => p.id === id);
    if (principal === undefined) throw new OpsRefusal(404, "not-found", "No such person in this district.");
    return principal;
  }

  #entry(snapshot: DistrictDirectorySnapshot, principal: Principal): DirectoryEntry {
    const roles: DirectoryRole[] = [principal.kind === "student" ? "student" : principal.kind === "guardian" ? "guardian" : "staff"];
    if (isDistrictAdmin(snapshot, principal.id, this.#options.now())) roles.push("admin");
    const schoolIds = new Set<string>();
    for (const assignment of snapshot.roleAssignments) {
      if (assignment.principalId === principal.id && assignment.scope.level === "school") schoolIds.add(assignment.scope.schoolId);
    }
    for (const enrollment of snapshot.enrollments) {
      if (enrollment.principalId !== principal.id) continue;
      const offering = snapshot.offerings.find((o) => o.id === enrollment.offeringId);
      if (offering !== undefined) schoolIds.add(offering.schoolId);
    }
    const schools = snapshot.schools.filter((s) => schoolIds.has(s.id)).map((s) => s.name).slice(0, 50);
    const methods = [...new Set(principal.externalIdentities.map((i) => signInMethodOf(i.issuer)).filter((m) => m !== undefined))];
    return {
      principal: principal.id,
      displayName: principal.displayName,
      ...(principal.email === undefined ? {} : { email: principal.email }),
      roles,
      schools,
      status: principal.status === "active" ? "active" : "suspended",
      signInMethods: methods,
      rostered: this.#options.authority.principal !== "local",
      // The district has no per-person AI access setting: AI follows its policies and funding pools.
      aiAccess: principal.kind === "guardian" ? "none" : "standard",
    };
  }

  async #directoryAction(ctx: HandlerContext): Promise<unknown> {
    const action = ctx.match.params.action as DirectoryAction;
    const principalId = ctx.match.params.principal;
    ctx.target = `${principalId}/${action}`;
    const parsed = DirectoryActionBodies[action].safeParse(ctx.body);
    if (!parsed.success) throw new OpsRefusal(400, "validation-failed", `The ${action} body is invalid.`);
    const by = `ops:${ctx.keyId}`;
    switch (action) {
      case "suspend":
      case "restore": {
        const changed = await this.#setStatus(principalId, action === "suspend" ? "inactive" : "active");
        // Suspension signs the person out of every phone, as an administrator's deactivation does.
        const revoked = action === "suspend"
          ? await this.#options.devices.revokePrincipal(principalId as PrincipalId, { by, reason: "principal-inactive" })
          : 0;
        ctx.outcome = changed || revoked > 0 ? "applied" : "unchanged";
        return { applied: changed || revoked > 0, auditId: ctx.auditId };
      }
      case "sign-out-everywhere": {
        const { snapshot } = await this.#options.directory.load();
        this.#person(snapshot, principalId);
        const revoked = await this.#options.devices.revokePrincipal(principalId as PrincipalId, { by, reason: "admin-revoked" });
        ctx.outcome = revoked > 0 ? "applied" : "unchanged";
        return { applied: revoked > 0, auditId: ctx.auditId };
      }
      case "roles": {
        const body = parsed.data as z.infer<typeof DirectoryActionBodies["roles"]>;
        if ([...body.grant, ...body.revoke].includes("staff")) {
          throw new OpsRefusal(501, "unavailable", "Whether someone is staff comes from the district's roster; it can't be granted here.", "not-supported");
        }
        const changed = await this.#setAdmin(principalId, body.grant.includes("admin") ? true : body.revoke.includes("admin") ? false : undefined);
        ctx.outcome = changed ? "applied" : "unchanged";
        return { applied: changed, auditId: ctx.auditId };
      }
      case "ai-access":
        throw new OpsRefusal(501, "unavailable", "This district has no per-person AI access setting; AI follows its policies and funding pools.", "not-supported");
    }
  }

  /** Sets a principal's status. Refuses to suspend the district's last administrator. */
  async #setStatus(principalId: string, status: "active" | "inactive"): Promise<boolean> {
    const { snapshot, version } = await this.#options.directory.load();
    const principal = this.#person(snapshot, principalId);
    if (principal.status === status) return false;
    if (status === "inactive") this.#keepsAnAdmin(snapshot, principal.id);
    const updated: Principal = { ...principal, status };
    await this.#options.directory.commit({ ...snapshot, principals: snapshot.principals.map((p) => (p.id === principal.id ? updated : p)) }, version);
    return true;
  }

  /** Grants or revokes district administration, as `admin.grantDistrictAdmin` does. */
  async #setAdmin(principalId: string, grant: boolean | undefined): Promise<boolean> {
    if (grant === undefined) return false;
    const { snapshot, version } = await this.#options.directory.load();
    const principal = this.#person(snapshot, principalId);
    const now = this.#options.now();
    const holds = isDistrictAdmin(snapshot, principal.id, now);
    if (grant) {
      if (holds) return false;
      if (principal.kind !== "staff") throw new OpsRefusal(409, "conflict", "Only staff can be district administrators.");
      if (principal.status !== "active") throw new OpsRefusal(409, "conflict", "That person is suspended; restore them first.");
      const assignment: RoleAssignment = {
        principalId: principal.id,
        role: "district-admin",
        scope: { level: "district", districtId: snapshot.district.id },
        source: "local-grant",
      };
      await this.#options.directory.commit({ ...snapshot, roleAssignments: [...snapshot.roleAssignments, assignment] }, version);
      return true;
    }
    if (!holds) return false;
    const isAdminAssignment = (a: RoleAssignment) => a.principalId === principal.id && a.role === "district-admin" && a.scope.level === "district";
    if (snapshot.roleAssignments.some((a) => isAdminAssignment(a) && a.source !== "local-grant")) {
      throw new OpsRefusal(409, "conflict", "That administrator role comes from the roster; change it there.");
    }
    this.#keepsAnAdmin(snapshot, principal.id);
    await this.#options.directory.commit({ ...snapshot, roleAssignments: snapshot.roleAssignments.filter((a) => !isAdminAssignment(a)) }, version);
    return true;
  }

  #keepsAnAdmin(snapshot: DistrictDirectorySnapshot, principalId: PrincipalId): void {
    const now = this.#options.now();
    if (!isDistrictAdmin(snapshot, principalId, now)) return;
    if (!snapshot.principals.some((p) => p.id !== principalId && isDistrictAdmin(snapshot, p.id, now))) {
      throw new OpsRefusal(409, "conflict", "That is the district's last administrator.");
    }
  }

  // Devices

  async #devicesList(ctx: HandlerContext): Promise<unknown> {
    const query = OpsDevicesQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new OpsRefusal(400, "validation-failed", "The devices query is invalid.");
    const [{ snapshot }, devices] = await Promise.all([this.#options.directory.load(), this.#options.devices.store.list(query.data.principal)]);
    const entries = devices
      .filter((d) => query.data.status === undefined || d.status === query.data.status)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((d) => query.data.cursor === undefined || d.id > query.data.cursor)
      .flatMap((d) => deviceEntry(snapshot, d));
    const page = entries.slice(0, OPS_PAGE_SIZE);
    return { devices: page, ...(entries.length > OPS_PAGE_SIZE ? { nextCursor: page.at(-1)!.id } : {}) };
  }

  async #devicesRevoke(ctx: HandlerContext): Promise<unknown> {
    if (!OpsRevokeDeviceBody.safeParse(ctx.body).success) throw new OpsRefusal(400, "validation-failed", "The revoke body is invalid.");
    const id = DeviceId.safeParse(ctx.match.params.id);
    ctx.target = ctx.match.params.id;
    const device = id.success ? await this.#options.devices.store.get(id.data) : undefined;
    if (device === undefined) throw new OpsRefusal(404, "not-found", "No such device.");
    const revoked = await this.#options.devices.revoke(device.id, { by: `ops:${ctx.keyId}`, reason: "admin-revoked" });
    ctx.outcome = revoked ? "applied" : "unchanged";
    return { applied: revoked, auditId: ctx.auditId };
  }

  async #revokeBelowVersion(ctx: HandlerContext): Promise<unknown> {
    const body = OpsRevokeBelowVersionBody.safeParse(ctx.body);
    if (!body.success) throw new OpsRefusal(400, "validation-failed", "Send minimumVersion as major.minor.patch.");
    const { minimumVersion, platform } = body.data;
    ctx.target = platform === undefined ? minimumVersion : `${platform}/${minimumVersion}`;
    const ids = (await this.#options.devices.store.list())
      .filter((d) => d.status === "active" && (d.platform === "ios" || d.platform === "android"))
      .filter((d) => (platform === undefined || d.platform === platform) && below(d.appVersion, minimumVersion))
      .map((d) => d.id);
    const revoked = await this.#options.devices.store.revoke(ids, this.#options.now().toISOString(), { by: `ops:${ctx.keyId}`, reason: "app-version" });
    ctx.outcome = revoked.length > 0 ? "applied" : "unchanged";
    return { revoked: revoked.length, auditId: ctx.auditId };
  }
}

/** The people in the directory: everyone but service principals. */
function people(snapshot: DistrictDirectorySnapshot): Principal[] {
  return snapshot.principals.filter((p) => p.kind !== "service");
}

function keyBody(record: OpsKeyRecord, snapshot: DistrictDirectorySnapshot): OpsKeyBody {
  const name = snapshot.principals.find((p) => p.id === record.enrolledBy)?.displayName ?? "A former administrator";
  return {
    keyId: record.keyId,
    label: record.label,
    adminOrigin: record.adminOrigin,
    scopes: [...record.scopes],
    requestedScopes: [...record.requestedScopes],
    enrolledAt: record.enrolledAt,
    enrolledBy: { principalId: record.enrolledBy, displayName: name },
    status: record.revokedAt === null ? "enrolled" : "removed",
    ...(record.revokedAt === null ? {} : { removedAt: record.revokedAt }),
  };
}

/** A phone as the ops API lists it. Browser and other devices aren't phones, so they aren't listed. */
function deviceEntry(snapshot: DistrictDirectorySnapshot, device: DeviceRecord): DeviceEntry[] {
  if (device.platform !== "ios" && device.platform !== "android") return [];
  const owner = snapshot.principals.find((p) => p.id === device.principalId);
  const role: DirectoryRole = owner?.kind === "student" ? "student" : owner?.kind === "guardian" ? "guardian" : "staff";
  return [{
    id: device.id,
    principal: device.principalId,
    ownerName: owner?.displayName ?? "Unknown person",
    ownerRole: role,
    label: device.label,
    platform: device.platform,
    ...(device.model === "" ? {} : { model: device.model.slice(0, 200) }),
    appVersion: versionOf(device.appVersion) === "unknown" ? "0.0.0" : device.appVersion,
    registeredAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.lastCountry !== null && /^[A-Z]{2}$/.test(device.lastCountry) ? { lastCountry: device.lastCountry } : {}),
    push: device.pushToken !== null,
    status: device.status,
  }];
}
