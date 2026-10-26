// The site Worker's dynamic routes in workerd: the health check, the operator console's sign-in
// (an Access assertion verified on every request, never trusted on sight) and the operator store.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { errors, importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { operatorVerifier } from "../src/access.ts";
import { html, Html, THEME_SCRIPT, THEME_SCRIPT_HASH } from "../src/pages.ts";
import { ControlPlaneStore, LAST_SEEN_RESOLUTION_MS, TABLES } from "../src/store.ts";
import { CONTROL_PLANE_OBJECT } from "../src/worker.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";

interface Assertion {
  sub?: string;
  email?: string;
  common_name?: string;
  aud?: string;
  iss?: string;
  expiresIn?: string;
  key?: string;
}

let people = 0;
const someone = () => `user-${people++}`;

async function assertion(claims: Assertion = {}): Promise<string> {
  const { key = env.TEST_ACCESS_PRIVATE_JWK, aud = ACCESS_AUD, iss = ACCESS_ISSUER, expiresIn = "5m", ...rest } = claims;
  const payload = "common_name" in claims ? rest : { sub: someone(), email: "operator@example.org", ...rest };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(await importJWK(JSON.parse(key) as JWK, "RS256"));
}

async function get(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set("cf-access-jwt-assertion", token);
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

function encode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
}

function installationRecord(instanceId: string, slug: string, installedAt: string): string {
  return JSON.stringify({
    instanceId, slug, hostname: `${slug}.educateos.io`, accountId: "c".repeat(32), releaseVersion: "<b>1.0.0</b>", installedAt,
  });
}

describe("/healthz", () => {
  it("answers once the store does, naming the deployed commit", async () => {
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", commit: "0".repeat(40) });
  });

  it("refuses anything but GET and HEAD", async () => {
    const response = await get("/healthz", undefined, { method: "POST" });
    expect(response.status).toBe(405);
    await response.body?.cancel();
  });
});

describe("the static site", () => {
  it("serves every path the control plane doesn't own from the assets binding", async () => {
    for (const path of ["/", "/connectors/", "/application", "/apps/x"]) {
      const response = await get(path);
      expect(await response.text()).toBe(`static ${path}`);
    }
  });
});

