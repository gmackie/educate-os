import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { InMemoryAcademicStore, AcademicDirectory } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { authorityFor } from "@educateos/district-app";
import { DistrictId, PrincipalId, type PolicySettings, type VerifiedPrincipal } from "@educateos/contracts";
import {
  Delegations,
  directoryPolicyInformation,
  InMemoryDelegationStore,
  InMemoryPolicyAuditSink,
  InMemoryToolApprovalStore,
  PolicyEngine,
  SchoolToolRunner,
  type DelegationCeiling,
} from "@educateos/policy";
import { externalSchoolTools } from "../src/registry.ts";
import { DelegatedResourceAuthority } from "../src/resource-auth.ts";

const RESOURCE = "https://school.example/mcp";
const ISSUER = NORTHFIELD.district.trustedIssuers[0]!;
const CLIENT = { issuer: ISSUER, clientId: "https://planner.example/client.json" };
const BIO = "off_nf-bio-fall-p2";
const MORGAN = { districtId: DistrictId.parse("dst_northfield"), principalId: PrincipalId.parse("prn_nf-morgan-lee") };
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};
const offering = NORTHFIELD.offerings.find((o) => o.id === BIO)!;
/** Morgan's Biology P2 roster and the offering itself, read-only. */
const CEILING: DelegationCeiling = {
  scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
  actions: ["read", "list", "invoke-tool"],
  kinds: ["offering", "enrollment"],
  classifications: ["course", "district-internal"],
};
const subjectOf = (principalId: string) =>
  NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities.find((i) => i.issuer === ISSUER)!.subject;

/** A fake authorization server (standing in for Nathan, NATH-6) and the district it issues tokens for. */
async function world() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const rogue = await generateKeyPair("ES256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] });
  const clock = { now: new Date("2026-10-31T09:00:00Z") };
  const now = () => clock.now;
  const store = InMemoryAcademicStore.seeded(structuredClone(NORTHFIELD));
  const delegationStore = new InMemoryDelegationStore();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(store, { effectivePolicy: async () => FLOOR }, { delegations: delegationStore, now }),
    audit: new InMemoryPolicyAuditSink(),
    now,
  });
  const delegations = new Delegations({ store: delegationStore, policy: engine, now });
  const issue = (overrides: object = {}, who: VerifiedPrincipal = MORGAN) =>
    delegations.issue({ principal: who, channel: "http" }, { client: CLIENT, ceiling: CEILING, durationHours: 24, ...overrides });
  const authority = new DelegatedResourceAuthority({
    resource: RESOURCE,
    issuer: { issuer: ISSUER, keys: jwks, algorithms: ["ES256"] },
    requiredScopes: ["mcp:tools"],
    resolver: async () => createDirectoryPrincipalResolver((await store.load()).snapshot),
    delegations: delegationStore,
    now: () => clock.now.getTime(),
  });
  const directory = new AcademicDirectory({ store, authority: authorityFor("local"), authorizer: engine });
  const runner = new SchoolToolRunner({ engine, tools: externalSchoolTools(store, directory), approvals: { store: new InMemoryToolApprovalStore() } });

  /** An access token as the issuer would mint it, with `claims` and `header` overriding the defaults. */
  async function token(claims: JWTPayload = {}, header: Record<string, unknown> = {}, key = privateKey) {
    const iat = Math.floor(clock.now.getTime() / 1000);
    return new SignJWT({
      iss: ISSUER, sub: subjectOf(MORGAN.principalId), aud: RESOURCE, iat, exp: iat + 300,
      client_id: CLIENT.clientId, scope: "openid mcp:tools", jti: crypto.randomUUID(), ...claims,
    }).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1", ...header }).sign(key);
  }
  async function editDirectory(edit: (snapshot: typeof NORTHFIELD) => void) {
    const { snapshot, version } = await store.load();
    const next = structuredClone(snapshot);
    edit(next);
    await store.commit(next, version);
  }
  const refusal = (bearer: Promise<string>) => bearer.then((t) => authority.authenticate(t)).then(() => "accepted", (e: { code?: string }) => e.code);
  return { clock, authority, runner, delegations, issue, token, rogue, editDirectory, refusal };
}

