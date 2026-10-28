// The district's Cloudflare analytics proxy (SCHO-263, plan section 6 "Cloudflare stats"), behind
// `GET /api/ops/analytics`. The district holds a read-only API token (Account Analytics Read, Access
// Audit Logs Read, Workers Scripts Read) as the secret `CF_ANALYTICS_TOKEN`; an admin edition never
// does. This module reads, for the district's own Workers and zone:
//
// - `workersInvocationsAdaptive`: requests, errors and CPU time quantiles per Worker, and an hourly
//   (or daily) series for the sparklines;
// - `durableObjectsInvocationsAdaptiveGroups` and `durableObjectsStorageGroups`: Durable Object
//   requests and stored bytes;
// - `httpRequestsAdaptiveGroups`, when a zone tag is configured: requests by edge status;
// - the Access authentication logs (`/accounts/:id/access/logs/access_requests`): sign-ins by
//   identity provider and how many were refused.
//
// It returns aggregates only, never a row naming a person, and caches each window's report for five
// minutes in the district's object, since Cloudflare's analytics move slower than that anyway.
// Web-standard only (ADR-0009); the fetch is injected so tests replay recorded responses.
import { z } from "zod";
import type { AnalyticsRange } from "@educateos/fleet/ops";
import type { CloudflareAnalyticsReport, OpsAnalyticsSource } from "./ops.ts";

/** Cloudflare's GraphQL Analytics API. */
export const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** Cloudflare's REST API. */
export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
/** How long a window's report is served from the cache. */
export const ANALYTICS_CACHE_MS = 5 * 60 * 1000;
/** The most Access log entries read per report; more than this and the counts are a sample. */
export const ACCESS_LOG_LIMIT = 1000;

const RANGE_MS: Record<AnalyticsRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** The analytics proxy's configuration: the district's secret, and vars naming what to read. */
export interface CloudflareAnalyticsSettings {
  /** `CF_ANALYTICS_TOKEN`. */
  token: string;
  /** `CF_ACCOUNT_ID`. */
  accountId: string;
  /** `ANALYTICS_SCRIPTS`: the district's Worker names. */
  scripts: readonly string[];
  /** `ANALYTICS_ZONE_TAG`: the district's zone, for HTTP traffic. Optional. */
  zoneTag?: string | undefined;
}

/**
 * Reads the analytics settings from the Worker's environment, or undefined when the district has no
 * token or account (the ops route then answers 501 `analytics-not-configured`).
 */
