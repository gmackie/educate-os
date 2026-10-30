// Shared test pieces: Access assertions signed with the run's key, a fake district that serves
// /api/ops/* behind the protocol's own verifier, and the admin's dependencies over the real D1.
import { env } from "cloudflare:test";
import { operatorVerifier } from "@educateos/control-plane/access";
import {
  createOpsVerifier,
  InMemoryNonceStore,
  type DeviceEntry,
  type DirectoryEntry,
  type OpsAnalyticsResponse,
  type OpsKey,
  type OpsScope,
  Ed25519PublicKey,
} from "@educateos/fleet/ops";
import { createLocalJWKSet, importJWK, SignJWT, type JWK } from "jose";
import type { EnrollmentResponse } from "../src/shared/api.ts";
import { handleAdminRequest, type AdminDeps } from "../src/worker/app.ts";
import { parseAdmins, readConfig } from "../src/worker/config.ts";
import { importKeyEncryptionKey } from "../src/worker/keys.ts";
import { AdminStore } from "../src/worker/store.ts";

export const ADMIN_ORIGIN = "https://admin.educateos.io";
export const ISSUER = "https://educateos-test.cloudflareaccess.com";
export const AUDIENCE = "b".repeat(64);

/** A clock the test moves by hand. */
export function manualClock(start = "2026-10-28T12:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
  };
}

/** Claims for a test assertion. */
export interface Claims {
  sub?: string;
  email?: string;
  aud?: string;
  expiresIn?: string;
  key?: string;
}

/** A Cloudflare Access assertion signed with the run's key (or `key`). */
export async function assertion(claims: Claims = {}): Promise<string> {
  const { key = env.TEST_ACCESS_PRIVATE_JWK, aud = AUDIENCE, expiresIn = "5m", sub = "sub-ops", email = "ops@educateos.io" } = claims;
  return new SignJWT({ sub, email })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(await importJWK(JSON.parse(key) as JWK, "RS256"));
}

let counter = 0;
/** A slug no other test uses, since the suites share one D1. */
export const uniqueSlug = (base = "district") => `${base}-${Date.now().toString(36)}-${counter++}`;

/** People in the fake district: the names a test then looks for in D1. */
export const PEOPLE: DirectoryEntry[] = [
  {
    principal: "prn_ada" as DirectoryEntry["principal"], displayName: "Ada Quillfeather", email: "ada.quillfeather@northfield.example.org",
    roles: ["student"], schools: ["Northfield Middle"], status: "active", signInMethods: ["google"], rostered: true, aiAccess: "standard",
    lastSignInAt: "2026-10-27T08:00:00.000Z",
  },
  {
    principal: "prn_bea" as DirectoryEntry["principal"], displayName: "Beatrix Thornwood", email: "beatrix.thornwood@northfield.example.org",
    roles: ["staff"], schools: ["Northfield High"], status: "active", signInMethods: ["clever"], rostered: false, aiAccess: "extended",
  },
];

/** Devices in the fake district. */
export const DEVICES: DeviceEntry[] = [
  {
    id: "dev_ada_phone", principal: PEOPLE[0]!.principal, ownerName: "Ada Quillfeather", ownerRole: "student", label: "Ada's Pixel",
    platform: "android", model: "Pixel 9", appVersion: "1.1.0", registeredAt: "2026-10-01T00:00:00.000Z", push: true, status: "active",
  },
];

/** An analytics report for `range`. */
export function analyticsReport(range: OpsAnalyticsResponse["range"], requests = 1500): OpsAnalyticsResponse {
  return {
    range, generatedAt: "2026-10-28T12:00:00.000Z", sampled: true,
    workers: [{ script: "northfield-district", invocations: requests, errors: 3, cpuTimeP50Ms: 1.5, cpuTimeP99Ms: 22 }],
    http: { requests, byStatus: [{ status: 200, requests: requests - 3 }, { status: 500, requests: 3 }], p95LatencyMs: 120 },
    series: [{ at: "2026-10-28T11:00:00.000Z", requests: 60, errors: 0 }, { at: "2026-10-28T12:00:00.000Z", requests: 75, errors: 1 }],
    durableObjects: { requests: 900, storageBytes: 4_000_000 },
    storage: { r2Bytes: 50_000_000, d1Bytes: 200_000 },
    ai: { requests: 40, tokensIn: 10_000, tokensOut: 4000, cacheHits: 3, gatewayCostUsdNanos: 12_000_000, ledgerCostUsdNanos: 12_100_000, monthlyBudgetUsdNanos: 50_000_000_000, monthToDateUsdNanos: 900_000_000 },
    signIns: { byMethod: [{ method: "google", count: 30 }, { method: "clever", count: 12 }], failures: 2 },
  };
}

/** What a fake district's ops API was asked, as it would record it in its own audit log. */
export interface DistrictAuditEntry {
  operator: string;
  route: string;
  params: Record<string, string>;
  body: unknown;
}

/** A district serving /api/ops/* behind the protocol's verifier, with in-memory people and devices. */
export class FakeDistrict {
  readonly origin: string;
  readonly keys = new Map<string, OpsKey>();
  readonly audit: DistrictAuditEntry[] = [];
  /** Every request that reached the district, verified or not. */
  requests = 0;
  /** Analytics requests that verified. */
  analyticsCalls = 0;
  /** When true, the district answers 503 to everything. */
  down = false;
  /** When set, the district redirects everything here, as Access would without a bypass. */
  redirectTo: string | undefined;
  readonly #verifier;

