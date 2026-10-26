// SCHO-204: Lakeshore end to end, in process, against the ClassLink fakes. The district's roster
// syncs from its ClassLink Roster Server through the OAuth 2.0 profile, its people sign in through
// ClassLink and resolve through `(district, issuer, subject)` to the principals the roster created,
// and a ClassLink outage leaves the last good directory in place while health reports it.
//
// This is evidence against our fakes of ClassLink, not against ClassLink: no ClassLink sandbox
// exists yet (SCHO-211).
import { DistrictDirectorySnapshot, EducateOsError, checkDirectoryIntegrity, externalIdentityKey, type ClassLinkSsoInput, type VerifiedIdentity } from "@educateos/contracts";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { OidcFake, classlinkTenantId, routeFetch } from "@educateos/provider-fakes";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { classlink, integrationHealth, oneroster } from "../src/index.ts";
import { OTHER_APP, ROSTER_CLIENT, ROSTER_SERVER, SSO_CLIENT, START, lakeshoreClassLink } from "./fixtures/lakeshore-classlink.ts";

const SCHEDULE = { deltaEveryMinutes: 30, completeEveryHours: 24 };

function setup() {
  const world = lakeshoreClassLink();
  const { demo, clock, fetch, tenantId } = world;
  const issuer = demo.directory.district.trustedIssuers[0]!;
  const connection = { tenantId, serverUrl: ROSTER_SERVER };
  const sso: ClassLinkSsoInput = { tenantId, issuer, clientId: SSO_CLIENT.clientId, subjectClaim: "preferred_username" };
  const env = { [classlink.CLASSLINK_SECRET_NAMES.rosterClientId]: ROSTER_CLIENT.clientId, [classlink.CLASSLINK_SECRET_NAMES.rosterClientSecret]: ROSTER_CLIENT.clientSecret, [classlink.CLASSLINK_SECRET_NAMES.ssoClientSecret]: SSO_CLIENT.clientSecret };
  const sleeps: number[] = [];
  const source = classlink.classLinkRosterSource({
    connection,
    credentials: classlink.classLinkRosterCredentials(env),
    fetch,
    pageSize: 5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clock: () => clock.ms,
  });
  const store = new oneroster.InMemoryRosterSyncStore();
  const empty = (): oneroster.RosterSyncState => ({
    roster: {
      snapshot: DistrictDirectorySnapshot.parse({ district: demo.directory.district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
      sources: oneroster.EMPTY_SOURCE_MAP,
    },
  });
  let run = 0;
  const sync = (mode: "complete" | "delta", extra: { approvedRemoval?: string } = {}) =>
    oneroster.runStoredRosterSync({
      ...extra,
      store,
      initial: empty,
      source,
      mode,
      config: { issuer, subject: { field: "username" } },
      runId: `run-${++run}`,
      clock: () => new Date(clock.ms),
    });
  return { ...world, issuer, sso, env, sleeps, source, store, sync };
}

type World = ReturnType<typeof setup>;

async function pkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { verifier, challenge };
}

/** A whole ClassLink sign-in as the person `loginHint` names, through the fake's authorize endpoint. */
async function signIn(world: World, loginHint: string, overrides: Partial<classlink.ClassLinkSignInOptions> & { scopes?: string[] } = {}): Promise<VerifiedIdentity> {
  const { verifier, challenge } = await pkce();
  const nonce = crypto.randomUUID();
  const redirectUri = SSO_CLIENT.redirectUris[0];
  const sso = { ...world.sso, ...(overrides.scopes === undefined ? {} : { scopes: overrides.scopes }) };
  const start = classlink.classLinkAuthorizationUrl(sso, { redirectUri, state: "st-1", nonce, codeChallenge: challenge, loginHint });
  const back = await world.fetch(start, { redirect: "manual" });
  expect(back.status).toBe(302);
  const code = new URL(back.headers.get("location")!).searchParams.get("code");
  if (code === null) throw new Error(`no code: ${back.headers.get("location")}`);
  return classlink.classLinkSignIn({
    sso,
    clientSecret: classlink.classLinkSsoClientSecret(world.env),
    code,
    redirectUri,
    codeVerifier: verifier,
    nonce,
    fetch: world.fetch,
    keys: overrides.keys ?? (await localKeys(world)),
    clock: () => world.clock.ms,
    ...overrides,
  });
}

async function localKeys(world: World) {
  return createLocalJWKSet((await (await world.fetch("https://launchpad.classlink.com/oauth2/v2/jwks")).json()) as JSONWebKeySet);
}

/** An id_token ClassLink issued to another app, by that app's own code flow. */
async function otherAppIdToken(world: World, loginHint: string): Promise<string> {
  const authorize = new URL("https://launchpad.classlink.com/oauth2/v2/auth");
  for (const [k, v] of Object.entries({ response_type: "code", client_id: OTHER_APP.clientId, redirect_uri: OTHER_APP.redirectUris[0], scope: "openid profile", state: "s", nonce: "n-other", login_hint: loginHint })) {
    authorize.searchParams.set(k, v);
  }
  const code = new URL((await world.fetch(authorize, { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
  const response = await world.fetch("https://launchpad.classlink.com/oauth2/v2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${OTHER_APP.clientId}:${OTHER_APP.clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: OTHER_APP.redirectUris[0] }),
  });
  return ((await response.json()) as { id_token: string }).id_token;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(EducateOsError);
  return (error as EducateOsError).code;
}

describe("Lakeshore on ClassLink", () => {
  it("syncs its roster from the ClassLink Roster Server into the directory it was derived from", async () => {
    const world = setup();
    const result = await world.sync("complete");
    expect(result.run.outcome, JSON.stringify(result.preview?.issues)).toBe("succeeded");
    const imported = result.state.roster.snapshot;
    expect(checkDirectoryIntegrity(imported)).toEqual([]);
    const people = (s: DistrictDirectorySnapshot) =>
      s.principals.filter((p) => p.kind !== "guardian").map((p) => `${externalIdentityKey(p.externalIdentities[0]!)}|${p.kind}|${p.displayName}|${p.status}`).toSorted();
    expect(people(imported)).toEqual(people(world.demo.directory));
    // One token for the whole sync, requested at ClassLink's `/token` with HTTP Basic and the core scope.
    expect(world.roster.tokens.issued).toBe(1);
    const token = world.roster.requests.find((r) => r.method === "POST")!;
    expect(token.url.href).toBe(`${ROSTER_SERVER}/token`);
    expect(token.headers.get("authorization")).toMatch(/^Basic /);
    expect(new URLSearchParams(token.body).get("scope")).toBe(oneroster.ROSTER_CORE_READONLY_SCOPE);
  });

  it("signs people in through ClassLink as the principals the roster created", async () => {
    const world = setup();
    const { state } = await world.sync("complete");
    const resolver = createDirectoryPrincipalResolver(state.roster.snapshot);
    for (const id of ["prn_ls-student-ava", "prn_ls-teacher-raman", "prn_ls-district-admin"]) {
      const expected = world.demo.directory.principals.find((p) => p.id === id)!;
      const identity = await signIn(world, id);
      expect(identity).toEqual({ issuer: world.issuer, subject: expected.externalIdentities[0]!.subject, credential: "person" });
      const resolved = await resolver.resolve(identity);
      const principal = state.roster.snapshot.principals.find((p) => p.id === resolved.principalId)!;
      expect(principal.displayName).toBe(expected.displayName);
      expect(resolved.kind).toBe(expected.kind);
    }
  });

  it("refuses a sign-in from another ClassLink tenant, whatever its subject", async () => {
    const world = setup();
    const otherTenant = { ...world.sso, tenantId: "9999" };
    expect(await refusal(signIn({ ...world, sso: otherTenant }, "prn_ls-student-ava"))).toBe("unauthenticated");
  });

  it("refuses a token for another app, with the wrong nonce, expired, or without the subject claim", async () => {
    const world = setup();
    const foreign = await otherAppIdToken(world, "prn_ls-student-ava");
    const verify = async (sso: ClassLinkSsoInput) =>
      classlink.verifyClassLinkIdToken(foreign, { sso, keys: await localKeys(world), nonce: "n-other", clock: () => world.clock.ms });
    expect(await refusal(verify(world.sso))).toBe("unauthenticated");
    // The same token passes for the app it was issued to: the audience alone refused it.
    expect((await verify({ ...world.sso, clientId: OTHER_APP.clientId })).aud).toBe(OTHER_APP.clientId);
    expect(await refusal(signIn(world, "prn_ls-student-ava", { nonce: "replayed" }))).toBe("unauthenticated");
    // The id_token lives an hour; verified two hours on, past the minute of leeway.
    expect(await refusal(signIn(world, "prn_ls-student-ava", { clock: () => world.clock.ms + 2 * 3_600_000 }))).toBe("unauthenticated");
    // Without `profile` ClassLink sends no `preferred_username`: there is no subject to resolve.
    expect(await refusal(signIn(world, "prn_ls-student-ava", { scopes: ["openid"] }))).toBe("unauthenticated");
  });

  it("reports a wrong client secret as misconfigured, which no retry by the person fixes", async () => {
    const world = setup();
    const error = await signIn(world, "prn_ls-student-ava", { clientSecret: "SYNTHETIC-STALE-SECRET-0000" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unavailable", message: expect.stringContaining("misconfigured") });
    expect(String((error as Error).message)).not.toContain("SYNTHETIC");
    // RFC 6749 also allows a 400 `invalid_client`: the same fault, the same answer.
    const invalidClient: typeof fetch = async (input, init) =>
      init?.method === "POST" ? Response.json({ error: "invalid_client" }, { status: 400 }) : world.fetch(input, init);
    expect(await signIn({ ...world, fetch: invalidClient }, "prn_ls-student-ava").catch((e: unknown) => e)).toMatchObject({ code: "unavailable", message: expect.stringContaining("misconfigured") });
    const invalidGrant: typeof fetch = async (input, init) =>
      init?.method === "POST" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : world.fetch(input, init);
    expect(await refusal(signIn({ ...world, fetch: invalidGrant }, "prn_ls-student-ava"))).toBe("unauthenticated");
  });

  it("refuses another tenant's person with the same login ID on ClassLink's shared issuer", async () => {
    // Real ClassLink tokens all carry iss https://launchpad.classlink.com, and each tenant picks its own
    // login IDs, so two districts can both have a `ls-s-4001`. Only the tenant claim tells them apart.
    const world = setup();
    const shared = (seed: typeof world.seed) => {
      const idp = new OidcFake({ seed, preset: "classlink", clients: [SSO_CLIENT], now: () => world.clock.ms });
      return { idp, fetch: routeFetch(Object.fromEntries(idp.origins.map((origin) => [origin, idp]))) };
    };
    const lakeshore = shared(world.seed);
    const elsewhere = shared({ ...world.seed, id: "harborview", name: "Harborview Schools (synthetic)" });
    expect(classlinkTenantId({ id: "harborview" })).not.toBe(world.tenantId);
    const sso: ClassLinkSsoInput = { tenantId: world.tenantId, clientId: SSO_CLIENT.clientId, subjectClaim: "preferred_username" };

    const ours = await signIn({ ...world, ...lakeshore, sso }, "prn_ls-student-ava");
    expect(ours).toEqual({ issuer: "https://launchpad.classlink.com", subject: "ls-s-4001", credential: "person" });
    const error = await signIn({ ...world, ...elsewhere, sso }, "prn_ls-student-ava").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unauthenticated", message: "This ClassLink account belongs to another organization." });
  });

  it("redeems the code with client_secret_post when the app is set up that way", async () => {
    const world = setup();
    world.sso = { ...world.sso, clientAuthentication: "client_secret_post" };
    await signIn(world, "prn_ls-student-ava");
    const redeem = world.idp.requests.findLast((r) => r.method === "POST")!;
    expect(redeem.headers.get("authorization")).toBeNull();
    expect(new URLSearchParams(redeem.body).get("client_id")).toBe(SSO_CLIENT.clientId);
  });

  it("reports ClassLink being down as unavailable, not as a refused sign-in", async () => {
    const world = setup();
    world.idp.inject({ kind: "outage", match: { method: "POST" } });
    expect(await refusal(signIn(world, "prn_ls-student-ava"))).toBe("unavailable");
    world.idp.clearFaults();
    world.idp.inject({ kind: "network-error", match: { method: "POST" } });
    expect(await refusal(signIn(world, "prn_ls-student-ava"))).toBe("unavailable");
    world.idp.clearFaults();
    // An unreachable key set, through the remote key set the Worker uses.
    const keys = classlink.classLinkKeys(world.sso, world.fetch);
    world.idp.inject({ kind: "outage", match: { method: "GET", path: "/jwks" } });
    expect(await refusal(signIn(world, "prn_ls-student-ava", { keys }))).toBe("unavailable");
    world.idp.clearFaults();
    expect((await signIn(world, "prn_ls-student-ava", { keys })).credential).toBe("person");
  });

  it("keeps the last good directory through a Roster Server outage, and health says so", async () => {
    const world = setup();
    const first = await world.sync("complete");
    const resolver = createDirectoryPrincipalResolver(first.state.roster.snapshot);
    const loaded = await world.store.load();

    world.clock.ms = START + 45 * 60_000;
    world.roster.inject({ kind: "outage" });
    const failed = await world.sync("delta");
    expect(failed.run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
    // Nothing applied: the stored directory and its version are the last good sync's.
    expect(await world.store.load()).toEqual(loaded);
    expect(integrationHealth(await world.store.runs(), { maxStalenessMinutes: 120 }, new Date(world.clock.ms))).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
      lastErrorCode: "source-unavailable",
    });
    // A failing source is retried on the delta interval, not continuously.
    expect(oneroster.dueRosterSync(SCHEDULE, await world.store.runs(), world.source.modes, new Date(world.clock.ms + 60_000))).toBeUndefined();
    // Sign-in is a separate service, and still resolves against the last good directory.
    expect((await resolver.resolve(await signIn(world, "prn_ls-student-ben"))).kind).toBe("student");

    world.roster.clearFaults();
    world.clock.ms += 31 * 60_000;
    expect(oneroster.dueRosterSync(SCHEDULE, await world.store.runs(), world.source.modes, new Date(world.clock.ms))).toBe("delta");
    expect((await world.sync("delta")).run.outcome).toBe("succeeded");
    expect(integrationHealth(await world.store.runs(), { maxStalenessMinutes: 120 }, new Date(world.clock.ms)).status).toBe("healthy");
  });

  it("holds a truncated ClassLink export for an administrator, and applies it once that removal is approved", async () => {
    const world = setup();
    await world.sync("complete");
    const before = await world.store.load();
    world.clock.ms = START + 3_600_000;
    world.roster.inject({ kind: "large-removal", fraction: 0.8 });
    const held = await world.sync("delta");
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held" });
    expect(await world.store.load()).toEqual(before);
    const approved = await world.sync("delta", { approvedRemoval: held.held!.fingerprint });
    expect(approved.run.outcome).toBe("succeeded");
    expect(approved.run.counts.principals.deactivated).toBeGreaterThanOrEqual(3);
  });

  it("applies a ClassLink delta: an update, and a student removed", async () => {
    const world = setup();
    await world.sync("complete");
    world.clock.ms = START + 3_600_000;
    world.roster.upsert("users", { ...world.roster.record("users", "prn_ls-student-eli"), givenName: "Elias" });
    world.roster.remove("users", "prn_ls-student-fatima");
    const { run, state } = await world.sync("delta");
    expect(run).toMatchObject({ outcome: "succeeded", mode: "delta" });
    expect(run.counts.principals).toEqual({ added: 0, updated: 1, deactivated: 1 });
    const byName = (name: string) => state.roster.snapshot.principals.find((p) => p.displayName === name);
    expect(byName("Elias Stern")?.status).toBe("active");
    expect(byName("Fatima Zahra")?.status).toBe("inactive");
  });
});