export function analyticsSettings(env: {
  CF_ANALYTICS_TOKEN?: string | undefined;
  CF_ACCOUNT_ID?: string | undefined;
  ANALYTICS_SCRIPTS?: string | undefined;
  ANALYTICS_ZONE_TAG?: string | undefined;
}): CloudflareAnalyticsSettings | undefined {
  const token = env.CF_ANALYTICS_TOKEN?.trim() ?? "";
  const accountId = env.CF_ACCOUNT_ID?.trim() ?? "";
  if (token === "" || !/^[0-9a-f]{32}$/.test(accountId)) return undefined;
  const scripts = (env.ANALYTICS_SCRIPTS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,63}$/.test(s));
  const zoneTag = env.ANALYTICS_ZONE_TAG?.trim();
  return { token, accountId, scripts, ...(zoneTag !== undefined && /^[0-9a-f]{32}$/.test(zoneTag) ? { zoneTag } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Queries. Each is one request; the account query asks for every account-scoped dataset at once.

/** Workers, their hourly series, and Durable Objects, for the account. */
export const ACCOUNT_QUERY = `query DistrictAnalytics($accountTag: string!, $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!, $scripts: [string!]) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, scriptName_in: $scripts }) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        avg { sampleInterval }
        dimensions { scriptName }
      }
      series: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName_in: $scripts }, orderBy: [datetimeHour_ASC]) {
        sum { requests errors }
        dimensions { datetimeHour }
      }
      durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, scriptName_in: $scripts }) {
        sum { requests }
      }
      durableObjectStorage: durableObjectsStorageGroups(limit: 1, filter: { date_geq: $startDate, date_leq: $endDate }, orderBy: [date_DESC]) {
        max { storedBytes }
        dimensions { date }
      }
    }
  }
}`;

/** HTTP requests by edge status, for the district's zone. */
export const ZONE_QUERY = `query DistrictTraffic($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      http: httpRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [count_DESC]) {
        count
        avg { sampleInterval }
        dimensions { edgeResponseStatus }
      }
    }
  }
}`;

const Num = z.number().nonnegative().catch(0);

const GraphQlEnvelope = z.object({
  data: z.unknown().nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).nullable().optional(),
});

const AccountData = z.object({
  viewer: z.object({
    accounts: z.array(z.object({
      workers: z.array(z.object({
        sum: z.object({ requests: Num, errors: Num }),
        quantiles: z.object({ cpuTimeP50: Num, cpuTimeP99: Num }),
        avg: z.object({ sampleInterval: Num }).optional(),
        dimensions: z.object({ scriptName: z.string() }),
      })),
      series: z.array(z.object({
        sum: z.object({ requests: Num, errors: Num }),
        dimensions: z.object({ datetimeHour: z.string() }),
      })),
      durableObjects: z.array(z.object({ sum: z.object({ requests: Num }) })),
      durableObjectStorage: z.array(z.object({ max: z.object({ storedBytes: Num }) })),
    })),
  }),
});

const ZoneData = z.object({
  viewer: z.object({
    zones: z.array(z.object({
      http: z.array(z.object({
        count: Num,
        avg: z.object({ sampleInterval: Num }).optional(),
        dimensions: z.object({ edgeResponseStatus: z.number().int() }),
      })),
    })),
  }),
});

const AccessLogs = z.object({
  success: z.boolean(),
  result: z.array(z.object({
    allowed: z.boolean().optional(),
    connection: z.string().optional(),
  })).nullable(),
});

type SignInMethod = CloudflareAnalyticsReport["signIns"]["byMethod"][number]["method"];

/** How an Access identity provider connection is reported. */
function signInMethod(connection: string | undefined): SignInMethod {
  const value = (connection ?? "").toLowerCase();
  if (value.includes("google")) return "google";
  if (value.includes("clever")) return "clever";
  if (value.includes("classlink")) return "classlink";
  if (value === "onetimepin" || value.includes("otp")) return "email";
  if (value.includes("pin")) return "pin";
  return "other";
}

/** Why the analytics proxy could not read Cloudflare: a fixed message, never Cloudflare's body. */
export class AnalyticsUpstreamError extends Error {
  override readonly name = "AnalyticsUpstreamError";
}

/** What {@link cloudflareAnalytics} reaches outside: the fetch and the clock. */
export interface CloudflareAnalyticsSeams {
  /** Bound to `globalThis` by the caller in workerd. */
  fetch: (request: Request) => Promise<Response>;
  now(): Date;
}

/** The analytics proxy over the district's Cloudflare account, caching each window's report. */
export function cloudflareAnalytics(settings: CloudflareAnalyticsSettings, seams: CloudflareAnalyticsSeams): OpsAnalyticsSource {
  const cache = new Map<AnalyticsRange, { at: number; report: Promise<CloudflareAnalyticsReport> }>();

  async function send(url: string, init: { method: "GET" | "POST"; body?: string }): Promise<unknown> {
    const response = await seams.fetch(new Request(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${settings.token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      // workerd refuses `redirect: "error"`; a 3xx is refused below instead of followed.
      redirect: "manual",
      ...(init.body === undefined ? {} : { body: init.body }),
    }));
    if (!response.ok) {
      await response.body?.cancel();
      throw new AnalyticsUpstreamError(`Cloudflare answered ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new AnalyticsUpstreamError("Cloudflare's answer was not JSON");
    }
  }

  async function graphql<S extends z.ZodType>(query: string, variables: Record<string, unknown>, schema: S): Promise<z.output<S>> {
    const envelope = GraphQlEnvelope.safeParse(await send(CLOUDFLARE_GRAPHQL_URL, { method: "POST", body: JSON.stringify({ query, variables }) }));
    if (!envelope.success) throw new AnalyticsUpstreamError("Cloudflare's GraphQL answer was malformed");
    if ((envelope.data.errors ?? []).length > 0) throw new AnalyticsUpstreamError("Cloudflare's GraphQL query failed");
    const data = schema.safeParse(envelope.data.data);
    if (!data.success) throw new AnalyticsUpstreamError("Cloudflare's GraphQL data was malformed");
    return data.data;
  }

  async function signIns(start: Date, end: Date): Promise<{ signIns: CloudflareAnalyticsReport["signIns"]; sampled: boolean }> {
    const url = new URL(`${CLOUDFLARE_API_URL}/accounts/${settings.accountId}/access/logs/access_requests`);
    url.searchParams.set("since", start.toISOString());
    url.searchParams.set("until", end.toISOString());
    url.searchParams.set("limit", String(ACCESS_LOG_LIMIT));
    url.searchParams.set("direction", "desc");
    const parsed = AccessLogs.safeParse(await send(url.toString(), { method: "GET" }));
    if (!parsed.success || !parsed.data.success) throw new AnalyticsUpstreamError("Cloudflare's Access log answer was malformed");
    const rows = parsed.data.result ?? [];
    const counts = new Map<SignInMethod, number>();
    let failures = 0;
    for (const row of rows) {
      if (row.allowed === false) {
        failures++;
        continue;
      }
      const method = signInMethod(row.connection);
      counts.set(method, (counts.get(method) ?? 0) + 1);
    }
    const byMethod = [...counts].map(([method, count]) => ({ method, count })).toSorted((a, b) => b.count - a.count);
    return { signIns: { byMethod, failures }, sampled: rows.length >= ACCESS_LOG_LIMIT };
  }

  async function build(range: AnalyticsRange): Promise<CloudflareAnalyticsReport> {
    const end = seams.now();
    const start = new Date(end.getTime() - RANGE_MS[range]);
    const accountVariables = {
      accountTag: settings.accountId,
      start: start.toISOString(),
      end: end.toISOString(),
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      scripts: [...settings.scripts],
    };
    const zone = settings.zoneTag === undefined
      ? Promise.resolve(undefined)
      : graphql(ZONE_QUERY, { zoneTag: settings.zoneTag, start: start.toISOString(), end: end.toISOString() }, ZoneData);
    // Sign-ins are best effort: a token without Access: Audit Logs Read still reports the rest.
    const access = signIns(start, end).catch(() => ({ signIns: { byMethod: [], failures: 0 }, sampled: false }));
    const [account, zoneData, accessData] = await Promise.all([graphql(ACCOUNT_QUERY, accountVariables, AccountData), zone, access]);

    const data = account.viewer.accounts[0];
    if (data === undefined) throw new AnalyticsUpstreamError("the token cannot read this account's analytics");
    const workers = new Map<string, { invocations: number; errors: number; p50: number; p99: number }>();
    let sampled = accessData.sampled;
    for (const group of data.workers) {
      if ((group.avg?.sampleInterval ?? 1) > 1) sampled = true;
      const entry = workers.get(group.dimensions.scriptName) ?? { invocations: 0, errors: 0, p50: 0, p99: 0 };
      entry.invocations += Math.round(group.sum.requests);
      entry.errors += Math.round(group.sum.errors);
      // Cloudflare reports CPU time in microseconds.
      entry.p50 = Math.max(entry.p50, group.quantiles.cpuTimeP50 / 1000);
      entry.p99 = Math.max(entry.p99, group.quantiles.cpuTimeP99 / 1000);
      workers.set(group.dimensions.scriptName, entry);
    }
    const series = new Map<string, { requests: number; errors: number }>();
    for (const point of data.series) {
      const at = new Date(point.dimensions.datetimeHour);
      if (Number.isNaN(at.getTime())) continue;
      const key = at.toISOString();
      const entry = series.get(key) ?? { requests: 0, errors: 0 };
      entry.requests += Math.round(point.sum.requests);
      entry.errors += Math.round(point.sum.errors);
      series.set(key, entry);
    }
    const workerRequests = [...workers.values()].reduce((total, w) => total + w.invocations, 0);
    const byStatus = new Map<number, number>();
    for (const group of zoneData?.viewer.zones[0]?.http ?? []) {
      if ((group.avg?.sampleInterval ?? 1) > 1) sampled = true;
      const status = group.dimensions.edgeResponseStatus;
      if (status < 100 || status > 599) continue;
      byStatus.set(status, (byStatus.get(status) ?? 0) + Math.round(group.count));
    }
    const httpRequests = [...byStatus.values()].reduce((total, n) => total + n, 0);

    return {
      range,
      generatedAt: end.toISOString(),
      sampled,
      workers: [...workers].map(([script, w]) => ({ script, invocations: w.invocations, errors: w.errors, cpuTimeP50Ms: w.p50, cpuTimeP99Ms: w.p99 }))
        .toSorted((a, b) => b.invocations - a.invocations)
        .slice(0, 100),
      // Without a zone, the district's own Worker requests stand in for its traffic, with no status breakdown.
      http: zoneData === undefined
        ? { requests: workerRequests, byStatus: [] }
        : { requests: httpRequests, byStatus: [...byStatus].map(([status, requests]) => ({ status, requests })).toSorted((a, b) => a.status - b.status).slice(0, 100) },
      series: [...series].toSorted(([a], [b]) => (a < b ? -1 : 1)).slice(-744).map(([at, p]) => ({ at, ...p })),
      durableObjects: {
        requests: Math.round(data.durableObjects.reduce((total, group) => total + group.sum.requests, 0)),
        storageBytes: Math.round(data.durableObjectStorage[0]?.max.storedBytes ?? 0),
      },
      // The district Worker keeps everything in its Durable Object: it has no R2 bucket or D1 database.
      storage: { r2Bytes: 0, d1Bytes: 0 },
      signIns: accessData.signIns,
    };
  }

  return {
    report(range) {
      const now = seams.now().getTime();
      const cached = cache.get(range);
      if (cached !== undefined && now - cached.at < ANALYTICS_CACHE_MS) return cached.report;
      const report = build(range);
      cache.set(range, { at: now, report });
      // A failure is not cached: the next request asks Cloudflare again.
      report.catch(() => {
        if (cache.get(range)?.report === report) cache.delete(range);
      });
      return report;
    },
  };
}
