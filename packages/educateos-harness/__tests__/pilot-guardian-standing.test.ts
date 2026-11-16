// Pilot security regression (SCHO-434 security gates). A guardian suggestion is posted under a verified
// relationship and an administrator's grant. These tests drive the real district routes over the invented
// Pilot Lakes district and ask what happens to a suggestion that is ALREADY QUEUED when that standing ends.
// Before the repair a suspended or revoked guardian's queued suggestion could still be approved by a
// teacher and then reached the child, labelled "From your family: <name>".
//
// Semantics asserted here (and in docs/educateos/security/pilot-security-signoff.md):
//   - Standing is read afresh: the relationship is in force AND the grant names `suggest` for that guardian.
//   - Without standing, an UNAPPROVED (awaiting-teacher) suggestion cannot be approved and is not listed.
//   - Without standing, a suggestion a teacher already approved is withheld from the student and cannot be
//     answered. Nothing is deleted: the record, its teacher decision and the student's own choice remain,
//     and they reappear only if an administrator restores the same standing.
//   - A teacher's own practice invitation is a different record with the teacher as origin and is untouched.
import { describe, expect, it } from "vitest";
import { PL, RIVERBEND } from "@educateos/fixtures";
import { bootPilotDistrict, onboardGuardian, outcomeOf, type PilotDistrict } from "../src/pilot/index.ts";

const params = { offeringId: PL.grade6 as never };
const TOPIC_A = "Queued topic about tide pools";
const TOPIC_B = "Approved topic about chess clocks";

