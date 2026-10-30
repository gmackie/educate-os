// The district's Cloudflare analytics proxy (SCHO-263) against recorded responses, one per query
// shape (fixtures/cloudflare): the account's GraphQL query (Workers, their series, Durable Objects),
// the zone's (HTTP requests by status), and the Access authentication log. It sends the token and
// the right variables, never follows a redirect, returns aggregates only, marks sampled figures, and
// caches each window for five minutes.
import { describe, expect, it } from "vitest";
import { OpsAnalyticsResponse } from "@educateos/fleet/ops";
import { ACCOUNT_QUERY, analyticsSettings, cloudflareAnalytics, ZONE_QUERY, type CloudflareAnalyticsSettings } from "../src/index.ts";
import account24h from "./fixtures/cloudflare/account-24h.json" with { type: "json" };
import zone24h from "./fixtures/cloudflare/zone-24h.json" with { type: "json" };
import accessRequests from "./fixtures/cloudflare/access-requests.json" with { type: "json" };
import graphqlError from "./fixtures/cloudflare/graphql-error.json" with { type: "json" };
import accessForbidden from "./fixtures/cloudflare/access-forbidden.json" with { type: "json" };

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const SETTINGS: CloudflareAnalyticsSettings = { token: "cf-analytics-token", accountId: ACCOUNT, scripts: ["northfield-district", "northfield-router", "northfield-ai-guard"] };

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  redirect: RequestRedirect;
  body: { query: string; variables: Record<string, unknown> } | undefined;
}