describe("the district /mcp as a protected resource (SCHO-174)", () => {
  it("resolves a token to its principal and the one delegation it acts under, from district records alone", async () => {
    const w = await world();
    const delegation = await w.issue();
    expect(await w.authority.authenticate(await w.token({ roles: ["district-admin"], principal_id: "prn_nf-admin" })))
      .toEqual({ ...MORGAN, delegationId: delegation.id });
  });

  it("refuses wrong audiences, issuers, keys, types, algorithms, lifetimes and scopes as unauthenticated", async () => {
    const w = await world();
    await w.issue();
    const iat = Math.floor(w.clock.now.getTime() / 1000);
    const cases = {
      "wrong aud": w.token({ aud: "https://school.example/other" }),
      "another district's mcp": w.token({ aud: "https://riverbend.example/mcp" }),
      "several audiences": w.token({ aud: [RESOURCE, "https://other.example/mcp"] }),
      "wrong iss": w.token({ iss: "https://evil.example" }),
      "untrusted key": w.token({}, {}, w.rogue.privateKey),
      "key URL in header": w.token({}, { jku: "https://evil.example/jwks", kid: "evil" }, w.rogue.privateKey),
      "id token type": w.token({}, { typ: "JWT" }),
      expired: w.token({ iat: iat - 600, exp: iat - 1 }),
      "not yet valid": w.token({ nbf: iat + 60 }),
      "issued in the future": w.token({ iat: iat + 60, exp: iat + 120 }),
      "too long-lived": w.token({ exp: iat + 3600 }),
      "missing scope": w.token({ scope: "openid" }),
      "missing client_id": w.token({ client_id: undefined }),
      "unlinked subject": w.token({ sub: "nobody" }),
    };
    for (const [name, bearer] of Object.entries(cases)) expect([name, await w.refusal(bearer)]).toEqual([name, "unauthenticated"]);
  });

  it("refuses a client the person has not delegated to, or another person's delegation, as forbidden", async () => {
    const w = await world();
    expect(await w.refusal(w.token())).toBe("forbidden");
    await w.issue({ client: { issuer: CLIENT.issuer, clientId: "https://other.example/client.json" } });
    expect(await w.refusal(w.token())).toBe("forbidden");
    // Another teacher's delegation to this client lends Morgan nothing.
    const rivera = NORTHFIELD.principals.find((p) => p.id === "prn_nf-teacher-rivera")!;
    const riveraOffering = NORTHFIELD.offerings.find((o) => o.id === "off_nf-eng9-fall-p3")!;
    await w.issue({ ceiling: { ...CEILING, scope: { level: "offering", districtId: riveraOffering.districtId, schoolId: riveraOffering.schoolId, offeringId: riveraOffering.id } } },
      { districtId: MORGAN.districtId, principalId: rivera.id });
    expect(await w.refusal(w.token())).toBe("forbidden");
    // Two in force to the same client leave the bound ambiguous: neither applies until one is revoked.
    const first = await w.issue();
    const second = await w.issue();
    expect(await w.refusal(w.token())).toBe("forbidden");
    await w.delegations.revoke({ principal: MORGAN, channel: "http" }, first.id);
    expect(await w.authority.authenticate(await w.token())).toMatchObject({ delegationId: second.id });
  });

  it("stops the next call, with the same unexpired token, when the delegation is revoked or lapses", async () => {
    const w = await world();
    const delegation = await w.issue({ durationHours: 1 });
    const bearer = await w.token();
    await w.authority.authenticate(bearer);
    await w.delegations.revoke({ principal: MORGAN, channel: "http" }, delegation.id);
    expect(await w.refusal(Promise.resolve(bearer))).toBe("forbidden");

    await w.issue({ durationHours: 1 });
    w.clock.now = new Date(w.clock.now.getTime() + 3_600_000);
    expect(await w.refusal(w.token())).toBe("forbidden");
  });

  it("stops the next call when the teacher is deactivated or their identity link removed", async () => {
    const w = await world();
    await w.issue();
    const bearer = await w.token();
    await w.authority.authenticate(bearer);
    await w.editDirectory((s) => { s.principals.find((p) => p.id === MORGAN.principalId)!.status = "inactive"; });
    expect(await w.refusal(Promise.resolve(bearer))).toBe("unauthenticated");
    await w.editDirectory((s) => {
      const morgan = s.principals.find((p) => p.id === MORGAN.principalId)!;
      morgan.status = "active";
      morgan.externalIdentities = [];
    });
    expect(await w.refusal(Promise.resolve(bearer))).toBe("unauthenticated");
  });

  it("bounds each tool call by the delegation's ceiling and the teacher's live roster standing", async () => {
    const w = await world();
    await w.issue();
    const agent = await w.authority.authenticate(await w.token());
    // A refused read looks exactly like a missing record, so it reveals nothing.
    const refused = { status: "error", error: { code: "not-found" } };
    const call = (name: string, args: object) => w.runner.invoke({ principal: agent, channel: "mcp-tool" }, name, args, { confirmWrites: true });
    // Inside the ceiling: Morgan's own Biology P2 offering and roster.
    expect(await call("get_offering", { offeringId: BIO })).toMatchObject({ status: "ok" });
    expect(await call("get_roster", { offeringId: BIO })).toMatchObject({ status: "ok" });
    // Outside it, though Morgan herself may read them: the district's course catalog and school list.
    expect(await call("list_schools", {})).toMatchObject(refused);
    expect(await call("get_offering", { offeringId: "off_nf-bio-spring-p4" })).toMatchObject(refused);
    // Dropped from the class by the roster: the same subject is refused on its next call.
    await w.editDirectory((s) => {
      s.roleAssignments = s.roleAssignments.filter((g) => !(g.principalId === MORGAN.principalId && g.scope.level === "offering" && g.scope.offeringId === BIO));
      s.enrollments = s.enrollments.filter((e) => !(e.principalId === MORGAN.principalId && e.offeringId === BIO));
    });
    expect(await call("get_offering", { offeringId: BIO })).toMatchObject(refused);
  });

  it("requires an https /mcp resource and asymmetric algorithms", () => {
    const base = { issuer: { issuer: ISSUER, keys: createLocalJWKSet({ keys: [] }), algorithms: ["ES256"] }, requiredScopes: ["mcp:tools"],
      resolver: async () => createDirectoryPrincipalResolver(NORTHFIELD), delegations: new InMemoryDelegationStore() };
    expect(() => new DelegatedResourceAuthority({ ...base, resource: "http://school.example/mcp" })).toThrow();
    expect(() => new DelegatedResourceAuthority({ ...base, resource: "https://school.example/" })).toThrow();
    expect(() => new DelegatedResourceAuthority({ ...base, resource: RESOURCE, issuer: { ...base.issuer, algorithms: ["HS256"] } })).toThrow();
    expect(() => new DelegatedResourceAuthority({ ...base, resource: RESOURCE, requiredScopes: [] })).toThrow();
  });
});
