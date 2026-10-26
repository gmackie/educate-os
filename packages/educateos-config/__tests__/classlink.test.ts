// ClassLink tenant and app configuration lives in configuration revisions (SCHO-204). Its client
// IDs and secrets are Worker secrets: a revision holding one is refused.
import { PrincipalId } from "@educateos/contracts";
import { LAKESHORE } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { SHIPPED_REGISTRY, compileDistrictConfig, createDraftRevision, findSecrets, planConfigurationChange } from "../src/index.ts";
import { northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_ls-district-admin");
const ISSUER = LAKESHORE.district.trustedIssuers[0]!;

function lakeshoreDocument(issuer = ISSUER) {
  const document = northfieldDocument();
  document.district = "dst_lakeshore";
  document.rollout = { target: "all-active-offerings", requiresAdminActivation: true };
  document.identity = { provider: "district-sso", classlink: { tenantId: "4417", issuer, clientId: "c1234567890", subjectClaim: "preferred_username" } };
  document.rostering = {
    provider: "oneroster-api",
    mode: "preview-before-apply",
    identityMapping: { issuer: ISSUER, subject: { field: "username" } },
    schedule: { deltaEveryMinutes: 30, completeEveryHours: 24 },
    classlink: { tenantId: "4417", serverUrl: "https://lakeshore-vn-v2.rosterserver.example" },
  };
  return document;
}

describe("ClassLink in a configuration revision", () => {
  it("stores the tenant, Roster Server and sign-in app, with ClassLink's defaults filled in", async () => {
    const draft = await createDraftRevision({ document: lakeshoreDocument(), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    const { identity, rostering } = draft.compiled.desired;
    expect(rostering.classlink).toEqual({
      tenantId: "4417",
      serverUrl: "https://lakeshore-vn-v2.rosterserver.example",
      tokenPath: "/token",
      scopes: ["https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly"],
      clientAuthentication: "client_secret_basic",
    });
    expect(identity.classlink).toMatchObject({
      tenantId: "4417",
      issuer: ISSUER,
      clientId: "c1234567890",
      subjectClaim: "preferred_username",
      tenantClaim: "classLink_tenant_id",
      endpoints: { tokenEndpoint: "https://launchpad.classlink.com/oauth2/v2/token" },
    });
    expect(planConfigurationChange({ next: draft.revision, directory: LAKESHORE, registry: SHIPPED_REGISTRY }).problems).toEqual([]);
  });

  it("compiles again from its own desired state, as the admin console resubmits it, with explicit endpoints too", () => {
    const document = lakeshoreDocument();
    document.identity.classlink.endpoints = {
      authorizationEndpoint: "https://launchpad.classlink.com/oauth2/v2/auth",
      tokenEndpoint: "https://launchpad.classlink.com/oauth2/v2/token",
      jwksUri: "https://launchpad.classlink.com/oauth2/v2/jwks",
    };
    const first = compileDistrictConfig(document, SHIPPED_REGISTRY);
    if (!first.ok) throw new Error(JSON.stringify(first.problems));
    const { identity, rostering } = first.compiled.desired;
    expect(findSecrets({ identity, rostering })).toEqual([]);
    const again = compileDistrictConfig({ ...lakeshoreDocument(), identity, rostering }, SHIPPED_REGISTRY);
    if (!again.ok) throw new Error(JSON.stringify(again.problems));
    expect(again.compiled.desired).toEqual(first.compiled.desired);
  });

  it("blocks sign-in and roster that disagree on issuer, subject or tenant", async () => {
    const document = lakeshoreDocument();
    document.identity.classlink.issuer = "https://launchpad.classlink.com";
    document.identity.classlink.tenantId = "5000";
    document.rostering.identityMapping.subject = { field: "identifier" };
    const draft = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    const problems = planConfigurationChange({ next: draft.revision, directory: LAKESHORE, registry: SHIPPED_REGISTRY }).problems;
    expect(problems.filter((p) => p.code === "classlink-mismatch").map((p) => p.path)).toEqual([
      "/rostering/identityMapping/issuer",
      "/rostering/identityMapping/subject",
      "/rostering/classlink/tenantId",
    ]);
  });

  it("checks sign-in against the roster only when ClassLink serves both, using the default mapping when none is given", async () => {
    const plan = async (document: ReturnType<typeof lakeshoreDocument>) => {
      const draft = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
      if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
      return planConfigurationChange({ next: draft.revision, directory: LAKESHORE, registry: SHIPPED_REGISTRY }).problems.filter((p) => p.code === "classlink-mismatch");
    };
    // A CSV roster under its SIS's own issuer, linked to ClassLink sign-ins another way.
    const csv = lakeshoreDocument();
    csv.rostering = { provider: "oneroster-csv", mode: "preview-before-apply", identityMapping: { issuer: ISSUER, subject: { field: "identifier" } } };
    expect(await plan(csv)).toEqual([]);
    // No mapping: the sync uses the first trusted issuer with usernames, which the sign-in matches.
    const implicit = lakeshoreDocument();
    delete implicit.rostering.identityMapping;
    expect(await plan(implicit)).toEqual([]);
    implicit.identity.classlink.subjectClaim = "sub";
    implicit.identity.classlink.issuer = "https://launchpad.classlink.com";
    expect((await plan(implicit)).map((p) => p.path)).toEqual(["/rostering/identityMapping/issuer"]);
  });

  it("blocks a sign-in issuer the district does not trust", async () => {
    const draft = await createDraftRevision({ document: lakeshoreDocument("https://launchpad.classlink.com"), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    const problems = planConfigurationChange({ next: draft.revision, directory: LAKESHORE, registry: SHIPPED_REGISTRY }).problems;
    expect(problems.filter((p) => p.code !== "classlink-mismatch")).toEqual([{
      code: "untrusted-sso-issuer",
      path: "/identity/classlink/issuer",
      message: "the sign-in issuer https://launchpad.classlink.com is not one of the district's trusted issuers",
    }]);
  });

  it("refuses a client secret in configuration, by name and by shape", () => {
    const named = lakeshoreDocument();
    named.rostering.classlink.clientSecret = "";
    const result = compileDistrictConfig(named, SHIPPED_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContainEqual(expect.objectContaining({ code: "secret-in-config", path: "/rostering/classlink/clientSecret" }));

    const pasted = lakeshoreDocument();
    pasted.identity.classlink.clientId = "Zx9Qp2Lm7Rt4Vb8Nc3Kd6Fg1Hj5Ws0Ty";
    const shaped = compileDistrictConfig(pasted, SHIPPED_REGISTRY);
    expect(shaped.ok).toBe(false);
    if (!shaped.ok) expect(JSON.stringify(shaped.problems)).not.toContain("Zx9Qp2Lm7Rt4Vb8Nc3Kd6Fg1Hj5Ws0Ty");
  });

  it("refuses ClassLink settings for a provider they do not belong to, and an email subject", () => {
    const csv = lakeshoreDocument();
    csv.rostering.provider = "oneroster-csv";
    const access = lakeshoreDocument();
    access.identity.provider = "cloudflare-access";
    const email = lakeshoreDocument();
    email.identity.classlink.subjectClaim = "email";
    for (const [document, path] of [[csv, "/rostering/classlink"], [access, "/identity/classlink"], [email, "/identity/classlink/subjectClaim"]] as const) {
      const result = compileDistrictConfig(document, SHIPPED_REGISTRY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.map((p) => p.path)).toContain(path);
    }
  });
});
