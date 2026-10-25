import { PrincipalId, EducateOsError, type ConfigurationRevision } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_REGISTRY,
  canonicalJson,
  createDraftRevision,
  createRollbackRevision,
  diffRevisions,
  revisionContentHash,
  revisionLineage,
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
      .rejects.toThrow(EducateOsError);
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

    const rollback = await createRollbackRevision({ target: first.revision, head: second.revision, history: [first.revision, second.revision], actorPrincipalId: ADMIN });
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
    const history = [first.revision];
    await expect(createRollbackRevision({ target: foreign, head: first.revision, history, actorPrincipalId: ADMIN })).rejects.toThrow(EducateOsError);
    await expect(createRollbackRevision({ target: first.revision, head: first.revision, history, actorPrincipalId: ADMIN })).rejects.toThrow(EducateOsError);
  });

  it("refuses a target that is not an ancestor of the head, even one of the same district", async () => {
    const root = await draft(northfieldDocument());
    const branchDocument = northfieldDocument();
    branchDocument.modules["classroom-codex"] = "enabled";
    // A sibling of the head: chained after the same root, but never applied after it.
    const sibling = await draft(branchDocument, root.revision);
    const headDocument = northfieldDocument();
    headDocument.modules["assessment-ci"] = "enabled";
    const head = await draft(headDocument, root.revision);

    const history = [root.revision, sibling.revision, head.revision];
    await expect(createRollbackRevision({ target: sibling.revision, head: head.revision, history, actorPrincipalId: ADMIN }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("earlier revision") });
    // The real ancestor is accepted.
    await expect(createRollbackRevision({ target: root.revision, head: head.revision, history, actorPrincipalId: ADMIN })).resolves.toBeDefined();
  });

  it("rolls back to the history's copy of the target, not a desired state the caller altered", async () => {
    const root = await draft(northfieldDocument());
    const changed = northfieldDocument();
    changed.modules["assessment-ci"] = "enabled";
    const head = await draft(changed, root.revision);
    const doctored = structuredClone(root.revision);
    doctored.desired = { ...doctored.desired, profile: "us-k12-standard" };

    const rollback = await createRollbackRevision({
      target: doctored,
      head: head.revision,
      history: [root.revision, head.revision],
      actorPrincipalId: ADMIN,
    });
    expect(rollback.revision.desired).toEqual(root.revision.desired);
  });
});

async function chain() {
  const root = await draft(northfieldDocument());
  const changed = northfieldDocument();
  changed.modules["assessment-ci"] = "enabled";
  const middle = await draft(changed, root.revision);
  const changedAgain = northfieldDocument();
  changedAgain.modules["classroom-codex"] = "enabled";
  const head = await draft(changedAgain, middle.revision);
  return { root: root.revision, middle: middle.revision, head: head.revision };
}

describe("revisionLineage", () => {
  it("walks from the head to the first revision, whatever order the history is in", async () => {
    const { root, middle, head } = await chain();
    const lineage = await revisionLineage(head, [head, root, middle]);
    expect(lineage.map((r) => r.id)).toEqual([head.id, middle.id, root.id]);
  });

  it("breaks on a missing link, an edited revision, or a revision spliced in from another chain", async () => {
    const { root, middle, head } = await chain();
    await expect(revisionLineage(head, [head, root])).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("missing") });

    const edited = { ...middle, desired: { ...middle.desired, profile: "us-k12-standard" } };
    await expect(revisionLineage(head, [root, edited, head])).rejects.toMatchObject({ message: expect.stringContaining("does not match its content") });

    // A middle revision that names a different predecessor than it was derived from.
    const otherRoot = (await draft({ ...northfieldDocument(), profile: "us-k12-standard" })).revision;
    const respliced = { ...middle, previousRevisionId: otherRoot.id };
    await expect(revisionLineage(head, [root, otherRoot, respliced, head])).rejects.toMatchObject({ code: "conflict" });

    const twoCopies = [root, middle, { ...middle, status: "applied" as const }, head];
    await expect(revisionLineage(head, twoCopies)).rejects.toMatchObject({ message: expect.stringContaining("two different revisions") });
  });
});
