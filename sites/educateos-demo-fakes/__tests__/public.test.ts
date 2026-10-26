// The public surface: liveness, the index, routing to each fake, real clients configured with the
// deployed URL shapes, and the limits a public deployment needs.
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { oneroster } from "@educateos/integrations";
import { CleverDataFake, DEFAULT_ONEROSTER_CLIENT, OneRosterFake, tokenId, CLASSROOM_SCOPES } from "@educateos/provider-fakes";
import { MAX_BODY_BYTES } from "../src/worker.ts";
import { seedOf } from "../src/fakes.ts";
import { ORIGIN } from "./constants.ts";
import { admin, call, clientFetch, credentials } from "./helpers.ts";

describe("liveness and the index", () => {
  it("answers /healthz without reading anything", async () => {
    const answer = await call("/healthz");
    expect(answer.status).toBe(200);
    expect(answer.text).toBe("ok");
  });

  it("lists each district's fakes by base URL, and no credentials", async () => {
    const index = (await call("/")).json<{ districts: { slug: string; fakes: Record<string, string> }[] }>();
    const fakes = Object.fromEntries(index.districts.map((d) => [d.slug, d.fakes]));
    expect(fakes).toEqual({
      northfield: { oneroster: `${ORIGIN}/northfield/oneroster`, "lti/canvas": `${ORIGIN}/northfield/lti/canvas` },
      riverbend: { oneroster: `${ORIGIN}/riverbend/oneroster` },
      prairie: {},
      cedarvalley: { clever: `${ORIGIN}/cedarvalley/clever`, google: `${ORIGIN}/cedarvalley/google`, classroom: `${ORIGIN}/cedarvalley/classroom` },
      lakeshore: { classlink: `${ORIGIN}/lakeshore/classlink`, oneroster: `${ORIGIN}/lakeshore/oneroster`, "lti/schoology": `${ORIGIN}/lakeshore/lti/schoology` },
      harbor: { google: `${ORIGIN}/harbor/google`, classroom: `${ORIGIN}/harbor/classroom` },
    });
    const text = (await call("/")).text;
    const secrets = await credentials("cedarvalley");
    for (const secret of [secrets.clever.districtToken, secrets.clever.oidc.clientSecret, secrets.google.oidc.clientSecret]) expect(text).not.toContain(secret);
  });
});

describe("routing", () => {
  it("404s unknown districts, fakes a district's profile does not use, and paths outside any fake", async () => {
    for (const path of [
      "/nowhere/clever/.well-known/openid-configuration",
      "/prairie/oneroster/token",
      "/northfield/clever/.well-known/openid-configuration",
      "/harbor/lti/canvas/api/lti/security/jwks",
      "/riverbend/lti/",
      "/riverbend",
      "/favicon.ico",
    ]) {
      const answer = await call(path, { ip: "192.0.2.10" });
      expect(answer.status, path).toBe(404);
    }
  });

  it("serves each vendor's own paths below its base", async () => {
    const ip = { ip: "192.0.2.11" };
    for (const vendor of ["clever", "google"]) {
      const discovery = (await call(`/cedarvalley/${vendor}/.well-known/openid-configuration`, ip)).json();
      expect(discovery.issuer).toBe(`${ORIGIN}/cedarvalley/${vendor}`);
      expect(discovery.token_endpoint.startsWith(`${ORIGIN}/cedarvalley/${vendor}/`)).toBe(true);
    }
    expect((await call("/lakeshore/classlink/.well-known/openid-configuration", ip)).json().userinfo_endpoint).toBe(`${ORIGIN}/lakeshore/classlink/v2/my/profileinfo`);
    expect((await call("/cedarvalley/clever/v3.1/districts", ip)).status).toBe(401);
    expect((await call("/harbor/classroom/v1/courses", ip)).status).toBe(401);
    expect((await call("/riverbend/oneroster/ims/oneroster/rostering/v1p2/users", ip)).status).toBe(401);
    expect((await call("/northfield/lti/canvas/api/lti/security/jwks", ip)).json().keys).toHaveLength(1);
    expect((await call("/lakeshore/lti/schoology/lti-service/.well-known/jwks", ip)).json().keys).toHaveLength(1);
  });
});

