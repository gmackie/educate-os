// The console's move to the admin (SCHO-263): ADMIN_URL sends /app and /app/* there with a 302,
// except the guided install, and nothing changes while it is unset. The read-only export the admin
// imports from is served only over the RPC entrypoint, and it writes nothing.

import { createExecutionContext, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ControlPlaneExport, ControlPlaneStore, TABLES } from "../src/store.ts";
import { adminUrl, CONTROL_PLANE_OBJECT, ControlPlaneExporter, siteWorker } from "../src/worker.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const SHELL = { header: "<header>site header</header>", footer: "<footer>site footer</footer>" };
const ADMIN = "https://admin.educateos.io/";

async function assertion(sub: string, email = "operator@example.org"): Promise<string> {
  return new SignJWT({ sub, email })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
}

/** The site Worker with ADMIN_URL set to `value`. */
async function site(path: string, value: string | undefined, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
  const worker = siteWorker(SHELL, { accessKeys: keys, probe: async () => ({ state: "responding" }) });
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("cf-access-jwt-assertion", init.token);
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new Request(`https://educateos.io${path}`, { ...init, headers, redirect: "manual" }) as Request<unknown, IncomingRequestCfProperties>,
    { ...env, ...(value === undefined ? {} : { ADMIN_URL: value }) },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("ADMIN_URL", () => {
  it("sends /app and every console page to the admin with a 302", async () => {
    for (const path of ["/app", "/app/", "/app/api/installations", "/app/api/me", "/app/anything?x=1"]) {
      const response = await site(path, ADMIN);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(ADMIN);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await response.body?.cancel();
    }
  });

  it("keeps the guided install on educateos.io", async () => {
    const response = await site("/app/install", ADMIN, { token: await assertion("installer-1") });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("site header");
  });

  it("leaves Clever launches, the registry, the health check and the static site alone", async () => {
    const health = await site("/healthz", ADMIN);
    expect(health.status).toBe(200);
    await health.body?.cancel();
    const page = await site("/connectors/", ADMIN);
    expect(await page.text()).toBe("static /connectors/");
    const registry = await site("/registry/v1/heartbeat", ADMIN);
    expect(registry.status).toBe(405);
    await registry.body?.cancel();
    const clever = await site("/clever/launch", ADMIN);
    expect(clever.status).not.toBe(302);
    await clever.body?.cancel();
  });

  it("changes nothing while unset, blank or not an https URL", async () => {
    for (const value of [undefined, "", "  ", "http://admin.educateos.io/", "admin.educateos.io"]) {
      const response = await site("/app/", value);
      // Without an assertion the console answers 401 itself: it was not redirected.
      expect(response.status, String(value)).toBe(401);
      await response.body?.cancel();
    }
    expect(adminUrl(" https://admin.educateos.io ")).toBe(ADMIN);
    expect(adminUrl("https://admin.educateos.io/welcome")).toBe("https://admin.educateos.io/welcome");
  });

  it("is unset in the test Worker, as in production today", async () => {
    const response = await SELF.fetch("https://educateos.io/app/", { redirect: "manual" });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});

describe("the export", () => {
  it("reads every operator, installation and reservation, and writes nothing", async () => {
    const stub = env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);
    const subject = `export-${crypto.randomUUID()}`;
    const operator = await stub.signIn({ issuer: ACCESS_ISSUER, subject, email: "installer@example.org" });
    const account = "ab".repeat(16);
    const slug = `exp${Date.now().toString(36)}`;
    expect(await stub.reserveInstall(subject, slug, account, `ins_${slug}`)).toEqual({ ok: true, instanceId: `ins_${slug}` });
    const installation = {
      instanceId: `ins_${slug}`, slug, hostname: `${slug}.educateos.io`, accountId: account, releaseVersion: "0.1.0", installedAt: "2026-10-27T10:00:00.000Z",
    };
    expect(await stub.recordInstallation(subject, installation)).toBe(true);
    await stub.endInstall(subject, slug, false);

    const counts = () => runInDurableObject(stub, (_, state) =>
      Object.values(TABLES).map((table) => state.storage.sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n));
    const before = await counts();

    const ctx = createExecutionContext();
    const exported = await new ControlPlaneExporter(ctx, env).exportSnapshot();
    expect(ControlPlaneExport.parse(exported)).toEqual(exported);
    expect(exported.version).toBe(1);
    expect(exported.operators).toContainEqual({
      subject, accountId: operator.accountId, email: "installer@example.org", firstSeenAt: operator.firstSeenAt, lastSeenAt: operator.lastSeenAt,
    });
    expect(exported.installations).toContainEqual({ operatorSubject: subject, installation });
    expect(exported.reservations).toContainEqual({ slug, operatorSubject: subject, accountId: account, instanceId: `ins_${slug}`, leaseUntil: null });
    expect(await counts()).toEqual(before);
  });

  it("is not served over HTTP", async () => {
    for (const path of ["/app/api/export", "/registry/v1/export"]) {
      const response = await SELF.fetch(`https://educateos.io${path}`, { redirect: "manual" });
      expect(response.status, path).not.toBe(200);
      await response.body?.cancel();
    }
  });

  it("reads a store's own rows the same way (the store method)", async () => {
    await runInDurableObject(env.CONTROL_PLANE.getByName(`export-${crypto.randomUUID()}`), (_, state) => {
      const store = new ControlPlaneStore(state.storage, () => new Date("2026-10-28T00:00:00.000Z"));
      expect(store.exportSnapshot()).toEqual({ version: 1, exportedAt: "2026-10-28T00:00:00.000Z", operators: [], installations: [], reservations: [] });
    });
  });
});
