// F03 acceptance: changing a module shows inherited config, dependency effects and an auditable
// revision, with impact numbers from the synthetic Northfield district.
import { PrincipalId, SchoolOsError, type ConfigurationRevision } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import { SHIPPED_REGISTRY, createDraftRevision, createRollbackRevision, planConfigurationChange } from "../src/index.ts";
import { NF, northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_nf-district-admin");

async function draft(document: unknown, previous?: ConfigurationRevision): Promise<ConfigurationRevision> {
  const result = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN, ...(previous ? { previous } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.revision;
}

/** Northfield today: the core of SchoolOS in two high-school classes, with narrower policy. */
function currentDocument() {
  const document = northfieldDocument();
  document.profile = "us-k12-standard";
  document.modules = { "core-learning": "enabled", "learning-registry": "enabled" };
  document.policies = { ai: { monthlyCapCentsPerPrincipal: 300 } };
  document.overrides = [
    { scope: NF.high, policies: { teacherObservation: "assigned-work-only" } },
    { scope: NF.eng9, policies: { ai: { monthlyCapCentsPerPrincipal: 100 } } },
  ];
  return document;
}

/** The change: turn on Assessment CI with AI feedback, and add US History to the rollout. */
function nextDocument() {
  const document = currentDocument();
  document.modules["assessment-ci"] = { state: "enabled", config: { aiFeedback: true } };
  document.rollout.offerings.push("off_nf-ushist-fall-p5");
  return document;
}

const plan = (current: ConfigurationRevision | undefined, next: ConfigurationRevision, directory = NORTHFIELD) =>
  planConfigurationChange({ ...(current ? { current } : {}), next, directory, registry: SHIPPED_REGISTRY });

describe("planConfigurationChange (F03 acceptance)", () => {
  it("shows dependency effects, impact, inherited policy, approvals and an auditable revision", async () => {
    const current = await draft(currentDocument());
    const next = await draft(nextDocument(), current);
    const result = plan(current, next);

    // Auditable: the next revision is chained and its diff names every changed path.
    expect(next.previousRevisionId).toBe(current.id);
    expect(result.diff.map((d) => [d.change, d.path])).toEqual([
      ["added", "/modules/assessment-ci"],
      ["added", "/modules/learning-artifacts"],
      ["changed", "/rollout/offerings"],
    ]);
    expect(result.problems).toEqual([]);
    expect(result.installOrder).toEqual(["core-learning", "learning-artifacts", "assessment-ci", "learning-registry"]);

    // Dependency effects: enabling assessment-ci pulls in learning-artifacts.
    expect(result.dependencyEffects).toEqual([
      { capabilityId: "learning-artifacts", pulledInBy: ["assessment-ci"], state: "exposed" },
    ]);
    expect(result.packs.map((p) => [p.capabilityId, p.changes, p.exposedTo])).toEqual([
      ["assessment-ci", ["installed", "enabled", "exposure-changed"], ["off_nf-bio-fall-p2", "off_nf-eng9-fall-p3", "off_nf-ushist-fall-p5"]],
      ["core-learning", ["exposure-changed"], ["off_nf-ushist-fall-p5"]],
      ["learning-artifacts", ["installed", "enabled", "exposure-changed"], ["off_nf-bio-fall-p2", "off_nf-eng9-fall-p3", "off_nf-ushist-fall-p5"]],
    ]);

    // Impact from active enrollments: Dmitri's dropped English 9 enrollment does not count.
    expect(result.offerings.map((o) => [o.offeringId, o.students, o.staff, o.packsExposed])).toEqual([
      ["off_nf-bio-fall-p2", 3, 1, ["assessment-ci", "learning-artifacts"]],
      ["off_nf-eng9-fall-p3", 2, 2, ["assessment-ci", "learning-artifacts"]],
      ["off_nf-ushist-fall-p5", 2, 1, ["assessment-ci", "core-learning", "learning-artifacts"]],
    ]);

    // Inherited config: each offering's effective policy says where every value came from.
    const eng9 = result.offerings.find((o) => o.offeringId === "off_nf-eng9-fall-p3")!.policy;
    expect(eng9.effective).toMatchObject({ teacherObservation: "assigned-work-only", aiMonthlyCapCentsPerPrincipal: 100 });
    expect(eng9.sources).toMatchObject({
      aiSpending: "profile",
      teacherObservation: "school",
      aiMonthlyCapCentsPerPrincipal: "offering",
    });
    const bio = result.offerings.find((o) => o.offeringId === "off_nf-bio-fall-p2")!.policy;
    expect(bio.effective.aiMonthlyCapCentsPerPrincipal).toBe(300);
    expect(bio.sources.aiMonthlyCapCentsPerPrincipal).toBe("district");

    // Approvals: AI feedback widens AI use, and each new exposure waits for district activation.
    expect(result.approvals).toEqual([
      {
        role: "district-admin",
        reason: "governed-setting-enabled",
        path: "/modules/assessment-ci/config/aiFeedback",
        detail: "assessment-ci: AI writing feedback (ai)",
      },
      { role: "district-admin", reason: "exposure-activation", path: "/rollout/offerings", detail: "off_nf-bio-fall-p2: assessment-ci, learning-artifacts" },
      { role: "district-admin", reason: "exposure-activation", path: "/rollout/offerings", detail: "off_nf-eng9-fall-p3: assessment-ci, learning-artifacts" },
      {
        role: "district-admin",
        reason: "exposure-activation",
        path: "/rollout/offerings",
        detail: "off_nf-ushist-fall-p5: assessment-ci, core-learning, learning-artifacts",
      },
    ]);
    expect(result.policyViolations).toEqual([]);
  });

  it("plans a rollback as the exact reverse, uninstalling what the change pulled in", async () => {
    const current = await draft(currentDocument());
    const next = await draft(nextDocument(), current);
    const rollback = await createRollbackRevision({ target: current, head: next, actorPrincipalId: ADMIN });
    const result = plan(next, rollback.revision);

    expect(result.packs.map((p) => [p.capabilityId, p.changes, p.withdrawnFrom.length])).toEqual([
      ["assessment-ci", ["uninstalled", "disabled", "exposure-changed"], 3],
      ["core-learning", ["exposure-changed"], 1],
      ["learning-artifacts", ["uninstalled", "disabled", "exposure-changed"], 3],
    ]);
    expect(result.dependencyEffects).toEqual([]);
    expect(result.approvals).toEqual([]);
  });

  it("needs district approval for a first revision that loosens the profile or turns on an AI pack", async () => {
    const document = northfieldDocument();
    document.modules["classroom-codex"] = "enabled";
    document.policies.ai.promptsInGatewayLogs = true;
    const result = plan(undefined, await draft(document));

    expect(result.approvals.filter((a) => a.reason !== "exposure-activation")).toEqual([
      {
        role: "district-admin",
        reason: "policy-loosened",
        path: "/policies/promptsInGatewayLogs",
        detail: "district promptsInGatewayLogs: prohibited -> permitted",
      },
      { role: "district-admin", reason: "ai-capability-enabled", path: "/modules/classroom-codex/state", detail: "classroom-codex sends requests to AI providers" },
    ]);
  });

  it("needs district approval when removing a school override loosens its offerings", async () => {
    const current = await draft(currentDocument());
    const relaxed = currentDocument();
    relaxed.overrides = relaxed.overrides.slice(1);
    const result = plan(current, await draft(relaxed, current));

    // Every high-school offering inherits the looser district value again, including the closed term.
    expect(result.approvals.map((a) => [a.reason, a.path, a.detail])).toEqual([
      "off_nf-bio-fall-p2",
      "off_nf-bio-spring-p4",
      "off_nf-eng9-fall-p3",
      "off_nf-ushist-fall-p5",
    ].map((offering) => ["policy-loosened", "/overrides", `${offering} teacherObservation: assigned-work-only -> assigned-work-and-shared-conversations`]));
    expect(result.offerings.filter((o) => o.policyChanged).map((o) => [o.offeringId, o.policy.sources.teacherObservation])).toEqual([
      ["off_nf-bio-fall-p2", "profile"],
      ["off_nf-bio-spring-p4", "profile"],
      ["off_nf-eng9-fall-p3", "profile"],
      ["off_nf-ushist-fall-p5", "profile"],
    ]);
  });

  it("blocks exposure to a closed term or an offering the directory does not have", async () => {
    const document = northfieldDocument();
    document.rollout.offerings = ["off_nf-bio-spring-p4", "off_rb-chem-fall-p1", "off_nf-math7-fall-p1"];
    const result = plan(undefined, await draft(document));

    // Paths index the revision's sorted offering list.
    expect(result.problems).toEqual([
      { code: "offering-term-closed", path: "/rollout/offerings/0", message: "off_nf-bio-spring-p4 is in a completed term and cannot gain new packs" },
      { code: "unknown-offering", path: "/rollout/offerings/2", message: "off_rb-chem-fall-p1 is not an offering in this district" },
    ]);
    expect(result.offerings.map((o) => o.offeringId)).toEqual(["off_nf-math7-fall-p1"]);
  });

  it("refuses to plan one district's revision against another district's directory", async () => {
    const next = await draft(northfieldDocument());
    expect(() => plan(undefined, next, RIVERBEND)).toThrow(SchoolOsError);
  });
});