describe("a OneRoster REST client configured with the deployed URLs", () => {
  it("syncs every collection, following Link headers across pages", async () => {
    const { oneroster: server } = await credentials("riverbend");
    const client = new oneroster.OneRosterRestClient({
      config: { baseUrl: server.baseUrl, tokenUrl: server.tokenUrl, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 5 },
      credentials: { clientId: server.clientId, clientSecret: server.clientSecret },
      fetch: clientFetch("192.0.2.20"),
      sleep: async () => {},
    });
    const local = new OneRosterFake({ seed: seedOf("riverbend") });
    for (const collection of oneroster.ROSTER_COLLECTIONS) {
      const read = await client.list(collection);
      expect(read.issues, collection).toEqual([]);
      expect(read.records.length, collection).toBe(local.records(collection).length);
    }
    expect(server.baseUrl).toBe(`${ORIGIN}/riverbend/oneroster`);
    expect(server.tokenUrl).toBe(`${ORIGIN}/riverbend/oneroster/token`);
  });

  it("refuses the fakes' public default client", async () => {
    const answer = await call("/riverbend/oneroster/token", {
      method: "POST",
      ip: "192.0.2.21",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${DEFAULT_ONEROSTER_CLIENT.clientId}:${DEFAULT_ONEROSTER_CLIENT.clientSecret}`)}` },
      body: "grant_type=client_credentials",
    });
    expect(answer.status).toBe(401);
  });
});

/** A minimal Clever Data API client: follows each page's `next` link, resolved against the API's origin. */
async function cleverList(fetch: typeof globalThis.fetch, base: string, token: string, path: string): Promise<{ data: { id: string } }[]> {
  const items: { data: { id: string } }[] = [];
  let next: string | undefined = `${base}${path}`;
  while (next !== undefined) {
    const response: Response = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { data: { data: { id: string } }[]; links: { rel: string; uri: string }[] };
    items.push(...page.data);
    const uri = page.links.find((l) => l.rel === "next")?.uri;
    next = uri === undefined ? undefined : new URL(uri, base).toString();
  }
  return items;
}

