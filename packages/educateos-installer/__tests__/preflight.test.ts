import { describe, expect, it } from "vitest";
import { compileDesiredState, install, preflight } from "../src/index.ts";
import { accountFor, configFor, goldenRelease, mutations, NORTHFIELD, SECRETS, tokenFor } from "./support.ts";

async function check(options: Parameters<typeof accountFor>[1]) {
  const release = await goldenRelease();
  const fake = accountFor(NORTHFIELD, options);
  const { tokens } = tokenFor(fake, "district-run");
  const config = configFor(NORTHFIELD, release);
  return { fake, report: await preflight(fake.api(tokens), config, compileDesiredState(release.manifest, config)) };
}

describe("preflight", () => {
  it("passes a ready account, warning only about what the API cannot confirm", async () => {
    const { report } = await check({});
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(["product.worker-loader"]);
  });

  it("names every product, DNS and IdP step the operator must take on an unprepared account", async () => {
    const { report } = await check({
      ratePlans: ["free"],
      r2Enabled: false,
      accessTeam: null,
      zones: [],
    });

    expect(report.ok).toBe(false);
    expect(report.blocking.map((b) => b.code)).toEqual([
      "plan.workers-paid-required",
      "product.r2-not-enabled",
      "access.organization-missing",
      "dns.zone-missing",
    ]);
    for (const item of report.blocking) expect(item.operatorAction).toBeTruthy();
    expect(report.blocking.find((b) => b.code === "dns.zone-missing")!.operatorAction).toContain("northfield.example");
    expect(report.warnings.map((w) => w.code)).toContain("access.free-seat-limit");
  });

  it("blocks on a pending zone, a taken hostname, a team mismatch and Cloudflare-login-only sign-in", async () => {
    const { report } = await check({
      accessTeam: "someone-else",
      identityProviders: [{ name: "Cloudflare", type: "cloudflare" }],
      zones: [{ name: "northfield.example", status: "pending" }],
      dnsRecords: [{ name: "educateos.northfield.example", type: "CNAME" }],
    });
    expect(report.blocking.map((b) => b.code)).toEqual([
      "access.team-mismatch",
      "access.idp-missing",
      "dns.zone-pending",
      "dns.record-conflict",
    ]);
  });

  describe("sign-in methods", () => {
    const codes = async (identityProviders: { name: string; type: string }[]) => {
      const { report } = await check({ identityProviders });
      return {
        blocking: report.blocking.map((b) => b.code),
        warnings: report.warnings.map((w) => w.code),
        idp: report.blocking.find((b) => b.code === "access.idp-missing"),
      };
    };
    const CLOUDFLARE = { name: "Cloudflare", type: "cloudflare" };
    const PIN = { name: "One-time PIN", type: "onetimepin" };

    it("blocks when the only login is a Cloudflare account, naming the fix", async () => {
      const result = await codes([CLOUDFLARE]);
      expect(result.blocking).toEqual(["access.idp-missing"]);
      expect(result.idp!.operatorAction).toMatch(/Google Workspace.*Microsoft Entra ID.*SAML or OIDC.*one-time PIN/s);
      expect(result.idp!.operatorAction).toContain("Zero Trust → Settings → Authentication");
    });

    it("blocks when there is no login method at all", async () => {
      expect((await codes([])).blocking).toEqual(["access.idp-missing"]);
    });

    it("warns, without blocking, when email codes are the only usable login", async () => {
      for (const idps of [[CLOUDFLARE, PIN], [PIN]]) {
        const result = await codes(idps);
        expect(result.blocking).toEqual([]);
        expect(result.warnings).toContain("access.idp-pin-only");
      }
    });

    it("passes a district identity provider", async () => {
      for (const type of ["google-apps", "saml", "azureAD"]) {
        const result = await codes([CLOUDFLARE, PIN, { name: "District SSO", type }]);
        expect(result.blocking).toEqual([]);
        expect(result.warnings).not.toContain("access.idp-pin-only");
      }
    });
  });

  it("stops the install before observing or changing anything", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD, { ratePlans: ["free"] });
    const { tokens } = tokenFor(fake, "district-run");
    const report = await install({
      api: fake.api(tokens),
      config: configFor(NORTHFIELD, release),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS,
    });
    expect(report.status).toBe("preflight-blocked");
    expect(report.plan).toBeUndefined();
    expect(mutations(fake)).toHaveLength(0);
  });

  it("reports a credential for another account as a missing permission", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const { tokens } = tokenFor(fake, "district-run");
    const config = configFor(NORTHFIELD, release, { accountId: "c3".repeat(16) });
    const report = await preflight(fake.api(tokens), config, compileDesiredState(release.manifest, config));
    expect(report.blocking).toEqual([expect.objectContaining({ code: "permission.missing", operatorAction: expect.stringContaining("Account Settings") })]);
  });
});