async function family(d: PilotDistrict, studentId: string, subject: string, name: string, capabilities: ("suggest" | "progress")[] = ["suggest"]) {
  const guardian = await onboardGuardian(d, studentId, subject, name);
  await d.ok(d.tokenFor(PL.admin), "admin.setGuardianGuidance", { params: { relationshipId: guardian.relationshipId as never }, body: { revision: 0, capabilities } });
  const suggest = (topic: string) => d.call(guardian.token, "guardian.guidanceSuggest", { params: { studentId: studentId as never, offeringId: PL.grade6 as never }, body: { kind: "curiosity", topic } });
  return { ...guardian, suggest };
}
const inbox = async (d: PilotDistrict) => (await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params })).suggestions;
const review = (d: PilotDistrict, s: { id: string; revision: number }) =>
  d.call(d.tokenFor(PL.okoye), "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: s.id as never }, body: { revision: s.revision, decision: "share" } });
const studentSees = async (d: PilotDistrict, who: string) => (await d.ok(d.tokenFor(who), "student.guidance", { params })).invitations;

describe("a guardian whose standing ends cannot steer a child through suggestions queued earlier", () => {
  it("suspension and revocation stop approval and visibility, and a restored relationship restores them", async () => {
    const d = await bootPilotDistrict();
    const admin = d.tokenFor(PL.admin);
    const gina = await family(d, PL.jules, "standing-guardian-1", "Gina Standing (synthetic guardian)");
    // One suggestion is approved by the teacher while standing holds; a second is still waiting.
    expect(outcomeOf(await gina.suggest(TOPIC_B))).toBe("ok");
    await review(d, (await inbox(d))[0]!);
    expect(outcomeOf(await gina.suggest(TOPIC_A))).toBe("ok");

    // BEFORE: the approved one reaches the child with its origin; the queued one is actionable.
    expect((await studentSees(d, PL.jules)).map((i) => i.title)).toEqual([TOPIC_B]);
    expect((await inbox(d)).map((s) => [s.topic, s.status]).toSorted()).toEqual([[TOPIC_B, "shared"], [TOPIC_A, "awaiting-teacher"]]);

    // AFTER suspension (a custody review, say): fail closed, without exposing the withheld text.
    await d.ok(admin, "admin.suspendGuardian", { params: { relationshipId: gina.relationshipId as never }, body: { reason: "custody-review" } });
    const queued = await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params });
    expect(queued.suggestions.some((s) => s.topic === TOPIC_A)).toBe(false);
    expect(JSON.stringify(queued)).not.toContain(TOPIC_A);
    const approved = queued.suggestions.find((s) => s.topic === TOPIC_B)!;
    expect(approved).toMatchObject({ status: "shared", review: { decision: "share" } }); // the audited decision survives
    expect(await studentSees(d, PL.jules)).toEqual([]);
    expect(JSON.stringify(await d.ok(d.tokenFor(PL.jules), "student.guidance", { params }))).not.toMatch(/chess clocks|Gina Standing/);
    expect(outcomeOf(await d.call(d.tokenFor(PL.jules), "student.guidanceRespond", { params: { ...params, invitationId: approved.id as never }, body: { revision: approved.revision, decision: "accepted" } }))).toBe("404 not-found");
    // The queued one cannot be approved even by a teacher who learns its ID from before the suspension.
    d.setNow(new Date(d.now().getTime() + 1000).toISOString());
    await d.ok(admin, "admin.resumeGuardian", { params: { relationshipId: gina.relationshipId as never } });
    const resumedQueued = (await inbox(d)).find((s) => s.topic === TOPIC_A)!;
    await d.ok(admin, "admin.suspendGuardian", { params: { relationshipId: gina.relationshipId as never }, body: { reason: "custody-review" } });
    expect(outcomeOf(await review(d, resumedQueued))).toBe("404 not-found");

    // Restoring the same relationship restores the same records: nothing was deleted.
    await d.ok(admin, "admin.resumeGuardian", { params: { relationshipId: gina.relationshipId as never } });
    expect((await studentSees(d, PL.jules)).map((i) => i.title)).toEqual([TOPIC_B]);
    expect(outcomeOf(await review(d, resumedQueued))).toBe("ok");

    // A revoked relationship is final for both.
    await d.ok(admin, "admin.revokeGuardian", { params: { relationshipId: gina.relationshipId as never } });
    expect(await studentSees(d, PL.jules)).toEqual([]);
    expect((await inbox(d)).filter((s) => s.status === "awaiting-teacher")).toEqual([]);
    expect(outcomeOf(await gina.suggest("After revocation"))).toBe("404 not-found");
  });

  it("removing the suggest grant does the same, leaves other families and a teacher's own invitation alone, and needs a new grant to post again", async () => {
    const d = await bootPilotDistrict();
    const admin = d.tokenFor(PL.admin);
    const gina = await family(d, PL.jules, "standing-guardian-2", "Gina Standing (synthetic guardian)");
    const rosa = await family(d, PL.maribel, "standing-guardian-3", "Rosa Standing (synthetic guardian)");
    await gina.suggest(TOPIC_B);
    await rosa.suggest("Rosa topic about kites");
    for (const s of await inbox(d)) await review(d, s);
    await gina.suggest(TOPIC_A);
    await d.ok(d.tokenFor(PL.okoye), "teacher.guidancePracticeInvite", { params, body: { studentIds: [PL.jules as never], skill: "planning", note: "Teacher-chosen practice." } });
    const titles = async (who: string) => (await studentSees(d, who)).map((i) => `${i.origin.kind}:${i.title}`).toSorted();
    expect(await titles(PL.jules)).toEqual(["guardian:" + TOPIC_B, "teacher:Planning practice"].toSorted());

    // AFTER the administrator removes only the `suggest` capability (progress alone is not enough to steer).
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 1, capabilities: ["progress"] } });
    expect(await titles(PL.jules)).toEqual(["teacher:Planning practice"]);
    expect((await inbox(d)).some((s) => s.topic === TOPIC_A)).toBe(false);
    // Another family, same class, keeps its own standing; the teacher's invitation is a separate teacher-owned record.
    expect(await titles(PL.maribel)).toEqual(["guardian:Rosa topic about kites"]);
    expect(outcomeOf(await rosa.suggest("Rosa follow-up"))).toBe("ok");
    // The family's own view shows nothing of the student's choices and nothing of the other family.
    const own = JSON.stringify(await d.ok(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } }));
    expect(own).not.toMatch(/kites|Planning practice|accepted|declined/);

    // A revoked grant needs a NEW grant, and a new grant does not resurrect what was posted before the revocation.
    // (Contrast the first test: a suspended relationship that resumes with its grant intact gets its records back.)
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 2, capabilities: ["suggest"] } });
    expect(await titles(PL.jules)).toEqual(["teacher:Planning practice"]);
    expect((await inbox(d)).some((s) => s.topic === TOPIC_A)).toBe(false);
    expect(outcomeOf(await gina.suggest("Posted under the new grant"))).toBe("ok");
    const fresh = (await inbox(d)).find((s) => s.topic === "Posted under the new grant")!;
    expect(outcomeOf(await review(d, fresh))).toBe("ok");
    expect(await titles(PL.jules)).toEqual(["guardian:Posted under the new grant", "teacher:Planning practice"]);
    // Revoking every capability withdraws it again. The grant history, which names no topics, still shows each change.
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 3, capabilities: [] } });
    expect(await titles(PL.jules)).toEqual(["teacher:Planning practice"]);
    expect(outcomeOf(await gina.suggest("While revoked"))).toBe("403 forbidden");
    // Only a new grant lets this guardian post again, and it still does not bring back what the revocation withdrew.
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 4, capabilities: ["suggest"] } });
    expect(await titles(PL.jules)).toEqual(["teacher:Planning practice"]);
    // Two withheld suggestions plus the one from the earlier grant exist, yet the open-suggestion cap (three)
    // counts only what is actionable now, so the re-granted guardian is not locked out by records they cannot use.
    for (const topic of ["After a second grant", "A second one", "A third one"]) expect(outcomeOf(await gina.suggest(topic)), topic).toBe("ok");
    expect(outcomeOf(await gina.suggest("A fourth one"))).toBe("409 conflict"); // the cap still bites on actionable ones
    const history = (await d.ok(admin, "admin.guardianGuidance", { params: { studentId: PL.jules as never } })).relationships[0]!.history.map((h) => h.action);
    expect(history).toEqual(["enabled", "changed", "changed", "revoked", "enabled"]);
  });

  it("bounds how many withheld records revoke-and-regrant cycles can leave behind, and lets the guardian retract them", async () => {
    const d = await bootPilotDistrict();
    const admin = d.tokenFor(PL.admin);
    const gina = await family(d, PL.jules, "standing-guardian-5", "Gina Standing (synthetic guardian)");
    const setGrant = (revision: number, capabilities: ("suggest")[]) =>
      d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision, capabilities } });
    let revision = 1;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 3; i++) expect(outcomeOf(await gina.suggest(`Cycle ${cycle} topic ${i}`)), `cycle ${cycle} topic ${i}`).toBe("ok");
      await setGrant(revision++, []);
      await setGrant(revision++, ["suggest"]);
      expect((await inbox(d)).filter((s) => s.status === "awaiting-teacher").length, "withheld records are not listed").toBe(0);
    }
    // Nine unexpired records are retained and none is actionable: the cap on actionable ones does not apply, the retained bound does.
    expect(outcomeOf(await gina.suggest("One more"))).toBe("409 conflict");
    // Retracting one of the guardian's own records frees a slot; nothing else changes and no topic is shown to anyone else.
    const own = (await d.ok(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } })).offerings[0]!.suggestions!;
    expect(own).toHaveLength(9);
    await d.ok(gina.token, "guardian.guidanceWithdraw", { params: { studentId: PL.jules as never, offeringId: PL.grade6 as never, suggestionId: own[0]!.id as never } });
    expect(outcomeOf(await gina.suggest("One more"))).toBe("ok");
    expect(await studentSees(d, PL.jules)).toEqual([]);
    // Time ends them too: after the 30-day waiting window the old records stop counting and the family can post again.
    d.setNow(new Date(d.now().getTime() + 31 * 24 * 3_600_000).toISOString());
    expect(outcomeOf(await gina.suggest("After the window"))).toBe("ok");
  });

  it("a stored suggestion with no grant revision (legacy) is never assumed to belong to a later grant", async () => {
    const d = await bootPilotDistrict();
    const admin = d.tokenFor(PL.admin);
    const gina = await family(d, PL.jules, "standing-guardian-6", "Gina Standing (synthetic guardian)");
    await gina.suggest(TOPIC_B);
    await review(d, (await inbox(d))[0]!);
    await gina.suggest(TOPIC_A);
    // Rewrite both records as an older release stored them: same content, no `grantRevision`.
    const stored = (await d.stores.guidance.records.list(PL.grade6)).filter((r) => r.type === "suggestion");
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.type === "suggestion" && r.grantRevision !== undefined)).toBe(true);
    for (const r of stored) {
      if (r.type !== "suggestion") continue;
      const { grantRevision: _dropped, ...legacy } = r;
      await d.stores.guidance.records.save({ ...legacy, revision: r.revision + 1 }, r.revision);
    }
    expect((await d.stores.guidance.records.list(PL.grade6)).some((r) => r.type === "suggestion" && r.grantRevision !== undefined)).toBe(false);
    const setGrant = (revision: number, capabilities: "suggest"[]) =>
      d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision, capabilities } });

    // A legacy record whose grant has named `suggest` ever since still works, and so does one after suspend/resume.
    expect((await studentSees(d, PL.jules)).map((i) => i.title)).toEqual([TOPIC_B]);
    await d.ok(admin, "admin.suspendGuardian", { params: { relationshipId: gina.relationshipId as never }, body: { reason: "custody-review" } });
    expect(await studentSees(d, PL.jules)).toEqual([]);
    await d.ok(admin, "admin.resumeGuardian", { params: { relationshipId: gina.relationshipId as never } });
    expect((await studentSees(d, PL.jules)).map((i) => i.title)).toEqual([TOPIC_B]);

    // Revoke and re-grant: with no revision to prove which grant it was posted under, it stays withheld,
    // even though the clock has not moved and a grant naming `suggest` is in force again.
    await setGrant(1, []);
    await setGrant(2, ["suggest"]);
    expect((await gina.suggest("Posted under the new grant")).status).toBe(201);
    expect(await studentSees(d, PL.jules)).toEqual([]);
    const teacherView = await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params });
    expect(teacherView.suggestions.some((s) => s.topic === TOPIC_A)).toBe(false); // the waiting one is not actionable
    const approved = teacherView.suggestions.find((s) => s.topic === TOPIC_B)!;
    expect(approved).toMatchObject({ status: "shared", review: { decision: "share" } }); // teacher-only history survives
    expect(outcomeOf(await d.call(d.tokenFor(PL.jules), "student.guidanceRespond", { params: { ...params, invitationId: approved.id as never }, body: { revision: approved.revision, decision: "accepted" } }))).toBe("404 not-found");
    // The record was not rewritten or re-stamped by any of this, and only the new one carries a revision.
    const after = (await d.stores.guidance.records.list(PL.grade6)).filter((r) => r.type === "suggestion");
    expect(after.filter((r) => r.type === "suggestion" && r.grantRevision === undefined)).toHaveLength(2);
    expect(after.filter((r) => r.type === "suggestion" && r.grantRevision !== undefined)).toHaveLength(1);
    // The new grant's own suggestion works as normal.
    const fresh = (await inbox(d)).find((s) => s.topic === "Posted under the new grant")!;
    expect(outcomeOf(await review(d, fresh))).toBe("ok");
    expect((await studentSees(d, PL.jules)).map((i) => i.title)).toEqual(["Posted under the new grant"]);
  });

  it("holds across districts and never carries a student's private goal into any adult's guidance view", async () => {
    const d = await bootPilotDistrict();
    const gina = await family(d, PL.jules, "standing-guardian-4", "Gina Standing (synthetic guardian)", ["suggest", "progress"]);
    await gina.suggest(TOPIC_A);
    const queued = (await inbox(d))[0]!;
    // The student's private goal exists in the planner store; no guidance surface may echo it.
    await d.ok(d.tokenFor(PL.jules), "student.planGoal", { params, body: { goal: "PRIVATE-GOAL build a pizza tycoon", skills: [] } });
    await review(d, queued);
    await d.ok(d.tokenFor(PL.admin), "admin.suspendGuardian", { params: { relationshipId: gina.relationshipId as never }, body: { reason: "custody-review" } });
    const views = [
      await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params }),
      await d.ok(d.tokenFor(PL.jules), "student.guidance", { params }),
      await d.ok(d.tokenFor(PL.admin), "admin.guardianGuidance", { params: { studentId: PL.jules as never } }),
    ];
    expect(JSON.stringify(views)).not.toContain("PRIVATE-GOAL");
    // A suspended guardian is told nothing that distinguishes the child from one that does not exist.
    expect(outcomeOf(await d.call(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } }))).toBe("404 not-found");

    // Another district's people and tokens reach nothing here, with or without standing.
    const other = await bootPilotDistrict({ directory: RIVERBEND });
    const foreignAdmin = other.tokenFor(RIVERBEND.roleAssignments.find((r) => r.role === "district-admin")!.principalId);
    expect(outcomeOf(await other.call(foreignAdmin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["suggest"] } }))).toBe("404 not-found");
    expect(outcomeOf(await other.call(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } }))).toBe("401 unauthenticated");
    expect(["403 forbidden", "404 not-found"]).toContain(outcomeOf(await other.call(foreignAdmin, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: queued.id as never }, body: { revision: queued.revision, decision: "share" } })));
  });
});