describe("a Clever client configured with the deployed URLs", () => {
  it("lists every user, page by page, with the secret-derived district token", async () => {
    const { clever } = await credentials("cedarvalley");
    expect(clever.dataApi).toBe(`${ORIGIN}/cedarvalley/clever/v3.1`);
    const users = await cleverList(clientFetch("192.0.2.30"), clever.baseUrl, clever.districtToken, "/v3.1/users?limit=4");
    const local = new CleverDataFake({ seed: seedOf("cedarvalley") });
    const all = (await (await local.fetch("https://api.clever.com/v3.1/users?limit=10000", { headers: { authorization: `Bearer ${local.districtToken}` } })).json()) as { data: unknown[] };
    expect(users).toHaveLength(all.data.length);
    expect(new Set(users.map((u) => u.data.id)).size).toBe(users.length);
  });

  it("refuses the token the public seed derives", async () => {
    const answer = await call("/cedarvalley/clever/v3.1/users", { ip: "192.0.2.31", headers: { authorization: `Bearer ${tokenId("clever:district-token", "cedarvalley", 40)}` } });
    expect(answer.status).toBe(401);
  });

  it("gives each caller its own rate-limit budget", async () => {
    const { clever } = await credentials("cedarvalley");
    const as = (ip: string) => call("/cedarvalley/clever/v3.1/schools", { ip, headers: { authorization: `Bearer ${clever.districtToken}` } });
    await as("192.0.2.32");
    const second = await as("192.0.2.32");
    const other = await as("192.0.2.33");
    expect(Number(other.headers.get("x-ratelimit-remaining"))).toBe(Number(second.headers.get("x-ratelimit-remaining")) + 1);
  });

  it("signs a person in through Clever SSO on the same base, and the id_token verifies against the served JWKS", async () => {
    const { clever } = await credentials("cedarvalley");
    const { oidc } = clever;
    const ip = { ip: "192.0.2.34" };
    const person = seedOf("cedarvalley").people.find((p) => p.role === "teacher")!;
    const authorize = new URL(oidc.authorizationEndpoint);
    for (const [k, v] of Object.entries({ client_id: oidc.clientId, redirect_uri: oidc.redirectUris[0], response_type: "code", scope: "openid", state: "s", login_hint: person.id })) {
      authorize.searchParams.set(k, v as string);
    }
    expect(oidc.redirectUris).toEqual(["https://cedarvalley.district.example/auth/callback"]);
    const redirect = await call(authorize, ip);
    expect(redirect.status).toBe(302);
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    const exchange = await call(oidc.tokenEndpoint, {
      ...ip,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${oidc.clientId}:${oidc.clientSecret}`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: oidc.redirectUris[0] }).toString(),
    });
    expect(exchange.status).toBe(200);
    const { id_token: idToken, access_token: accessToken } = exchange.json<{ id_token: string; access_token: string }>();
    const jwks = (await call(oidc.jwksUri, ip)).json<JSONWebKeySet>();
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: oidc.issuer, audience: oidc.clientId });
    expect(payload.sub).toBe(person.vendorIds?.clever);
    const userinfo = await call(oidc.userinfoEndpoint, { ...ip, headers: { authorization: `Bearer ${accessToken}` } });
    expect(userinfo.status).toBe(200);
    expect(oidc.userinfoEndpoint).toBe(`${ORIGIN}/cedarvalley/clever/userinfo`);
  });
});

describe("Google sign-in and Classroom", () => {
  it("lets a Google sign-in token with Classroom scopes read Classroom", async () => {
    const { google } = await credentials("harbor");
    const { oidc } = google;
    const ip = { ip: "192.0.2.40" };
    const teacher = seedOf("harbor").people.find((p) => p.role === "teacher")!;
    const authorize = new URL(oidc.authorizationEndpoint);
    const scope = `openid email ${CLASSROOM_SCOPES.coursesReadonly}`;
    for (const [k, v] of Object.entries({ client_id: oidc.clientId, redirect_uri: oidc.redirectUris[0], response_type: "code", scope, login_hint: teacher.email })) {
      authorize.searchParams.set(k, v as string);
    }
    const code = new URL((await call(authorize, ip)).headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    const exchange = await call(oidc.tokenEndpoint, {
      ...ip,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code!, redirect_uri: oidc.redirectUris[0], client_id: oidc.clientId, client_secret: oidc.clientSecret }).toString(),
    });
    const token = exchange.json<{ access_token: string }>().access_token;
    const courses = await call(`${ORIGIN}/harbor/classroom/v1/courses?teacherId=me`, { ...ip, headers: { authorization: `Bearer ${token}` } });
    expect(courses.status).toBe(200);
    expect(courses.json<{ courses?: unknown[] }>().courses?.length).toBeGreaterThan(0);
  });
});

describe("public limits", () => {
  it("rate-limits each address per district, with Retry-After", async () => {
    let last = await call("/riverbend/oneroster/ims/oneroster/rostering/v1p2/orgs", { ip: "192.0.2.50" });
    for (let i = 1; i < 61; i++) last = await call("/riverbend/oneroster/ims/oneroster/rostering/v1p2/orgs", { ip: "192.0.2.50" });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("/riverbend/oneroster/ims/oneroster/rostering/v1p2/orgs", { ip: "192.0.2.51" })).status).toBe(401);
    // Another district's object keeps its own count.
    expect((await call("/lakeshore/oneroster/ims/oneroster/rostering/v1p2/orgs", { ip: "192.0.2.50" })).status).toBe(401);
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const declared = await call("/riverbend/oneroster/token", { method: "POST", ip: "192.0.2.52", headers: { "content-type": "application/x-www-form-urlencoded" }, body: big });
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new TextEncoder().encode("y".repeat(MAX_BODY_BYTES / 2)));
        controller.close();
      },
    });
    const streamed = await call("/riverbend/oneroster/token", { method: "POST", ip: "192.0.2.52", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect((await admin("riverbend/faults", { method: "POST", body: big })).status).toBe(413);
  });
});
