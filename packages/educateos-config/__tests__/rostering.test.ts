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
