// The guided install's routes in workerd: the form, the checks a post passes before anything runs,
// and the progress page it streams. The install itself is tested against the installer's fake in
// __tests__/node/guided-install.test.ts.

import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";
const TOKEN = "t0ken-value-that-must-never-be-echoed-anywhere";
let count = 0;

async function assertion(): Promise<string> {
  return new SignJWT({ sub: `installer-${count++}`, email: "it@riverbend.example" })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
}

const FORM = {
  slug: "riverbend", accountId: "d1".repeat(16), baseDomain: "riverbend.example", accessTeam: "riverbend",
  allowedEmailDomains: "riverbend.example", admins: "it@riverbend.example", token: TOKEN,
};

async function post(fields: Record<string, string>, origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { "cf-access-jwt-assertion": await assertion() };
  if (origin !== null) headers.origin = origin;
  return SELF.fetch(`${ORIGIN}/app/install`, { method: "POST", headers, body: new URLSearchParams(fields) });
}

describe("the guided install's routes", () => {
  it("serves the form, with a link that prefills a token holding exactly the permissions it needs", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}/app/install`, { headers: { "cf-access-jwt-assertion": await assertion() } })).text();
    expect(body).toContain('name="token" type="password"');
    const link = new URL(body.match(/href="(https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?[^"]+)"/)![1]!.replaceAll("&amp;", "&"));
    expect(JSON.parse(link.searchParams.get("permissionGroupKeys")!)).toContainEqual({ key: "workers_scripts", type: "edit" });
    expect(JSON.parse(link.searchParams.get("permissionGroupKeys")!)).toHaveLength(13);
  });

  it("refuses a post from anywhere but the console, or before sign-in", async () => {
    for (const origin of [null, "https://evil.example", "https://www.educateos.io"]) {
      const response = await post(FORM, origin);
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }
    const unsigned = await SELF.fetch(`${ORIGIN}/app/install`, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(FORM) });
    expect(unsigned.status).toBe(401);
    await unsigned.body?.cancel();
  });

  it("shows a rejected form again with its errors, never the token", async () => {
    const response = await post({ ...FORM, slug: "app", accountId: "not-an-account" });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('value="not-an-account"');
    expect(body).toContain("that slug is reserved");
    expect(body).not.toContain(TOKEN);
  });

  it("streams the run as the page itself, and reports a stop without the token", async () => {
    const response = await post(FORM);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("Installing riverbend.educateos.io");
    expect(body).toContain("No signed release is published yet.");
    expect(body).toContain("educateos.io has discarded your token");
    expect(body).toContain("<footer>site footer</footer>");
    expect(body).not.toContain(TOKEN);
  });
});

describe("slug reservations", () => {
  it("holds a slug for one operator and account, one run at a time, under one instance ID", async () => {
    const { runInDurableObject } = await import("cloudflare:test");
    const { ControlPlaneStore } = await import("../src/store.ts");
    await runInDurableObject(env.CONTROL_PLANE.getByName(`reservations-${count++}`), (_, state) => {
      let now = Date.parse("2026-10-26T12:00:00.000Z");
      const store = new ControlPlaneStore(state.storage, () => new Date(now));
      const a = store.signIn({ issuer: ACCESS_ISSUER, subject: "a", email: "a@example.org" }).subject;
      const b = store.signIn({ issuer: ACCESS_ISSUER, subject: "b", email: "b@example.org" }).subject;
      const account = "d1".repeat(16);

      expect(store.reserveInstall(a, "riverbend", account, "ins_riverbend")).toEqual({ ok: true, instanceId: "ins_riverbend" });
      expect(store.reserveInstall(a, "riverbend", account, "ins_riverbend")).toEqual({ ok: false, reason: "running" });
      expect(store.reserveInstall(b, "riverbend", account, "ins_riverbend")).toEqual({ ok: false, reason: "taken" });
      expect(store.reserveInstall(a, "riverbend", "e2".repeat(16), "ins_riverbend")).toEqual({ ok: false, reason: "taken" });
      // Nobody else can record an installation under the reservation.
      const record = { instanceId: "ins_riverbend", slug: "riverbend", hostname: "riverbend.educateos.io", accountId: account, releaseVersion: "0.1.0", installedAt: "2026-10-26T12:00:00.000Z" };
      expect(store.recordInstallation(b, record)).toBe(false);
      expect(store.recordInstallation(a, { ...record, instanceId: "ins_other" })).toBe(false);
      expect(store.recordInstallation(a, record)).toBe(true);
      store.endInstall(a, "riverbend", true);
      // Installed, so ending with release keeps the slug; the next run resumes as the same instance.
      expect(store.reserveInstall(a, "riverbend", account, "ins_ignored")).toEqual({ ok: true, instanceId: "ins_riverbend" });
      expect(store.recordInstallation(a, { ...record, releaseVersion: "0.2.0" })).toBe(true);
      expect(store.installations(a).map((i) => i.releaseVersion)).toEqual(["0.2.0"]);

      // A run that dies keeps its lease only until the lease runs out.
      expect(store.reserveInstall(b, "lakeshore", account, "ins_lakeshore")).toMatchObject({ ok: true });
      now += 31 * 60 * 1000;
      expect(store.reserveInstall(b, "lakeshore", account, "ins_lakeshore")).toMatchObject({ ok: true });
      // A run that changed nothing gives the slug back.
      store.endInstall(b, "lakeshore", true);
      expect(store.reserveInstall(a, "lakeshore", account, "ins_lakeshore")).toMatchObject({ ok: true });
      // And an instance ID is never reserved twice.
      expect(store.reserveInstall(b, "harbor", account, "ins_lakeshore")).toEqual({ ok: false, reason: "taken" });
    });
  });
});
