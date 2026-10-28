// A fake of the admin Worker's /api for the SPA's suite: canned workspaces, analytics, people and
// devices, and a record of every request. Not a test file.
import type { DeviceEntry, DirectoryEntry, OpsAnalyticsResponse } from "@educateos/fleet/ops";
import type { AnalyticsEnvelope, Me, Workspace } from "../../shared/api.ts";

export const NORTHFIELD: Workspace = {
  id: "wks_northfield", slug: "northfield", displayName: "Northfield", origin: "https://northfield.educateos.io",
  edition: "hosted", enrolledAt: "2026-10-01T00:00:00.000Z", status: "active",
};

export const ANALYTICS: OpsAnalyticsResponse = {
  range: "24h", generatedAt: "2026-10-28T12:00:00.000Z", sampled: true,
  workers: [{ script: "northfield-district", invocations: 12_345, errors: 12, cpuTimeP50Ms: 1.4, cpuTimeP99Ms: 21 }],
  http: { requests: 20_000, byStatus: [{ status: 200, requests: 19_950 }, { status: 500, requests: 50 }], p95LatencyMs: 140 },
  series: [{ at: "2026-10-28T10:00:00.000Z", requests: 600, errors: 1 }, { at: "2026-10-28T11:00:00.000Z", requests: 900, errors: 3 }],
  durableObjects: { requests: 5000, storageBytes: 12_500_000 },
  storage: { r2Bytes: 2_000_000_000, d1Bytes: 300_000 },
  ai: { requests: 80, tokensIn: 20_000, tokensOut: 9000, cacheHits: 4, gatewayCostUsdNanos: 2_000_000_000, ledgerCostUsdNanos: 2_100_000_000, monthlyBudgetUsdNanos: 50_000_000_000, monthToDateUsdNanos: 12_500_000_000 },
  signIns: { byMethod: [{ method: "google", count: 70 }, { method: "clever", count: 20 }], failures: 3 },
};

export const ADA: DirectoryEntry = {
  principal: "prn_ada" as DirectoryEntry["principal"], displayName: "Ada Quillfeather", email: "ada@northfield.example.org", roles: ["student"],
  schools: ["Northfield Middle"], status: "active", signInMethods: ["google"], rostered: true, aiAccess: "standard",
};

export const PHONE: DeviceEntry = {
  id: "dev_1", principal: ADA.principal, ownerName: "Ada Quillfeather", ownerRole: "student", label: "Ada's Pixel", platform: "android",
  model: "Pixel 9", appVersion: "1.1.0", registeredAt: "2026-10-01T00:00:00.000Z", push: true, status: "active",
};

/** One request the SPA made. */
export interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

/** The fake API. */
export interface FakeAdminApi {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Recorded[];
  posts: () => Recorded[];
}

export function fakeAdminApi(options: { me?: Partial<Me>; workspaces?: Workspace[] } = {}): FakeAdminApi {
  const requests: Recorded[] = [];
  const me: Me = { operator: { email: "ops@educateos.io", role: "admin" }, edition: "hosted", ...options.me };
  const workspaces = options.workspaces ?? [NORTHFIELD];
  const routes: [RegExp, string, (match: RegExpExecArray, url: URL, body: unknown) => unknown][] = [
    [/^\/api\/me$/, "GET", () => me],
    [/^\/api\/workspaces$/, "GET", () => workspaces],
    [/^\/api\/workspaces$/, "POST", (_m, _u, body) => {
      const input = body as { slug: string; displayName: string; origin: string };
      const workspace = { ...NORTHFIELD, id: "wks_new", ...input, status: "pending", key: { keyId: "ed25519-key", publicKey: "pub", createdAt: NORTHFIELD.enrolledAt } };
      return { workspace, registration: { adminOrigin: "https://admin.educateos.io", keyId: "ed25519-key", publicKey: "pub", scopes: ["health"] }, instructions: [`Sign in to ${input.origin}/admin as a district administrator.`] };
    }],
    [/^\/api\/workspaces\/([^/]+)$/, "GET", (m) => ({ ...workspaces.find((w) => w.id === m[1]), key: { keyId: "ed25519-key", publicKey: "pub", createdAt: NORTHFIELD.enrolledAt } })],
    [/^\/api\/workspaces\/[^/]+\/health$/, "GET", () => ({ status: "ok", releaseVersion: "r000042", checkedAt: "2026-10-28T12:00:00.000Z", components: [] })],
    [/^\/api\/workspaces\/[^/]+\/analytics$/, "GET", (_m, url): AnalyticsEnvelope => ({
      analytics: { ...ANALYTICS, range: (url.searchParams.get("range") ?? "24h") as OpsAnalyticsResponse["range"] },
      fetchedAt: "2026-10-28T12:00:00.000Z", cached: false, stale: false,
    })],
    [/^\/api\/workspaces\/[^/]+\/releases$/, "GET", () => ({ current: { version: "r000042" }, channel: "stable", available: [{ version: "r000043", publishedAt: "2026-10-27T00:00:00.000Z" }] })],
    [/^\/api\/workspaces\/[^/]+\/directory$/, "GET", () => ({ entries: [ADA] })],
    [/^\/api\/workspaces\/[^/]+\/directory\/[^/]+$/, "GET", () => ({ entry: ADA, identities: [{ method: "google", issuer: "https://accounts.google.com" }], deviceCount: 1, aiUsageThisMonthUsdNanos: 1_230_000_000 })],
    [/^\/api\/workspaces\/[^/]+\/directory\/[^/]+\/[a-z-]+$/, "POST", () => ({ applied: true, auditId: "aud_1" })],
    [/^\/api\/workspaces\/[^/]+\/devices$/, "GET", () => ({ devices: [PHONE] })],
    [/^\/api\/workspaces\/[^/]+\/devices\/revoke-below-version$/, "POST", () => ({ revoked: 3, auditId: "aud_2" })],
    [/^\/api\/workspaces\/[^/]+\/devices\/[^/]+\/revoke$/, "POST", () => ({ applied: true, auditId: "aud_3" })],
    [/^\/api\/audit$/, "GET", () => ({ entries: [{ id: 1, at: "2026-10-28T12:00:00.000Z", operatorSub: "s", operatorEmail: "ops@educateos.io", action: "workspace.enroll", target: NORTHFIELD.origin, result: "ok" }] })],
  ];
  return {
    requests,
    posts: () => requests.filter((r) => r.method === "POST"),
    fetch: async (input, init = {}) => {
      const url = new URL(input, "https://admin.educateos.io");
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method, path: `${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }) });
      for (const [pattern, routeMethod, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match !== null && routeMethod === method) return Response.json(handler(match, url, body));
      }
      return Response.json({ code: "not-found", message: "No such API route." }, { status: 404 });
    },
  };
}
