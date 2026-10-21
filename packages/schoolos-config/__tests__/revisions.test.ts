import { PrincipalId, SchoolOsError, type ConfigurationRevision } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_REGISTRY,
  canonicalJson,
  createDraftRevision,
  createRollbackRevision,
  diffRevisions,
  revisionContentHash,
  type HashedRevision,
} from "../src/index.ts";
import { northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_nf-district-admin");

async function draft(document: unknown, previous?: ConfigurationRevision): Promise<HashedRevision> {
  const result = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN, ...(previous ? { previous } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

describe("canonicalJson", () => {
  it("ignores key order and refuses values JSON would coerce", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }));
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe("createDraftRevision", () => {
  it("is idempotent: documents that mean the same thing give the same hash and ID", async () => {
    const first = await draft(northfieldDocument());
    const reordered = northfieldDocument();
    reordered.rollout.offerings = ["off_nf-eng9-fall-p3", "off_nf-bio-fall-p2", "off_nf-eng9-fall-p3"];
    reordered.curriculum.frameworks = ["NGSS", "CASEL", "CCSS", "C3"];
    // Spelling out values the profile and pack defaults already give changes nothing.
    reordered.policies = { teacherObservation: "assigned-work-only", ai: { monthlyCapCentsPerPrincipal: 200 } };
    reordered.modules["assessment-ci"] = { state: "advisory", config: { maxRunSeconds: 60 } };
    const second = await draft(reordered);

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.revision.id).toBe(first.revision.id);
    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await revisionContentHash(first.revision)).toBe(first.contentHash);
    expect(first.revision).toMatchObject({ status: "draft", actorPrincipalId: ADMIN, scope: { districtId: "dst_northfield" } });
  });

  it("chains a new revision after its predecessor", async () => {
    const first = await draft(northfieldDocument());
    const changed = northfieldDocument();
    changed.modules["assessment-ci"] = "enabled";
    const second = await draft(changed, first.revision);
    expect(second.revision.previousRevisionId).toBe(first.revision.id);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it("refuses to chain after a revision of another district", async () => {
    const first = await draft(northfieldDocument());
    const foreign = { ...first.revision, scope: { districtId: "dst_riverbend" } } as ConfigurationRevision;
    await expect(createDraftRevision({ document: northfieldDocument(), registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN, previous: foreign }))
      .rejects.toThrow(SchoolOsError);
  });
});

describe("diffRevisions", () => {
  it("reports path-based changes in a stable order", async () => {
    const first = await draft(northfieldDocument());
    const changed = northfieldDocument();
    changed.modules["assessment-ci"] = { state: "enabled", config: { aiFeedback: true } };
    delete changed.modules.playtrek;
    changed.rollout.offerings.push("off_nf-ushist-fall-p5");
    const second = await draft(changed, first.revision);

    const diff = diffRevisions(first.revision, second.revision);
    expect(diff).toEqual([
      { path: "/modules/assessment-ci/config/aiFeedback", change: "changed", before: false, after: true },
      { path: "/modules/assessment-ci/state", change: "changed", before: "advisory", after: "enabled" },
      { path: "/modules/learning-artifacts/requiredBy", change: "changed", before: ["assessment-ci", "content-studio", "playtrek", "teacher-studio"], after: ["assessment-ci", "content-studio", "teacher-studio"] },
      { path: "/modules/playtrek", change: "removed", before: expect.objectContaining({ state: "disabled" }) },
      {
        path: "/rollout/offerings",
        change: "changed",
        before: ["off_nf-bio-fall-p2", "off_nf-eng9-fall-p3"],
        after: ["off_nf-bio-fall-p2", "off_nf-eng9-fall-p3", "off_nf-ushist-fall-p5"],
      },
    ]);
    expect(diffRevisions(first.revision, second.revision)).toEqual(diff);
  });
});

describe("createRollbackRevision", () => {
  it("creates a new chained revision whose desired state equals the earlier one", async () => {
    const first = await draft(northfieldDocument());
    const changed = northfieldDocument();
    changed.modules["classroom-codex"] = "enabled";
    const second = await draft(changed, first.revision);

    const rollback = await createRollbackRevision({ target: first.revision, head: second.revision, actorPrincipalId: ADMIN });
    expect(rollback.revision.desired).toEqual(first.revision.desired);
    expect(rollback.contentHash).toBe(first.contentHash);
    expect(rollback.revision.id).not.toBe(first.revision.id);
    expect(rollback.revision.previousRevisionId).toBe(second.revision.id);
    expect(diffRevisions(second.revision, rollback.revision)).toEqual([
      { path: "/modules/classroom-codex", change: "removed", before: expect.objectContaining({ state: "enabled" }) },
    ]);
  });

  it("refuses a target from another scope, or the head itself", async () => {
    const first = await draft(northfieldDocument());
    const foreign = { ...first.revision, scope: { districtId: "dst_riverbend" } } as ConfigurationRevision;
    await expect(createRollbackRevision({ target: foreign, head: first.revision, actorPrincipalId: ADMIN })).rejects.toThrow(SchoolOsError);
    await expect(createRollbackRevision({ target: first.revision, head: first.revision, actorPrincipalId: ADMIN })).rejects.toThrow(SchoolOsError);
  });
});
