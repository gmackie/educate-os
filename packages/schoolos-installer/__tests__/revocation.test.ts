import { describe, expect, it } from "vitest";
import { install, InstallerHaltedError, OAuthTokenProvider, OWNERSHIP_TOKEN_SECRET } from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  makeRoot,
  NORTHFIELD,
  replaceModule,
  RIVERBEND,
  SECRETS,
  tokenFor,
} from "./support.ts";

async function releases() {
  const r1 = await goldenRelease();
  const r2 = await deriveRelease(r1, "r000001-fixture", (manifest, artifacts) =>
    replaceModule(manifest, artifacts, "workshop-backend", "export default {}; // r2\n"));
  return { r1, r2 };
}

describe("credential revocation", () => {
  it("stops at the first refused call when the OAuth grant is revoked mid-upgrade, leaving the district serving", async () => {
    const { r1, r2 } = await releases();
    const fake = accountFor(NORTHFIELD);
    const oauth = tokenFor(fake, "oauth");
    const run = (release: typeof r1, tokens = oauth.tokens) => install({
      api: fake.api(tokens),
      config: configFor(NORTHFIELD, release),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS,
    });
    await run(r1);

    // The district owner revokes the root's grant just as the upgrade starts changing things.
    let revokedAt = -1;
    fake.beforeMutation = () => {
      if (revokedAt < 0) {
        fake.revokeToken(oauth.token);
        revokedAt = fake.calls.length;
      }
    };
    const upgrade = run(r2);

    await expect(upgrade).rejects.toBeInstanceOf(InstallerHaltedError);
    await expect(upgrade).rejects.toMatchObject({ code: "unauthenticated" });
    // Exactly one call was attempted after revocation, it was refused, and nothing followed it.
    expect(fake.calls.slice(revokedAt)).toEqual([expect.objectContaining({ mutation: true, outcome: "rejected" })]);
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe(r1.manifest.releaseId);

    // The district can finish the upgrade itself with its own token.
    fake.beforeMutation = undefined;
    const district = tokenFor(fake, "district-run");
    expect((await run(r2, district.tokens)).status).toBe("applied");
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe(r2.manifest.releaseId);
  });

  it("makes no change at all when the grant is already revoked: the refused refresh is a preflight finding", async () => {
    const { r1 } = await releases();
    const fake = accountFor(NORTHFIELD);
    let tokenRequests = 0;
    const tokens = new OAuthTokenProvider(
      { accessToken: "expired-access-token", refreshToken: "revoked-refresh-token", expiresAt: 0, scopes: [] },
      {
        clientId: "schoolos-installer",
        fetch: async () => {
          tokenRequests += 1;
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        },
      },
    );

    const report = await install({
      api: fake.api(tokens),
      config: configFor(NORTHFIELD, r1),
      manifest: r1.manifest,
      artifacts: r1.artifacts,
      secrets: SECRETS,
    });

    expect(report.status).toBe("preflight-blocked");
    expect(report.preflight.blocking).toEqual([expect.objectContaining({ code: "credential.rejected" })]);
    expect(fake.calls.filter((c) => c.outcome !== "rejected")).toEqual([]);
    // Once Cloudflare refused the refresh, the provider never asks again.
    expect(tokenRequests).toBe(1);
  });
});

describe("root shutdown", () => {
  it("leaves the deployed district running and lets the district keep installing on its own", async () => {
    const { r1, r2 } = await releases();
    const fake = accountFor(NORTHFIELD);
    const root = makeRoot();
    const oauth = tokenFor(fake, "oauth");
    const installed = await install({
      api: fake.api(oauth.tokens),
      config: configFor(NORTHFIELD, r1),
      manifest: r1.manifest,
      artifacts: r1.artifacts,
      secrets: SECRETS,
      registry: root.endpoint,
    });
    expect(installed.registration?.status).toBe("registered");

    // schoolos.dev goes away: its registry is down and its OAuth grant is gone.
    root.shutDown();
    fake.revokeToken(oauth.token);

    // The district is unaffected: still served, and it holds its own fleet credentials.
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe(r1.manifest.releaseId);
    expect(fake.worker("schoolos-northfield-workshop-backend")!.secretNames).toContain(OWNERSHIP_TOKEN_SECRET);

    // District-run mode needs nothing from the root.
    const district = tokenFor(fake, "district-run");
    const upgraded = await install({
      api: fake.api(district.tokens),
      config: configFor(NORTHFIELD, r2),
      manifest: r2.manifest,
      artifacts: r2.artifacts,
      secrets: SECRETS,
      registry: root.endpoint,
    });
    expect(upgraded.status).toBe("applied");
    expect(upgraded.registration?.status).toBe("already-registered");
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe(r2.manifest.releaseId);
  });

  it("completes a first install while the root is down and leaves registration pending", async () => {
    const { r1 } = await releases();
    const fake = accountFor(RIVERBEND);
    const root = makeRoot();
    root.shutDown();
    const { tokens } = tokenFor(fake, "district-run");

    const report = await install({
      api: fake.api(tokens),
      config: configFor(RIVERBEND, r1),
      manifest: r1.manifest,
      artifacts: r1.artifacts,
      secrets: SECRETS,
      registry: root.endpoint,
    });

    expect(report.status).toBe("applied");
    expect(report.registration).toEqual({ status: "pending", reason: "registry-unreachable" });
    expect(fake.serving("schoolos.riverbend.example")?.releaseId).toBe(r1.manifest.releaseId);
    // No ownership token was stored, so the next run tries to register again.
    expect(fake.worker("schoolos-riverbend-workshop-backend")!.secretNames).not.toContain(OWNERSHIP_TOKEN_SECRET);
  });
});
