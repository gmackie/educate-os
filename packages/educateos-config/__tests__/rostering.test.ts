// The OneRoster import configuration lives in configuration revisions (SCHO-53).
import { PrincipalId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { SHIPPED_REGISTRY, compileDistrictConfig, createDraftRevision, planConfigurationChange } from "../src/index.ts";
import { northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_nf-district-admin");

function withMapping(issuer: string) {
  const document = northfieldDocument();
  document.rostering = {
    provider: "oneroster-api",
    mode: "apply-automatically",
    identityMapping: { issuer, subject: { field: "userIds", type: "idp" } },
    schedule: { deltaEveryMinutes: 30, completeEveryHours: 24 },
  };
  return document;
}

describe("rostering in a configuration revision", () => {
  it("stores the issuer, subject field and schedule the roster sync reads", async () => {
    const draft = await createDraftRevision({ document: withMapping("https://idp.northfield.example"), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    expect(draft.compiled.desired.rostering).toEqual({
      provider: "oneroster-api",
      mode: "apply-automatically",
      identityMapping: { issuer: "https://idp.northfield.example", subject: { field: "userIds", type: "idp" } },
      schedule: { deltaEveryMinutes: 30, completeEveryHours: 24 },
    });
    expect(planConfigurationChange({ next: draft.revision, directory: NORTHFIELD, registry: SHIPPED_REGISTRY }).problems).toEqual([]);
  });

  it("blocks applying a roster issuer the district does not trust", async () => {
    const draft = await createDraftRevision({ document: withMapping("https://idp.elsewhere.example"), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    expect(planConfigurationChange({ next: draft.revision, directory: NORTHFIELD, registry: SHIPPED_REGISTRY }).problems).toEqual([{
      code: "untrusted-roster-issuer",
      path: "/rostering/identityMapping/issuer",
      message: "the roster's issuer https://idp.elsewhere.example is not one of the district's trusted issuers",
    }]);
  });

  it("refuses an identity mapping for a manual roster, and an email subject", () => {
    const manual = withMapping("https://idp.northfield.example");
    manual.rostering.provider = "manual";
    const result = compileDistrictConfig(manual, SHIPPED_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.path)).toEqual(["/rostering/identityMapping", "/rostering/schedule"]);

    const email = withMapping("https://idp.northfield.example");
    email.rostering.identityMapping.subject = { field: "email" };
    expect(compileDistrictConfig(email, SHIPPED_REGISTRY).ok).toBe(false);
  });
});

// SCHO-203: a Clever roster names its Clever district in the revision; its token never does.
describe("a Clever roster in a configuration revision", () => {
  const CLEVER_DISTRICT = "6650c1a0e1b2c3d4e5f6d001";
  function withClever(rostering: Record<string, unknown>) {
    const document = northfieldDocument() as Record<string, unknown>;
    document["rostering"] = {
      provider: "clever",
      mode: "preview-before-apply",
      identityMapping: { issuer: "https://idp.northfield.example", subject: { field: "userIds", type: "clever" } },
      schedule: { deltaEveryMinutes: 15, completeEveryHours: 24 },
      clever: { districtId: CLEVER_DISTRICT },
      removalHold: { maxFraction: 0.1, minCount: 5 },
      ...rostering,
    };
    return document;
  }

  it("stores the Clever district, the identity mapping, the schedule and the removal hold", async () => {
    const draft = await createDraftRevision({ document: withClever({}), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!draft.ok) throw new Error(JSON.stringify(draft.problems));
    expect(draft.compiled.desired.rostering).toMatchObject({
      provider: "clever",
      clever: { districtId: CLEVER_DISTRICT },
      removalHold: { maxFraction: 0.1, minCount: 5 },
    });
    expect(planConfigurationChange({ next: draft.revision, directory: NORTHFIELD, registry: SHIPPED_REGISTRY }).problems).toEqual([]);
  });

  it("requires the Clever district, and the Clever user ID as the subject", () => {
    const paths = (document: Record<string, unknown>) => {
      const result = compileDistrictConfig(document as never, SHIPPED_REGISTRY);
      return result.ok ? [] : result.problems.map((p) => p.path);
    };
    expect(paths(withClever({ clever: undefined }))).toEqual(["/rostering/clever"]);
    expect(paths(withClever({ identityMapping: { issuer: "https://idp.northfield.example", subject: { field: "username" } } }))).toEqual(["/rostering/identityMapping/subject"]);
    expect(paths(withClever({ provider: "oneroster-api" }))).toEqual(["/rostering/clever"]);
  });

  it("refuses a district token in the revision", () => {
    const result = compileDistrictConfig(withClever({ clever: { districtId: CLEVER_DISTRICT, districtToken: "a-district-app-token" } }) as never, SHIPPED_REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContainEqual(expect.objectContaining({ code: "secret-in-config", path: "/rostering/clever/districtToken" }));
  });
});


describe("Classroom roster identity", () => {
  it("requires the stable Google user ID mapping", () => {
    const document = withMapping("https://accounts.google.com");
    document.rostering.provider = "google-classroom";
    document.rostering.identityMapping.subject = { field: "username" };
    expect(compileDistrictConfig(document, SHIPPED_REGISTRY).ok).toBe(true);
    document.rostering.identityMapping.issuer = "https://idp.northfield.example";
    expect(compileDistrictConfig(document, SHIPPED_REGISTRY).ok).toBe(false);
    document.rostering.identityMapping.issuer = "https://accounts.google.com";
    document.rostering.identityMapping.subject = { field: "userIds", type: "idp" };
    expect(compileDistrictConfig(document, SHIPPED_REGISTRY).ok).toBe(false);
  });
});