  constructor(origin: string, now: () => Date) {
    this.origin = origin;
    this.#verifier = createOpsVerifier({ keys: { find: (id) => this.keys.get(id) }, nonces: new InMemoryNonceStore(now), now });
  }

  /** Registers an admin's key, as district /admin → Operations will. */
  register(enrollment: EnrollmentResponse, scopes: readonly OpsScope[] = enrollment.registration.scopes) {
    const { keyId, publicKey } = enrollment.registration;
    this.keys.set(keyId, { keyId, publicKey: Ed25519PublicKey.parse(publicKey), scopes });
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    this.requests++;
    if (this.down) return new Response("down", { status: 503 });
    if (this.redirectTo !== undefined) return new Response(null, { status: 302, headers: { location: this.redirectTo } });
    const verdict = await this.#verifier.verify(request);
    if (!verdict.ok) return Response.json({ code: "unauthenticated", message: verdict.reason }, { status: verdict.status });
    const { route, params } = verdict.match;
    const text = new TextDecoder().decode(verdict.body);
    const body = text === "" ? undefined : (JSON.parse(text) as unknown);
    const url = new URL(request.url);
    switch (route.name) {
      case "health":
        return Response.json({ status: "ok", releaseVersion: "r000042", checkedAt: "2026-10-28T12:00:00.000Z", components: [{ name: "district", status: "ok" }] });
      case "analytics":
        this.analyticsCalls++;
        return Response.json(analyticsReport((url.searchParams.get("range") ?? "24h") as OpsAnalyticsResponse["range"], 1000 + this.analyticsCalls));
      case "releases":
        return Response.json({ current: { version: "r000042" }, channel: "stable", available: [{ version: "r000043", publishedAt: "2026-10-27T00:00:00.000Z" }] });
      case "directory.list": {
        const query = url.searchParams.get("query")?.toLowerCase();
        const role = url.searchParams.get("role");
        const entries = PEOPLE.filter((p) => (query === undefined || p.displayName.toLowerCase().includes(query)) && (role === null || p.roles.includes(role as never)));
        return Response.json({ entries });
      }
      case "directory.get": {
        const entry = PEOPLE.find((p) => p.principal === params.principal);
        if (entry === undefined) return Response.json({ code: "not-found", message: "No such person." }, { status: 404 });
        return Response.json({ entry, identities: [{ method: "google", issuer: "https://accounts.google.com" }], deviceCount: 1, aiUsageThisMonthUsdNanos: 1000 });
      }
      case "directory.action":
      case "devices.revoke":
      case "devices.revoke-below-version": {
        this.audit.push({ operator: verdict.operator, route: route.name, params, body });
        const auditId = `aud_${this.audit.length}`;
        if (route.name === "devices.revoke-below-version") return Response.json({ revoked: 1, auditId });
        return Response.json({ applied: true, auditId });
      }
      case "devices.list":
        return Response.json({ devices: DEVICES.filter((d) => url.searchParams.get("principal") === null || d.principal === url.searchParams.get("principal")) });
    }
  };
}

/** Routes the admin's district calls to whichever fake owns the origin. */
export function districts(...fakes: FakeDistrict[]): (request: Request) => Promise<Response> {
  return async (request) => {
    const fake = fakes.find((candidate) => new URL(request.url).origin === candidate.origin);
    if (fake === undefined) throw new TypeError("fetch failed");
    return fake.fetch(request);
  };
}

/** The admin's dependencies over the suite's D1. */
export function adminDeps(overrides: Partial<AdminDeps> & { edition?: "hosted" | "oss"; ossOrigins?: string; adminsList?: string } = {}): AdminDeps {
  const { edition = "hosted", ossOrigins, adminsList, ...rest } = overrides;
  const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
  return {
    store: new AdminStore(env.DB),
    config: () => readConfig({ EDITION: edition, ...(ossOrigins === undefined ? {} : { OSS_WORKSPACE_ORIGINS: ossOrigins }) }),
    admins: parseAdmins(adminsList ?? env.ADMINS),
    verifyOperator: operatorVerifier({ issuer: ISSUER, audience: AUDIENCE, keys }),
    keyEncryptionKey: () => importKeyEncryptionKey(env.ADMIN_KEY_ENCRYPTION_KEY),
    fetchDistrict: async () => {
      throw new TypeError("no district");
    },
    ...rest,
  };
}

/** One admin API call, as the SPA makes it. */
export async function call(
  deps: AdminDeps,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; token?: string | null; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  const token = options.token === undefined ? await assertion() : options.token;
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("origin", options.origin ?? ADMIN_ORIGIN);
  }
  return handleAdminRequest(new Request(`${ADMIN_ORIGIN}${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  }), deps);
}

/** Enrolls a fake district and registers the admin's key there. */
export async function enrolled(deps: AdminDeps, district: FakeDistrict, scopes?: readonly OpsScope[]): Promise<EnrollmentResponse> {
  const response = await call(deps, "POST", "/api/workspaces", {
    body: { slug: uniqueSlug(), displayName: "Northfield", origin: district.origin },
  });
  if (response.status !== 201) throw new Error(`enrollment failed: ${response.status} ${await response.text()}`);
  const enrollment = await response.json<EnrollmentResponse>();
  district.register(enrollment, scopes);
  return enrollment;
}

/** A district origin no other test uses. */
export const uniqueOrigin = () => `https://${uniqueSlug("d")}.educateos.io`;
