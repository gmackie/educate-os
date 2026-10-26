// SCHO-36: the harness signs in through `identityFromAccessPayload` and
// `createDirectoryPrincipalResolver`, the production path, rather than picking principals itself.
import { describe, expect, it } from "vitest";
import { createDistrictApiClient } from "@educateos/api-client";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { bootDistrictApp, bootHarness, MORGAN_LEE_SUBJECT, signInAcrossDistricts } from "../src/index.ts";

const me = (fetch: (request: Request) => Promise<Response>, path: string, token: string) =>
  fetch(new Request(`http://district.harness${path}`, { headers: { authorization: `Bearer ${token}` } }));

describe("Morgan Lee across districts", () => {
  it("lands on a different principal in each district, and each refuses the other's token", async () => {
    const results = await signInAcrossDistricts(await bootHarness([NORTHFIELD, RIVERBEND]), MORGAN_LEE_SUBJECT);
    expect(results).toEqual([
      { districtId: "dst_northfield", principalId: "prn_nf-morgan-lee", displayName: "Morgan Lee", foreignTokensRefused: 1 },
      { districtId: "dst_riverbend", principalId: "prn_rb-morgan-lee", displayName: "Morgan Lee", foreignTokensRefused: 1 },
    ]);
  });

  it("resolves the same way in each district's full application", async () => {
    const districts = await bootHarness([NORTHFIELD, RIVERBEND]);
    const seen = [];
    for (const entry of districts) {
      const app = await bootDistrictApp(entry);
      const client = createDistrictApiClient({
        baseUrl: "http://district.harness",
        token: await entry.identity.issueToken(MORGAN_LEE_SUBJECT),
        fetch: (request) => app.fetch(request),
      });
      seen.push((await client.call("me.get")).principalId);
      // The other district's token for the same subject proves nothing here.
      const other = districts.find((d) => d !== entry)!;
      const response = await me((request) => app.fetch(request), "/api/me", await other.identity.issueToken(MORGAN_LEE_SUBJECT));
      expect(response.status).toBe(401);
    }
    expect(seen).toEqual(["prn_nf-morgan-lee", "prn_rb-morgan-lee"]);
  });
});

describe("Access-shaped sign-in", () => {
  it("refuses a token without a subject, as the Access adapter does", async () => {
    const [northfield] = await bootHarness();
    const token = await northfield!.identity.issueToken("");
    const response = await me((request) => northfield!.district.fetch(request), "/me", token);
    expect(response.status).toBe(401);
  });

  it("treats a service-token payload as a service credential, which never resolves to a person", async () => {
    const [northfield] = await bootHarness();
    // Access service tokens carry `common_name` and an empty `sub`; the fixtures link no service.
    const token = await northfield!.identity.issueToken("", { extraClaims: { common_name: "user-1042" } });
    const response = await me((request) => northfield!.district.fetch(request), "/me", token);
    expect(response.status).toBe(401);
  });

  it("refuses a token naming both a user and a service token", async () => {
    const [northfield] = await bootHarness();
    const token = await northfield!.identity.issueToken(MORGAN_LEE_SUBJECT, { extraClaims: { common_name: "client.access" } });
    const response = await me((request) => northfield!.district.fetch(request), "/me", token);
    expect(response.status).toBe(401);
  });
});
