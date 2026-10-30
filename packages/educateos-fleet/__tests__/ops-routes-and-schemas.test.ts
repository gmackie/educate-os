// The ops route → scope table and the typed bodies (SCHO-263): every route needs exactly the scope
// the plan gives it, nothing outside the table matches, and the bodies refuse unknown fields.
import { describe, expect, it } from "vitest";
import {
  DirectoryActionBodies,
  matchOpsRoute,
  OPS_RESPONSES,
  OPS_ROUTES,
  OpsAnalyticsResponse,
  OpsDirectoryPage,
  OpsRevokeBelowVersionBody,
  scopeForRoute,
} from "../src/ops/index.ts";

describe("the ops route table", () => {
  it.each([
    ["GET", "/api/ops/health", "health"],
    ["GET", "/api/ops/analytics", "analytics"],
    ["GET", "/api/ops/directory", "directory:read"],
    ["GET", "/api/ops/directory/prn_ada", "directory:read"],
    ["POST", "/api/ops/directory/prn_ada/suspend", "directory:write"],
    ["POST", "/api/ops/directory/prn_ada/restore", "directory:write"],
    ["POST", "/api/ops/directory/prn_ada/sign-out-everywhere", "directory:write"],
    ["POST", "/api/ops/directory/prn_ada/roles", "directory:write"],
    ["POST", "/api/ops/directory/prn_ada/ai-access", "directory:write"],
    ["GET", "/api/ops/devices", "devices"],
    ["POST", "/api/ops/devices/dev_1/revoke", "devices"],
    ["POST", "/api/ops/devices/revoke-below-version", "devices"],
    ["GET", "/api/ops/releases", "releases"],
  ])("%s %s needs %s", (method, path, scope) => {
    expect(scopeForRoute(method, path)).toBe(scope);
  });

  it.each([
    ["POST", "/api/ops/health"],
    ["GET", "/api/ops/directory/prn_ada/suspend"],
    ["POST", "/api/ops/directory/prn_ada/delete"],
    ["POST", "/api/ops/directory/prn%2Fada/suspend"],
    ["POST", "/api/ops/directory/%E0%A4%A/suspend"],
    ["GET", "/api/ops/health/"],
    ["GET", "/api/ops"],
    ["GET", "/api/opsx/health"],
  ])("matches nothing for %s %s", (method, path) => {
    expect(matchOpsRoute(method, path)).toBeUndefined();
  });

  it("captures and decodes parameters", () => {
    expect(matchOpsRoute("post", "/api/ops/directory/prn_ada/roles")).toMatchObject({ params: { principal: "prn_ada", action: "roles" } });
    expect(matchOpsRoute("POST", "/api/ops/devices/dev%5F1/revoke")).toMatchObject({ params: { id: "dev_1" } });
  });

  it("has a response schema for every route", () => {
    for (const route of OPS_ROUTES) expect(OPS_RESPONSES[route.name]).toBeDefined();
  });
});

describe("ops bodies", () => {
  const analytics = {
    range: "24h", generatedAt: "2026-10-28T12:00:00.000Z", sampled: true,
    workers: [{ script: "northfield-district", invocations: 1200, errors: 3, cpuTimeP50Ms: 1.2, cpuTimeP99Ms: 18 }],
    http: { requests: 1500, byStatus: [{ status: 200, requests: 1400 }, { status: 500, requests: 3 }] },
    series: [{ at: "2026-10-28T11:00:00.000Z", requests: 60, errors: 0 }],
    durableObjects: { requests: 900, storageBytes: 1_000_000 },
    storage: { r2Bytes: 5_000_000, d1Bytes: 20_000 },
    ai: { requests: 40, tokensIn: 10_000, tokensOut: 4000, cacheHits: 2, gatewayCostUsdNanos: 12_000_000, ledgerCostUsdNanos: 12_100_000, monthToDateUsdNanos: 90_000_000 },
    signIns: { byMethod: [{ method: "google", count: 30 }], failures: 1 },
  };

  it("parses an analytics report and refuses one with an extra field", () => {
    expect(OpsAnalyticsResponse.parse(analytics)).toEqual(analytics);
    expect(OpsAnalyticsResponse.safeParse({ ...analytics, topUsers: ["ada@example.org"] }).success).toBe(false);
    expect(OpsAnalyticsResponse.safeParse({ ...analytics, ai: { ...analytics.ai, lastPrompt: "hi" } }).success).toBe(false);
  });

  it("parses a directory page and refuses a malformed principal", () => {
    const entry = {
      principal: "prn_ada", displayName: "Ada", roles: ["student"], schools: ["Northfield Middle"], status: "active",
      signInMethods: ["google"], rostered: true, aiAccess: "standard",
    };
    expect(OpsDirectoryPage.parse({ entries: [entry] }).entries).toHaveLength(1);
    expect(OpsDirectoryPage.safeParse({ entries: [{ ...entry, principal: "ada" }] }).success).toBe(false);
  });

  it("checks each directory action's body", () => {
    expect(DirectoryActionBodies.roles.safeParse({ grant: ["admin"], revoke: [] }).success).toBe(true);
    expect(DirectoryActionBodies.roles.safeParse({ grant: ["student"], revoke: [] }).success).toBe(false);
    expect(DirectoryActionBodies["ai-access"].safeParse({ level: "unlimited" }).success).toBe(false);
    expect(DirectoryActionBodies.restore.safeParse({ extra: true }).success).toBe(false);
  });

  it("wants a forced update's version as major.minor.patch", () => {
    expect(OpsRevokeBelowVersionBody.safeParse({ minimumVersion: "1.4.0" }).success).toBe(true);
    expect(OpsRevokeBelowVersionBody.safeParse({ minimumVersion: "latest" }).success).toBe(false);
  });
});
