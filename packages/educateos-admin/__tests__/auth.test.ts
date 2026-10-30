// Operator sign-in through the Worker's own entry: the Access assertion is verified on every /api
// request (signature, issuer, audience, expiry), keyed by subject, and checked against ADMINS.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Me } from "../src/shared/api.ts";
import { parseAdmins, roleFor } from "../src/worker/config.ts";
import { assertion, type Claims } from "./support.ts";

const ORIGIN = "https://admin.educateos.io";

async function get(path: string, claims?: Claims | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (claims !== null) headers.set("cf-access-jwt-assertion", await assertion(claims));
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

describe("operator sign-in", () => {
  it("answers /healthz without sign-in", async () => {
    const response = await get("/healthz", null);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", edition: "hosted" });
  });

  it("refuses /api without an assertion, or with a forged, expired or other-application one", async () => {
    const cases: [string, Claims | null][] = [
      ["no assertion", null],
      ["another key", { key: env.TEST_STRANGER_PRIVATE_JWK }],
      ["expired", { expiresIn: "-1m" }],
      ["another application", { aud: "c".repeat(64) }],
    ];
    for (const [what, claims] of cases) {
      const response = await get("/api/me", claims);
      expect(response.status, what).toBe(401);
      await response.body?.cancel();
    }
  });

  it("refuses someone Access signed in whom ADMINS doesn't list", async () => {
    const response = await get("/api/me", { sub: "sub-stranger", email: "someone@example.org" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  it("admits ADMINS entries by email (any case) or by Access subject, and records the operator", async () => {
    const byEmail = await get("/api/me", { sub: "sub-email", email: "OPS@educateos.io" });
    expect(await byEmail.json<Me>()).toEqual({
      operator: { email: "ops@educateos.io", role: "admin" }, edition: "hosted", installUrl: "https://educateos.io/app/install",
    });
    const bySub = await get("/api/me", { sub: "sub-listed-by-id", email: "someone-else@example.org" });
    expect(bySub.status).toBe(200);
    await bySub.body?.cancel();
    const row = await env.DB.prepare("SELECT email, role FROM operators WHERE sub = 'sub-email'").first();
    expect(row).toEqual({ email: "ops@educateos.io", role: "admin" });
  });

  it("lets a viewer read but not change anything", async () => {
    const viewer = { sub: "sub-viewer", email: "viewer@educateos.io" };
    const list = await get("/api/workspaces", viewer);
    expect(list.status).toBe(200);
    await list.body?.cancel();
    const enroll = await get("/api/workspaces", viewer, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ slug: "viewer-try", displayName: "X", origin: "https://x.example.org" }),
    });
    expect(enroll.status).toBe(403);
    expect(await enroll.json()).toMatchObject({ message: "Viewers can't make changes." });
  });

  it("refuses a cross-origin or non-JSON change from a signed-in admin's browser", async () => {
    const body = JSON.stringify({ slug: "csrf-try", displayName: "X", origin: "https://x.example.org" });
    const crossSite = await get("/api/workspaces", {}, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example.org" }, body });
    expect(crossSite.status).toBe(403);
    await crossSite.body?.cancel();
    const form = await get("/api/workspaces", {}, { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body });
    expect(form.status).toBe(415);
    await form.body?.cancel();
  });

  it("parses ADMINS entries and roles", () => {
    const admins = parseAdmins(" a@x.org,b@x.org:viewer\nsub-1:admin  b@x.org ");
    expect(admins).toEqual([
      { who: "a@x.org", role: "admin" },
      { who: "b@x.org", role: "viewer" },
      { who: "sub-1", role: "admin" },
      { who: "b@x.org", role: "admin" },
    ]);
    expect(roleFor(admins, { subject: "s", email: "B@x.org" })).toBe("admin");
    expect(roleFor(admins, { subject: "sub-1", email: "z@x.org" })).toBe("admin");
    // A subject entry never matches an email, nor an email entry a subject.
    expect(roleFor(parseAdmins("a@x.org"), { subject: "a@x.org", email: "q@x.org" })).toBeUndefined();
    expect(roleFor(parseAdmins("sub-9"), { subject: "s", email: "sub-9" })).toBeUndefined();
    expect(roleFor(parseAdmins(undefined), { subject: "s", email: "a@x.org" })).toBeUndefined();
  });
});
