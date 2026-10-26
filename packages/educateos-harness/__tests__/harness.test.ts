import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import { DEMO_DISTRICTS, NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { DistrictInstance, FakeAiProvider, FakeIdentityProvider, FakeRosterProvider, bootHarness } from "../src/index.ts";

const get = (district: DistrictInstance, path: string, token?: string) =>
  district.fetch(new Request(`http://district.test${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }));

// Responses are asserted on field by field, so their bodies are read loosely.
const body = async (response: Response): Promise<Record<string, any>> => response.json() as Promise<Record<string, any>>;

async function boot() {
  const [northfield, riverbend] = await bootHarness();
  return { northfield: northfield!, riverbend: riverbend! };
}

describe("booting", () => {
  it("boots both districts with health reporting their seeded directories", async () => {
    const { northfield, riverbend } = await boot();
    for (const [entry, snapshot] of [[northfield, NORTHFIELD], [riverbend, RIVERBEND]] as const) {
      const response = await get(entry.district, "/health");
      expect(response.status).toBe(200);
      const health = await body(response);
      expect(health).toMatchObject({
        districtId: snapshot.district.id,
        status: "ok",
        providers: { identity: "fake", roster: "fake", ai: "fake" },
        aiUsage: { requests: 0, tokens: 0 },
      });
      expect(health.directory.principals).toBe(snapshot.principals.length);
      expect(health.directory.students).toBeGreaterThanOrEqual(2);
      expect(health.directory.activeEnrollments).toBe(snapshot.enrollments.filter((e) => e.status === "active").length);
    }
  });

  it("boots all six demo districts by default, in harness port order", async () => {
    const entries = await bootHarness();
    expect(entries.map((e) => e.district.districtId)).toEqual(DEMO_DISTRICTS.map((d) => d.directory.district.id));
    for (const [i, entry] of entries.entries()) {
      const health = await body(await get(entry.district, "/health"));
      expect(health.directory.principals).toBe(DEMO_DISTRICTS[i]!.directory.principals.length);
    }
  });

  it("refuses a directory that fails its integrity checks", async () => {
    const broken = structuredClone(NORTHFIELD);
    broken.enrollments[0]!.offeringId = OfferingId.parse("off_nowhere");
    await expect(DistrictInstance.boot({
      roster: new FakeRosterProvider(broken),
      identity: new FakeIdentityProvider(NORTHFIELD.district.trustedIssuers[0]!),
      ai: new FakeAiProvider(),
    })).rejects.toThrow(/unknown offering off_nowhere/);
  });

  it("refuses an IdP the district does not trust", async () => {
    await expect(DistrictInstance.boot({
      roster: new FakeRosterProvider(NORTHFIELD),
      identity: new FakeIdentityProvider("https://idp.elsewhere.example"),
      ai: new FakeAiProvider(),
    })).rejects.toThrow(/not a trusted issuer/);
  });

  it("gives each district its own copy of the directory", async () => {
    const { northfield } = await boot();
    expect(northfield.district.directory).not.toBe(NORTHFIELD);
    expect(northfield.district.directory).toEqual(NORTHFIELD);
  });
});

describe("identity", () => {
  it("resolves a token to the principal linked to its issuer and subject", async () => {
    const { northfield } = await boot();
    const response = await get(northfield.district, "/me", await northfield.identity.issueToken("nf-s-2001"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ principalId: "prn_nf-student-amara", kind: "student" });
  });

  it("rejects another district's tokens, even for a subject that exists in both", async () => {
    const { northfield, riverbend } = await boot();
    const nfToken = await northfield.identity.issueToken("user-1042");
    const rbToken = await riverbend.identity.issueToken("user-1042");

    expect(await body(await get(northfield.district, "/me", nfToken))).toMatchObject({ principalId: "prn_nf-morgan-lee" });
    expect(await body(await get(riverbend.district, "/me", rbToken))).toMatchObject({ principalId: "prn_rb-morgan-lee" });
    expect((await get(riverbend.district, "/me", nfToken)).status).toBe(401);
    expect((await get(northfield.district, "/me", rbToken)).status).toBe(401);
  });

  it("rejects missing, forged, expired and unknown-subject tokens", async () => {
    const { northfield } = await boot();
    const impostor = new FakeIdentityProvider(northfield.identity.issuer);
    const valid = await northfield.identity.issueToken("nf-s-2001");
    const payload = valid.split(".")[1];
    const algNone = `${btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")}.${payload}.`;
    for (const token of [
      undefined,
      "",
      "not-a-jwt",
      algNone,
      await impostor.issueToken("nf-s-2001"),
      await northfield.identity.issueToken("nf-s-2001", { ttlSeconds: -60 }),
      await northfield.identity.issueToken("nobody"),
    ]) {
      const response = await get(northfield.district, "/me", token);
      expect(response.status, String(token)).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    }
  });

  it("takes roles from the directory and ignores role claims in the token", async () => {
    const { northfield } = await boot();
    const token = await northfield.identity.issueToken("nf-s-2001", { extraClaims: { roles: ["district-admin"], kind: "staff" } });
    const me = await body(await get(northfield.district, "/me", token));
    expect(me.kind).toBe("student");
    expect(me.roles).toEqual([]);
  });

  it("omits inactive enrollments from a principal's live classes", async () => {
    const { northfield } = await boot();
    const me = await body(await get(northfield.district, "/me", await northfield.identity.issueToken("nf-s-2003")));
    expect(me.enrollments.map((e: { offeringId: string }) => e.offeringId)).not.toContain("off_nf-eng9-fall-p3");
  });
});

describe("fake AI", () => {
  it("attributes usage to the caller's district and principal without retaining the prompt", async () => {
    const { northfield, riverbend } = await boot();
    const prompt = "Explain how mitochondria produce ATP in my own words";
    const response = await northfield.district.fetch(new Request("http://district.test/ai/complete", {
      method: "POST",
      headers: { authorization: `Bearer ${await northfield.identity.issueToken("nf-s-2001")}` },
      body: JSON.stringify({ prompt }),
    }));
    expect(response.status).toBe(200);

    expect(northfield.ai.usageFor(PrincipalId.parse("prn_nf-student-amara"))).toMatchObject({ requests: 1 });
    expect((await body(await get(northfield.district, "/health"))).aiUsage.requests).toBe(1);
    expect((await body(await get(riverbend.district, "/health"))).aiUsage.requests).toBe(0);
    expect(JSON.stringify(northfield.district.health())).not.toContain("mitochondria");
  });

  it("requires a signed-in principal", async () => {
    const { northfield } = await boot();
    const response = await northfield.district.fetch(new Request("http://district.test/ai/complete", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
    }));
    expect(response.status).toBe(401);
  });
});

describe("CLI", () => {
  it("boots both districts and reports healthy over HTTP with --check", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "--check"], { timeout: 30_000 });
    expect(stdout).toMatch(/dst_northfield .* health=200/);
    expect(stdout).toMatch(/dst_riverbend .* health=200/);
    // The CLI now boots and seeds the full district app for both districts in a child process, which
    // takes several seconds on a loaded CI runner; match the vitest budget to execFile's.
  }, 35_000);
});