/** A recorded Cloudflare: each request is answered from the fixtures by what it asks for. */
function recordedCloudflare(answers: { account?: unknown; zone?: unknown; access?: unknown; accessStatus?: number; accountStatus?: number } = {}) {
  const requests: Recorded[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const text = request.method === "POST" ? await request.text() : "";
    const body = text === "" ? undefined : JSON.parse(text) as Recorded["body"];
    requests.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), redirect: request.redirect, body });
    if (request.url === "https://api.cloudflare.com/client/v4/graphql") {
      if (body?.query === ACCOUNT_QUERY) return Response.json(answers.account ?? account24h, { status: answers.accountStatus ?? 200 });
      if (body?.query === ZONE_QUERY) return Response.json(answers.zone ?? zone24h);
    }
    if (request.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/logs/access_requests?`)) {
      return Response.json(answers.access ?? accessRequests, { status: answers.accessStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

describe("the analytics proxy", () => {
  it("reads every dataset with the district's token and returns the protocol's aggregates", async () => {
    const cloudflare = recordedCloudflare();
    const source = cloudflareAnalytics({ ...SETTINGS, zoneTag: ZONE }, { fetch: cloudflare.fetch, now: () => new Date(NOW) });
    const report = await source.report("24h");
    // The fleet schema, with the AI figures the district adds from its ledger.
    OpsAnalyticsResponse.parse({ ...report, ai: { requests: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, gatewayCostUsdNanos: 0, ledgerCostUsdNanos: 0, monthToDateUsdNanos: 0 } });

    expect(report).toStrictEqual({
      range: "24h",
      generatedAt: "2026-10-28T12:00:00.000Z",
      // The router's invocations were sampled one in ten.
      sampled: true,
      workers: [
        { script: "northfield-district", invocations: 18342, errors: 27, cpuTimeP50Ms: 1.8405, cpuTimeP99Ms: 23.11 },
        { script: "northfield-router", invocations: 9210, errors: 3, cpuTimeP50Ms: 0.912, cpuTimeP99Ms: 8.8 },
        { script: "northfield-ai-guard", invocations: 412, errors: 0, cpuTimeP50Ms: 3.1, cpuTimeP99Ms: 41 },
      ],
      // Status 0 is not an HTTP status, so it is left out.
      http: {
        requests: 26642,
        byStatus: [
          { status: 200, requests: 21890 },
          { status: 302, requests: 1250 },
          { status: 304, requests: 3402 },
          { status: 404, requests: 88 },
          { status: 502, requests: 12 },
        ],
      },
      // One point per hour, in order, the Workers' figures summed.
      series: [
        { at: "2026-10-28T09:00:00.000Z", requests: 977, errors: 2 },
        { at: "2026-10-28T10:00:00.000Z", requests: 1012, errors: 1 },
        { at: "2026-10-28T11:00:00.000Z", requests: 1288, errors: 4 },
      ],
      durableObjects: { requests: 15803, storageBytes: 48213504 },
      storage: { r2Bytes: 0, d1Bytes: 0 },
      // A refused sign-in counts as a failure, not by its method. Counts only: no email or address.
      signIns: { byMethod: [{ method: "google", count: 2 }, { method: "email", count: 1 }, { method: "clever", count: 1 }, { method: "other", count: 1 }], failures: 1 },
    });
    expect(JSON.stringify(report)).not.toMatch(/@|198\.51|northfield\.example/);

    expect(cloudflare.requests).toHaveLength(3);
    for (const request of cloudflare.requests) {
      expect(request.authorization).toBe("Bearer cf-analytics-token");
      expect(request.redirect).toBe("manual");
    }
    const accountQuery = cloudflare.requests.find((r) => r.body?.query === ACCOUNT_QUERY)!;
    expect(accountQuery.body!.variables).toStrictEqual({
      accountTag: ACCOUNT,
      start: "2026-10-27T12:00:00.000Z",
      end: "2026-10-28T12:00:00.000Z",
      startDate: "2026-10-27",
      endDate: "2026-10-28",
      scripts: SETTINGS.scripts,
    });
    expect(cloudflare.requests.find((r) => r.body?.query === ZONE_QUERY)!.body!.variables).toStrictEqual({ zoneTag: ZONE, start: "2026-10-27T12:00:00.000Z", end: "2026-10-28T12:00:00.000Z" });
    const access = new URL(cloudflare.requests.find((r) => r.method === "GET")!.url);
    expect(Object.fromEntries(access.searchParams)).toStrictEqual({ since: "2026-10-27T12:00:00.000Z", until: "2026-10-28T12:00:00.000Z", limit: "1000", direction: "desc" });
  });

  it("without a zone, reports the Workers' requests as traffic and asks for no zone", async () => {
    const cloudflare = recordedCloudflare();
    const report = await cloudflareAnalytics(SETTINGS, { fetch: cloudflare.fetch, now: () => new Date(NOW) }).report("7d");
    expect(report.http).toStrictEqual({ requests: 27964, byStatus: [] });
    expect(cloudflare.requests.some((r) => r.body?.query === ZONE_QUERY)).toBe(false);
    expect(cloudflare.requests.find((r) => r.body?.query === ACCOUNT_QUERY)!.body!.variables.start).toBe("2026-10-21T12:00:00.000Z");
  });

  it("caches each window for five minutes, and asks again after", async () => {
    const cloudflare = recordedCloudflare();
    let now = NOW;
    const source = cloudflareAnalytics(SETTINGS, { fetch: cloudflare.fetch, now: () => new Date(now) });
    await source.report("24h");
    await source.report("24h");
    expect(cloudflare.requests).toHaveLength(2);
    await source.report("30d");
    expect(cloudflare.requests).toHaveLength(4);
    now += 5 * 60 * 1000;
    await source.report("24h");
    expect(cloudflare.requests).toHaveLength(6);
  });

  it("fails on a GraphQL error, a refusal or a redirect, and does not cache the failure", async () => {
    for (const answers of [{ account: graphqlError }, { accountStatus: 403 }, { accountStatus: 302 }]) {
      const cloudflare = recordedCloudflare(answers);
      const source = cloudflareAnalytics(SETTINGS, { fetch: cloudflare.fetch, now: () => new Date(NOW) });
      await expect(source.report("24h")).rejects.toThrow(/Cloudflare/);
      await expect(source.report("24h")).rejects.toThrow(/Cloudflare/);
      expect(cloudflare.requests.filter((r) => r.body?.query === ACCOUNT_QUERY)).toHaveLength(2);
    }
  });

  it("still reports the rest when the token can't read Access logs", async () => {
    for (const answers of [{ access: accessForbidden, accessStatus: 403 }, { access: accessForbidden }]) {
      const report = await cloudflareAnalytics(SETTINGS, { ...recordedCloudflare(answers), now: () => new Date(NOW) }).report("24h");
      expect(report.signIns).toStrictEqual({ byMethod: [], failures: 0 });
      expect(report.workers).toHaveLength(3);
    }
  });

  it("marks sign-ins sampled when the Access log is cut off at its limit", async () => {
    const row = { allowed: true, connection: "google" };
    const full = { success: true, result: Array.from({ length: 1000 }, () => row) };
    const unsampled = { ...account24h, data: { viewer: { accounts: [{ ...account24h.data.viewer.accounts[0]!, workers: [account24h.data.viewer.accounts[0]!.workers[0]!] }] } } };
    const report = await cloudflareAnalytics(SETTINGS, { ...recordedCloudflare({ access: full, account: unsampled }), now: () => new Date(NOW) }).report("24h");
    expect(report.sampled).toBe(true);
    expect(report.signIns.byMethod).toStrictEqual([{ method: "google", count: 1000 }]);
    const fewer = await cloudflareAnalytics(SETTINGS, { ...recordedCloudflare({ account: unsampled }), now: () => new Date(NOW) }).report("24h");
    expect(fewer.sampled).toBe(false);
  });
});

describe("the analytics settings", () => {
  it("need a token and an account ID; scripts and zone are read as lists and tags", () => {
    expect(analyticsSettings({})).toBeUndefined();
    expect(analyticsSettings({ CF_ANALYTICS_TOKEN: "t" })).toBeUndefined();
    expect(analyticsSettings({ CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "not-an-account" })).toBeUndefined();
    expect(analyticsSettings({ CF_ANALYTICS_TOKEN: " t ", CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_SCRIPTS: "a, b ,,bad name", ANALYTICS_ZONE_TAG: ZONE }))
      .toStrictEqual({ token: "t", accountId: ACCOUNT, scripts: ["a", "b"], zoneTag: ZONE });
    expect(analyticsSettings({ CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_ZONE_TAG: "" })).toStrictEqual({ token: "t", accountId: ACCOUNT, scripts: [] });
  });
});
