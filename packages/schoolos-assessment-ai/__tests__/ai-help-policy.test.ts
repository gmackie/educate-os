import { SHIPPED_REGISTRY, createDraftRevision, type DesiredState } from "@schoolos/config";
import { ActivityId, PrincipalId, type Scope } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import { compiledConfigAiHelpPolicies, type AiHelpPolicy } from "../src/index.ts";

const D = "dst_northfield";
const BIO = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as Extract<Scope, { level: "offering" }>;
const ENG9 = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" } as Extract<Scope, { level: "offering" }>;
const MATH7 = { level: "offering", districtId: D, schoolId: "sch_nf-middle", offeringId: "off_nf-math7-fall-p1" } as Extract<Scope, { level: "offering" }>;
const LAB = ActivityId.parse("act_nf-bio-lab");
const ESSAY = ActivityId.parse("act_nf-eng9-essay");
const PROBLEMS = ActivityId.parse("act_nf-math7-problems");
const ORPHAN = ActivityId.parse("act_nf-orphan");

async function compiled(): Promise<DesiredState> {
  const result = await createDraftRevision({
    document: {
      apiVersion: "schoolos.dev/v1alpha1",
      district: D,
      profile: "us-k12-standard",
      identity: { provider: "district-sso" },
      rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
      modules: { "core-learning": "enabled" },
      rollout: { target: "all-active-offerings", requiresAdminActivation: false },
      overrides: [
        { scope: { level: "school", districtId: D, schoolId: "sch_nf-high" }, policies: { ai: { help: "hints-only" } } },
        { scope: ENG9, policies: { ai: { help: "none" } } },
      ],
    },
    registry: SHIPPED_REGISTRY,
    actorPrincipalId: PrincipalId.parse("prn_nf-district-admin"),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.compiled.desired;
}

describe("compiledConfigAiHelpPolicies", () => {
  it("caps each activity's own policy by the strictest AI-help level configured above its offering", async () => {
    const desired = await compiled();
    const offerings = new Map([[LAB, BIO], [ESSAY, ENG9], [PROBLEMS, MATH7]]);
    const policies = compiledConfigAiHelpPolicies({
      activities: { aiHelpPolicy: async (id) => (id === ORPHAN || offerings.has(id) ? "releasable" : undefined) },
      offeringOf: async (id) => offerings.get(id),
      readConfig: async () => desired,
    });
    const read = (id: ActivityId) => policies.aiHelpPolicy(id);

    // High school: hints-only keeps AI feedback with the teacher; English 9 turns it off.
    expect(await read(LAB)).toBe<AiHelpPolicy>("teacher-only");
    expect(await read(ESSAY)).toBe<AiHelpPolicy>("none");
    // Middle school inherits the district's full help, so the activity's own policy stands.
    expect(await read(PROBLEMS)).toBe<AiHelpPolicy>("releasable");
    // An activity with no known offering has no policy, which the service reads as none.
    expect(await read(ORPHAN)).toBeUndefined();
  });

  it("never loosens an activity that allows less than the configuration would", async () => {
    const desired = await compiled();
    const policies = compiledConfigAiHelpPolicies({
      activities: { aiHelpPolicy: async () => "none" },
      offeringOf: async () => MATH7,
      readConfig: async () => desired,
    });
    expect(await policies.aiHelpPolicy(PROBLEMS)).toBe("none");
  });
});