describe("operator sign-in", () => {
  it("sends /app to /app/", async () => {
    const response = await get("/app");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/app/");
  });

  it("turns away a request with no assertion, or one that doesn't verify", async () => {
    const refused = [
      undefined,
      "",
      "not-a-jwt",
      await assertion({ key: env.TEST_STRANGER_PRIVATE_JWK }),
      await assertion({ aud: "b".repeat(64) }),
      await assertion({ iss: "https://someone-else.cloudflareaccess.com" }),
      await assertion({ expiresIn: "-1m" }),
      // A service token is not an operator.
      await assertion({ common_name: "ci.access" }),
      // Nor is a person without a verified email.
      await assertion({ email: "not an email" }),
    ];
    for (const token of refused) {
      const response = await get("/app/", token);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toContain("Sign-in required");
      expect(body).not.toContain("Your installations");
    }
  });

  it("refuses an unsigned assertion (alg none)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = `${encode({ alg: "none" })}.${encode({ sub: someone(), email: "x@example.org", iss: ACCESS_ISSUER, aud: ACCESS_AUD, exp: now + 300 })}.`;
    const response = await get("/app/", token);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("shows a signed-in operator their console, in the site's shell, uncached and under a strict CSP", async () => {
    const response = await get("/app/", await assertion({ email: "Ada@Example.org" }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<header>site header</header>");
    expect(body).toContain("<footer>site footer</footer>");
    expect(body).toContain("ada@example.org");
    expect(body).toContain("No installations yet.");
    expect(body).toContain('href="/cdn-cgi/access/logout"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src '${THEME_SCRIPT_HASH}'`);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("creates an operator on their first sign-in and keeps their email current after", async () => {
    const sub = someone();
    type Me = { accountId: string; email: string; firstSeenAt: string };
    const first = await (await get("/app/api/me", await assertion({ sub, email: "first@example.org" }))).json<Me>();
    const second = await (await get("/app/api/me", await assertion({ sub, email: "renamed@example.org" }))).json<Me>();
    const someoneElse = await (await get("/app/api/me", await assertion())).json<Me>();
    expect(first.email).toBe("first@example.org");
    expect(first.accountId).toMatch(/^acct_[0-9a-f]{32}$/);
    // The account outlives a change of email, and is the operator's alone.
    expect(second).toEqual({ accountId: first.accountId, email: "renamed@example.org", firstSeenAt: first.firstSeenAt });
    expect(someoneElse.accountId).not.toBe(first.accountId);

    const stub = env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);
    const rows = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec(`SELECT email FROM ${TABLES.operators} WHERE subject = ?`, sub).toArray());
    expect(rows).toEqual([{ email: "renamed@example.org" }]);
  });

  it("refreshes a returning operator's last sign-in at most hourly", async () => {
    const stub = env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);
    const seen = await runInDurableObject(stub, (_, state) => {
      let now = Date.parse("2026-10-26T10:00:00.000Z");
      const store = new ControlPlaneStore(state.storage, () => new Date(now));
      const identity = { issuer: ACCESS_ISSUER, subject: someone(), email: "hourly@example.org" };
      const times = [store.signIn(identity).lastSeenAt];
      now += LAST_SEEN_RESOLUTION_MS - 1;
      times.push(store.signIn(identity).lastSeenAt);
      now += 2;
      times.push(store.signIn(identity).lastSeenAt);
      return times;
    });
    expect(seen).toEqual(["2026-10-26T10:00:00.000Z", "2026-10-26T10:00:00.000Z", "2026-10-26T11:00:00.001Z"]);
  });

  it("answers only GET and HEAD, and 404s an unknown console page", async () => {
    const token = await assertion();
    const post = await get("/app/", token, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    await post.body?.cancel();
    const missing = await get("/app/nope", token);
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  });

  it("serves the console on educateos.io only, where Access guards it", async () => {
    for (const host of ["www.educateos.io", "educateos.dev", "www.educateos.dev"]) {
      const response = await SELF.fetch(`https://${host}/app/api/me?x=1`, { redirect: "manual" });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://educateos.io/app/api/me?x=1");
    }
  });

  it("says sign-in is unavailable, rather than refusing the operator, when the team's keys can't be fetched", async () => {
    const unreachable = operatorVerifier({
      issuer: ACCESS_ISSUER,
      audience: ACCESS_AUD,
      keys: () => Promise.reject(new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response")),
    });
    const request = new Request(`${ORIGIN}/app/`, { headers: { "cf-access-jwt-assertion": await assertion() } });
    await expect(unreachable(request)).rejects.toThrow("signing keys could not be fetched");
  });

  it("refuses a POST before it is signed in", async () => {
    const response = await get("/app/", undefined, { method: "POST" });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});

describe("installations", () => {
  it("lists only the operator's own, newest first, with every value escaped", async () => {
    const sub = someone();
    const token = await assertion({ sub });
    await (await get("/app/api/me", token)).body?.cancel();
    const other = someone();
    await (await get("/app/api/me", await assertion({ sub: other }))).body?.cancel();

    const record = installationRecord;
    const stub = env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);
    await runInDurableObject(stub, (_, state) => {
      const insert = `INSERT INTO ${TABLES.installations} (instance_id, operator_subject, slug, record) VALUES (?, ?, ?, ?)`;
      state.storage.sql.exec(insert, "ins_older", sub, "older", record("ins_older", "older", "2026-10-01T00:00:00.000Z"));
      state.storage.sql.exec(insert, "ins_newer", sub, "newer", record("ins_newer", "newer", "2026-10-20T00:00:00.000Z"));
      state.storage.sql.exec(insert, "ins_theirs", other, "theirs", record("ins_theirs", "theirs", "2026-10-21T00:00:00.000Z"));
    });

    const body = await (await get("/app/", token)).text();
    expect(body).not.toContain("theirs");
    expect(body.indexOf("newer.educateos.io")).toBeLessThan(body.indexOf("older.educateos.io"));
    expect(body).toContain("&lt;b&gt;1.0.0&lt;/b&gt;");
    expect(body).not.toContain("<b>1.0.0</b>");
  });

  it("refuses to render a stored installation it can't read", async () => {
    const sub = someone();
    const token = await assertion({ sub });
    await (await get("/app/api/me", token)).body?.cancel();
    const stub = env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(`INSERT INTO ${TABLES.installations} (instance_id, operator_subject, slug, record) VALUES (?, ?, ?, ?)`,
        "ins_corrupt", sub, "corrupt", "{not json");
    });
    const response = await get("/app/", token);
    expect(response.status).toBe(500);
    await response.body?.cancel();
  });
});

describe("pages", () => {
  it("escapes interpolated values but not fragments", () => {
    expect(html`<p>${`<script>"'&`}</p>`.text).toBe("<p>&lt;script&gt;&quot;&#39;&amp;</p>");
    expect(html`<p>${new Html("<b>ok</b>")}${[html`<i>${"<"}</i>`]}</p>`.text).toBe("<p><b>ok</b><i>&lt;</i></p>");
  });

  it("admits the theme script by the hash of its exact text", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(THEME_SCRIPT)));
    expect(THEME_SCRIPT_HASH).toBe(`sha256-${btoa(String.fromCharCode(...digest))}`);
  });
});
