// The status rows for the district Worker's roster secrets, when the secret list can't be read
// (SCHO-444): each says what failed rather than asking for a token that is already set.
import { CloudflareApiError } from "@educateos/installer";
import { describe, expect, it } from "vitest";
import type { ConnectContext } from "../src/connect/district.ts";
import { districtStatus, type StatusRow } from "../src/connect/status.ts";

const ACCOUNT = "a1".repeat(16);
const WORKER = "educateos-northfield-educateos-district-worker";

function context(listWorkerSecrets: () => Promise<string[]>): ConnectContext {
  return {
    out: { line() {}, event() {}, secret() {} },
    prompter: undefined,
    yes: false,
    cloudflare: async () => ({ api: { listWorkerSecrets } }),
    district: {
      accountId: ACCOUNT,
      origin: "https://educateos.northfield.example",
      ltiOrigin: "https://educateos.northfield.example",
      scriptName: WORKER,
      accessTeamDomain: "northfield.cloudflareaccess.com",
    },
    answers: { install: {} },
    answersPath: "/nowhere/answers.json",
    fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
    env: {},
    flags: {},
  } as unknown as ConnectContext;
}

async function rosterRows(options: { cloudflare: boolean }, list: () => Promise<string[]>): Promise<StatusRow[]> {
  const rows = await districtStatus(context(list), options);
  return rows.filter((row) => row.area === "clever" || row.area === "google-classroom");
}

describe("status: the roster secret rows", () => {
  it("asks for the token only when none is set", async () => {
    const rows = await rosterRows({ cloudflare: false }, async () => { throw new Error("not called"); });
    expect(rows.map((row) => row.fix)).toEqual(["set CLOUDFLARE_API_TOKEN and run again", "set CLOUDFLARE_API_TOKEN and run again"]);
  });

  it("names the missing permission when the token can't read Worker secrets", async () => {
    const rows = await rosterRows({ cloudflare: true }, async () => { throw new CloudflareApiError("listWorkerSecrets", 403, [10000]); });
    for (const row of rows) {
      expect(row.state).toBe("unknown");
      expect(row.detail).toContain("listWorkerSecrets: HTTP 403");
      expect(row.detail).not.toContain("need the Cloudflare API token");
      expect(row.fix).toContain("Workers Scripts: Read");
    }
  });

  it("names the Worker when the account has none by that name", async () => {
    const rows = await rosterRows({ cloudflare: true }, async () => { throw new CloudflareApiError("listWorkerSecrets", 404, [10007]); });
    for (const row of rows) {
      expect(row.detail).toContain(`account ${ACCOUNT} has no Worker named ${WORKER}`);
      expect(row.fix).toContain("scriptName");
    }
  });

  it("reports any other failure as what it was", async () => {
    const rows = await rosterRows({ cloudflare: true }, async () => { throw new CloudflareApiError("listWorkerSecrets", 503, []); });
    for (const row of rows) {
      expect(row.detail).toBe(`listing ${WORKER}'s secrets failed: listWorkerSecrets: HTTP 503`);
      expect(row.fix).not.toContain("CLOUDFLARE_API_TOKEN");
    }
  });

  it("reads the secrets when the list works", async () => {
    const rows = await rosterRows({ cloudflare: true }, async () => ["CLEVER_DISTRICT_TOKEN"]);
    expect(rows.map((row) => row.state)).toEqual(["ok", "not configured"]);
  });
});
