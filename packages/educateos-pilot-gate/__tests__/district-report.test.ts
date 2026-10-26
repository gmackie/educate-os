// The district gate report and the live target, over synthetic results and a fake fetch: no
// district is booted and nothing leaves the process.
import { describe, expect, it } from "vitest";
import { DEMO_DISTRICTS } from "@educateos/fixtures";
import { cellStatus, inProcessReport, renderDistrictReport, reportFails } from "../src/district-report.ts";
import { cells, SCENARIOS, scenarioFullName } from "../src/districts.ts";
import { districtOfTarget, liveReport } from "../src/live.ts";
import type { TestResult } from "../src/traceability.ts";

const passed: TestResult = { outcome: "passed", annotations: [] };
const meta = { generatedAt: "2026-10-26T12:00:00.000Z" };

describe("the scenario registry", () => {
  it("cites a SCHO issue and a reason for every blocked cell, and covers every district", () => {
    for (const { demo, scenario, applicability } of cells()) {
      if (applicability.kind !== "blocked") continue;
      expect(applicability.blockedBy.length, `${demo.slug}/${scenario.id}`).toBeGreaterThan(0);
      expect(applicability.reason.length).toBeGreaterThan(0);
    }
    expect(new Set(cells().map((c) => c.demo.slug))).toStrictEqual(new Set(DEMO_DISTRICTS.map((d) => d.slug)));
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("runs the same scenarios in every district with the same profile, whatever the district is called", () => {
    for (const scenario of SCENARIOS) {
      for (const a of DEMO_DISTRICTS) {
        for (const b of DEMO_DISTRICTS) {
          if (JSON.stringify(a.profile) !== JSON.stringify(b.profile) || (a.guardians.length > 0) !== (b.guardians.length > 0)) continue;
          expect(scenario.applies(a)).toStrictEqual(scenario.applies(b));
        }
      }
    }
  });
});

describe("the in-process report", () => {
  it("is MET only for cells that ran and passed, and fails on any NOT MET", () => {
    const all = new Map(cells().filter((c) => c.applicability.kind === "runs").map((c) => [scenarioFullName(c.demo, c.scenario), passed]));
    const green = inProcessReport(all, meta);
    expect(reportFails(green)).toBe(false);
    expect(green.cells.filter((c) => c.status === "NOT MET")).toStrictEqual([]);

    const [first] = all.keys();
    all.set(first!, { outcome: "failed", annotations: [], error: "boom" } as TestResult);
    const red = inProcessReport(all, meta);
    expect(reportFails(red)).toBe(true);
    expect(red.cells.find((c) => c.status === "NOT MET")?.note).toBe("boom");
    // A cell whose test never ran is NOT MET, never MET.
    expect(reportFails(inProcessReport(new Map(), meta))).toBe(true);
  });

  it("never reports a blocked cell as MET, whatever the run says", () => {
    expect(cellStatus({ kind: "blocked", blockedBy: ["SCHO-203"], reason: "r" }, passed)).toBe("NOT YET APPLICABLE");
    expect(cellStatus({ kind: "not-in-profile" }, passed)).toBe("NOT IN PROFILE");
    expect(cellStatus({ kind: "runs" }, { outcome: "skipped", annotations: [] })).toBe("NOT MET");
  });

  it("renders a district × scenario table with each blocked cell's issues", () => {
    const markdown = renderDistrictReport(inProcessReport(new Map(), meta));
    expect(markdown).toContain(`| Scenario | ${DEMO_DISTRICTS.map((d) => d.slug).join(" | ")} |`);
    expect(markdown).toMatch(/`vendor-sso` \|.*NYA \(SCHO-204\)/);
  });
});

describe("the live target", () => {
  const responses = (routes: Record<string, () => Response>) => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init === undefined ? {} : { init }) });
      const route = routes[new URL(url).pathname];
      return route === undefined ? new Response("not found", { status: 404 }) : route();
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  };
  const toAccess = () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" } });

  it("reports a relative redirect as NOT MET rather than failing", async () => {
    const { fetch } = responses({ "/healthz": () => new Response(null, { status: 302, headers: { location: "/login" } }), "/api/me": () => new Response(null, { status: 302, headers: { location: "/login" } }) });
    const report = await liveReport({ target: "https://northfield.educateos.io", fetch, ...meta });
    expect(report.cells.find((c) => c.scenario === "live-access-gate")).toMatchObject({ status: "NOT MET", note: expect.stringContaining("https://northfield.educateos.io") });
  });

  it("probes with GETs only, follows no redirect, and reports Access and the LTI JWKS", async () => {
    const { fetch, seen } = responses({
      "/healthz": () => new Response("ok"),
      "/api/me": toAccess,
      "/lti/jwks": toAccess,
    });
    const report = await liveReport({ target: "https://northfield.educateos.io", fetch, ...meta });
    expect(seen.every((r) => r.init?.method === "GET" && r.init.redirect === "manual")).toBe(true);
    const status = Object.fromEntries(report.cells.map((c) => [c.scenario, c.status]));
    expect(status).toMatchObject({ "live-healthz": "MET", "live-access-gate": "MET", "live-service-token": "NOT YET APPLICABLE", "live-lti-public": "NOT MET", "lti-launch": "NOT YET APPLICABLE" });
    expect(report.cells.filter((c) => c.status === "MET").map((c) => c.scenario).toSorted()).toStrictEqual(["live-access-gate", "live-healthz"]);
  });

  it("sends a service token as Access's headers, and refuses a target that is not a demo district", async () => {
    const { fetch, seen } = responses({ "/healthz": () => new Response("ok"), "/api/me": () => new Response(null, { status: 401 }), "/lti/jwks": () => Response.json({ keys: [{ kty: "RSA" }] }) });
    // The app answering 401 itself means Access is not in front, whatever the token probe says.
    const report = await liveReport({ target: "https://northfield.educateos.io", fetch, serviceToken: { clientId: "id.access", clientSecret: "synthetic" }, ...meta });
    expect(report.cells.find((c) => c.scenario === "live-service-token")?.status).toBe("MET");
    expect(report.cells.find((c) => c.scenario === "live-access-gate")?.status).toBe("NOT MET");
    expect(report.cells.find((c) => c.scenario === "live-lti-public")?.status).toBe("MET");
    expect(seen.some((r) => (r.init?.headers as Record<string, string> | undefined)?.["CF-Access-Client-Id"] === "id.access")).toBe(true);
    expect(() => districtOfTarget("https://example.educateos.io")).toThrow();
    expect(() => districtOfTarget("https://northfield.attacker.example")).toThrow();
    expect(() => districtOfTarget("http://northfield.educateos.io")).toThrow(/https/);
  });
});
