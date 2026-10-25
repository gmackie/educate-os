import { describe, expect, it } from "vitest";
import { ArtifactId, PrincipalId, SubmissionId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { essay, FLOOR, O, P, rejectsWith, setup } from "./setup.ts";

/** Amara with a personal journal entry and a Biology essay. */
async function amarasWork() {
  const ctx = setup();
  const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
  const bio = await ctx.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const journal = await ctx.artifacts.createArtifact(P.amara, essay(personal.id, "Private reflections.", "Journal"));
  const bioEssay = await ctx.artifacts.createArtifact(P.amara, essay(bio.id, "Membranes are selectively permeable."));
  return { ...ctx, personal, bio, journal, bioEssay };
}

describe("a teacher", () => {
  it("reads and exports course artifacts in their offering", async () => {
    const { artifacts, bio, bioEssay } = await amarasWork();
    expect((await artifacts.readRevision(P.morgan, bioEssay.artifact.id)).content).toEqual({ kind: "text", text: "Membranes are selectively permeable." });
    expect((await artifacts.listArtifacts(P.morgan, bio.id)).map((v) => v.artifact.id)).toEqual([bioEssay.artifact.id]);
    expect((await artifacts.exportArtifact(P.morgan, bioEssay.artifact.id)).manifest.artifact.id).toBe(bioEssay.artifact.id);
    // Reading is all: the work stays the student's.
    await rejectsWith(
      artifacts.saveRevision(P.morgan, bioEssay.artifact.id, { content: { kind: "text", mediaType: "text/markdown", text: "edited" }, aiAssistance: { level: "none" } }),
      "forbidden",
    );
  });

  it("is denied a student's personal artifact, exactly as if it did not exist", async () => {
    const { artifacts, audit, personal, journal } = await amarasWork();
    const missing = ArtifactId.parse("art_does-not-exist");
    for (const attempt of [
      artifacts.getArtifact(P.morgan, journal.artifact.id),
      artifacts.readRevision(P.morgan, journal.artifact.id),
      artifacts.history(P.morgan, journal.artifact.id),
      artifacts.exportArtifact(P.morgan, journal.artifact.id),
      artifacts.listArtifacts(P.morgan, personal.id),
      artifacts.getArtifact(P.morgan, missing),
    ]) {
      await rejectsWith(attempt, "not-found");
    }
    // Nor does an administrator see it.
    await rejectsWith(artifacts.readRevision(P.nfAdmin, journal.artifact.id), "not-found");
    expect(audit.events.filter((e) => e.resourceId === journal.artifact.id && e.principalId === P.morgan.principal.principalId).map((e) => e.ruleId))
      .toEqual(Array(4).fill("guard.personal-private.owner-only"));
  });

  it("cannot read course work in an offering they do not teach", async () => {
    const { artifacts, bio, bioEssay } = await amarasWork();
    await rejectsWith(artifacts.readRevision(P.rivera, bioEssay.artifact.id), "not-found");
    await rejectsWith(artifacts.listArtifacts(P.rivera, bio.id), "not-found");
  });
});

describe("a student", () => {
  it("is denied another student's artifacts, course and personal", async () => {
    const { artifacts, workspaces, bio, personal, journal, bioEssay } = await amarasWork();
    for (const id of [journal.artifact.id, bioEssay.artifact.id]) {
      await rejectsWith(artifacts.getArtifact(P.elena, id), "not-found");
      await rejectsWith(artifacts.readRevision(P.elena, id), "not-found");
      await rejectsWith(artifacts.exportArtifact(P.elena, id), "not-found");
      await rejectsWith(artifacts.pin(P.elena, id, bioEssay.head.id, { kind: "keep" }), "not-found");
      await rejectsWith(artifacts.share(P.elena, id, P.elena.principal.principalId), "not-found");
      await rejectsWith(artifacts.deleteArtifact(P.elena, id), "not-found");
    }
    await rejectsWith(artifacts.listArtifacts(P.elena, bio.id), "not-found");
    await rejectsWith(artifacts.listArtifacts(P.elena, personal.id), "not-found");
    // Her own Biology workspace, in the same offering, lists only her own work.
    const elenaBio = await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
    expect(await artifacts.listArtifacts(P.elena, elenaBio.id)).toEqual([]);
  });

  it("cannot reach another student's revision through their own artifact", async () => {
    const { artifacts, workspaces, bioEssay } = await amarasWork();
    const elenaBio = await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
    const own = await artifacts.createArtifact(P.elena, essay(elenaBio.id, "Elena's essay"));
    await rejectsWith(artifacts.readRevision(P.elena, own.artifact.id, bioEssay.head.id), "not-found");
    await rejectsWith(artifacts.publishBaseline(P.elena, own.artifact.id, bioEssay.head.id, "copy"), "not-found");
  });
});

describe("sharing", () => {
  it("records a grant on personal work that never overrides policy", async () => {
    const { artifacts, journal } = await amarasWork();
    const elena = P.elena.principal.principalId;
    const grant = await artifacts.share(P.amara, journal.artifact.id, elena);
    expect(grant).toMatchObject({ artifactId: journal.artifact.id, granteePrincipalId: elena, grantedBy: P.amara.principal.principalId });
    expect(await artifacts.share(P.amara, journal.artifact.id, elena)).toEqual(grant);
    // Policy keeps personal-private content owner-only, so the grant alone shows Elena nothing.
    await rejectsWith(artifacts.readRevision(P.elena, journal.artifact.id), "not-found");
    await rejectsWith(artifacts.share(P.amara, journal.artifact.id, PrincipalId.parse("prn_nf-nobody")), "not-found");
    await rejectsWith(artifacts.share(P.amara, journal.artifact.id, P.amara.principal.principalId), "validation-failed");
  });

  it("refuses to share work with a guardian, even the student's own (ADR-0012)", async () => {
    const guardianId = PrincipalId.parse("prn_nf-guardian-okafor");
    const ctx = setup({
      ...NORTHFIELD,
      principals: [...NORTHFIELD.principals, {
        id: guardianId,
        districtId: NORTHFIELD.district.id,
        kind: "guardian",
        status: "active",
        displayName: "Ngozi Okafor",
        externalIdentities: [{ districtId: NORTHFIELD.district.id, issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: "nf-guardian-okafor" }],
      }],
    });
    const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
    const journal = await ctx.artifacts.createArtifact(P.amara, essay(personal.id, "Private reflections.", "Journal"));
    await rejectsWith(ctx.artifacts.share(P.amara, journal.artifact.id, guardianId), "validation-failed");
    expect((await ctx.records.load()).state.shares).toEqual([]);
  });

  it("lets the grantee read shared personal work once the policy information point reads shares, under a sharing floor", async () => {
    const ctx = setup(undefined, { shares: "wired" });
    const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
    const journal = await ctx.artifacts.createArtifact(P.amara, essay(personal.id, "Private reflections.", "Journal"));
    await rejectsWith(ctx.artifacts.readRevision(P.elena, journal.artifact.id), "not-found");

    await ctx.artifacts.share(P.amara, journal.artifact.id, P.elena.principal.principalId);
    expect((await ctx.artifacts.readRevision(P.elena, journal.artifact.id)).content).toEqual({ kind: "text", text: "Private reflections." });
    const read = ctx.audit.events.findLast((e) => e.principalId === P.elena.principal.principalId && e.effect === "allow");
    expect(read).toMatchObject({ ruleId: "share.grantee.read", grantId: `share:${journal.artifact.id}:${P.elena.principal.principalId}` });

    // A read is all the share gives: no edit, re-share or export, and no one else gains anything.
    await rejectsWith(
      ctx.artifacts.saveRevision(P.elena, journal.artifact.id, { content: { kind: "text", mediaType: "text/markdown", text: "edited" }, aiAssistance: { level: "none" } }),
      "forbidden",
    );
    await rejectsWith(ctx.artifacts.share(P.elena, journal.artifact.id, P.morgan.principal.principalId), "forbidden");
    await rejectsWith(ctx.artifacts.exportArtifact(P.elena, journal.artifact.id), "forbidden");
    await rejectsWith(ctx.artifacts.readRevision(P.morgan, journal.artifact.id), "not-found");

    // Deleting the artifact ends the share.
    await ctx.artifacts.deleteArtifact(P.amara, journal.artifact.id);
    await rejectsWith(ctx.artifacts.readRevision(P.elena, journal.artifact.id), "not-found");
  });

  it("is refused to the owner, and opens nothing, under a floor that keeps personal material private", async () => {
    const ctx = setup(undefined, { shares: "wired", floor: { ...FLOOR, studentPersonalConversations: "private" } });
    const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
    const journal = await ctx.artifacts.createArtifact(P.amara, essay(personal.id, "Private reflections.", "Journal"));
    await rejectsWith(ctx.artifacts.share(P.amara, journal.artifact.id, P.elena.principal.principalId), "forbidden");
    expect(ctx.audit.events.findLast((e) => e.action === "share")).toMatchObject({ effect: "deny", reason: "policy-floor", ruleId: "guard.personal-private.no-sharing" });

    // A grant recorded while sharing was allowed stops working when the floor tightens.
    const { state, version } = await ctx.records.load();
    const grant = { artifactId: journal.artifact.id, granteePrincipalId: P.elena.principal.principalId, grantedBy: P.amara.principal.principalId, grantedAt: "2026-10-20T12:00:00.000Z" };
    await ctx.records.commit({ ...state, shares: [...state.shares, grant] }, version);
    await rejectsWith(ctx.artifacts.readRevision(P.elena, journal.artifact.id), "not-found");
  });

  it("ignores a share record that its artifact's owner did not make", async () => {
    const ctx = setup(undefined, { shares: "wired" });
    const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
    const journal = await ctx.artifacts.createArtifact(P.amara, essay(personal.id, "Private reflections.", "Journal"));
    const { state, version } = await ctx.records.load();
    const forged = { artifactId: journal.artifact.id, granteePrincipalId: P.elena.principal.principalId, grantedBy: P.elena.principal.principalId, grantedAt: "2026-10-20T12:00:00.000Z" };
    await ctx.records.commit({ ...state, shares: [...state.shares, forged] }, version);
    await rejectsWith(ctx.artifacts.readRevision(P.elena, journal.artifact.id), "not-found");
  });

  it("is refused for course work, which policy gives no share rule", async () => {
    const { artifacts, bioEssay } = await amarasWork();
    await rejectsWith(artifacts.share(P.amara, bioEssay.artifact.id, P.elena.principal.principalId), "forbidden");
  });
});

describe("pinning", () => {
  it("for a submission is authorized as submitting: personal work cannot be submitted", async () => {
    const { artifacts, journal, bioEssay } = await amarasWork();
    const submission = { kind: "submission", submissionId: SubmissionId.parse("sub_amara-1") } as const;
    await rejectsWith(artifacts.pin(P.amara, journal.artifact.id, journal.head.id, submission), "forbidden");
    await expect(artifacts.pin(P.amara, bioEssay.artifact.id, bioEssay.head.id, submission)).resolves.toMatchObject({ consumer: submission });
    // A teacher can read the essay, but cannot submit it.
    await rejectsWith(artifacts.pin(P.morgan, bioEssay.artifact.id, bioEssay.head.id, submission), "forbidden");
  });
});

describe("promotion support", () => {
  it("confirms only the caller's own artifact in the named workspace", async () => {
    const { artifacts, bio, personal, bioEssay, journal } = await amarasWork();
    await expect(artifacts.confirmPromotable(P.amara, bio.id, bioEssay.artifact.id)).resolves.toBeUndefined();
    // Bound, so the workspaces package can be handed the function itself.
    const check = artifacts.confirmPromotable;
    await expect(check(P.amara, bio.id, bioEssay.artifact.id)).resolves.toBeUndefined();

    await rejectsWith(check(P.amara, personal.id, bioEssay.artifact.id), "not-found");
    await rejectsWith(check(P.amara, bio.id, journal.artifact.id), "not-found");
    await rejectsWith(check(P.amara, bio.id, ArtifactId.parse("art_does-not-exist")), "not-found");
    // The teacher can read the essay but does not own it.
    await rejectsWith(check(P.morgan, bio.id, bioEssay.artifact.id), "not-found");
    await rejectsWith(check(P.elena, bio.id, bioEssay.artifact.id), "not-found");
  });
});
