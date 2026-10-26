// Guardian access over the HTTP surface (ADR-0012, SCHO-188): onboarding through an invitation,
// and isolation of everything a guardian is not allowed to read or do.
import { describe, expect, it } from "vitest";
import { bootDistrict, expectError, NF, NORTHFIELD, RIVERBEND, studentSubmitsEssay, teacherSetsUpEssay, type TestDistrict } from "./support.ts";

/** A district on a clock the test moves. */
async function district(directory = undefined as Parameters<typeof bootDistrict>[0]) {
  const clock = { now: new Date() };
  const booted = await bootDistrict(directory, { now: () => clock.now });
  return { ...booted, clock };
}

/** The token in an invitation link's fragment. */
const tokenIn = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("invitation")!;

/**
 * Onboards a guardian of `studentId` end to end, as the three decisions ADR-0012 asks for: an
 * invitation, the guardian's sign-in approved, the relationship confirmed. Returns the guardian's
 * token and what was created.
 */
async function onboard(d: TestDistrict, studentId: string, subject: string, terms: Record<string, unknown> = {}) {
  const admin = d.tokenFor(NF.admin);
  const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId }, body: { guardianDisplayName: `Guardian ${subject}`, ...terms } });
  const guardian = d.idp.issue(subject);
  expect(await d.ok(guardian, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } })).toEqual({ outcome: "awaiting-approval" });
  const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: { studentId } });
  const signIn = pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!;
  await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: signIn.requestId } });
  await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  return { guardian, invited, guardianId: invited.invitation.reservedGuardianPrincipalId, relationshipId: invited.relationship.id };
}

describe("guardian onboarding over HTTP", () => {
  it("invites, approves the sign-in and confirms the relationship as three decisions, granting nothing before the last", async () => {
    const d = await district();
    const admin = d.tokenFor(NF.admin);
    const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "Gina Okafor" } });
    expect(invited.delivery).toBe("share-link");
    expect(new URL(invited.invitationUrl).pathname).toBe("/family/invitation");
    // The token travels in the fragment, and is never stored or listed.
    expect(new URL(invited.invitationUrl).search).toBe("");
    expect(JSON.stringify(await d.ok(admin, "admin.studentGuardians", { params: { studentId: NF.amara } }))).not.toContain(tokenIn(invited.invitationUrl));

    const gina = d.idp.issue("gina-okafor");
    expectError(await d.call(gina, "me.get"), 401, "unauthenticated");
    expectError(await d.call(undefined, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } }), 401, "unauthenticated");
    expect(await d.ok(gina, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } })).toEqual({ outcome: "awaiting-approval" });
    // Single use, whoever tries next.
    expectError(await d.call(d.idp.issue("someone-else"), "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } }), 404, "not-found");
    expectError(await d.call(gina, "guardian.listChildren"), 401, "unauthenticated");

    const overview = await d.ok(admin, "admin.studentGuardians", { params: { studentId: NF.amara } });
    expect(overview.relationships.map((r) => [r.relationship.status, r.guardianActive])).toEqual([["pending", false]]);
    expectError(await d.call(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } }), 409, "conflict");
    // The administrator sees which sign-in used the link, not only the name they invited under (SCHO-221).
    expect(overview.pendingSignIns).toEqual([{
      requestId: expect.any(String),
      invitationId: invited.invitation.id,
      guardianDisplayName: "Gina Okafor",
      signIn: { issuer: NORTHFIELD.district.trustedIssuers[0], subject: "gina-okafor" },
      requestedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    }]);

    await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: overview.pendingSignIns[0]!.requestId } });
    expect(await d.ok(gina, "me.get")).toMatchObject({ kind: "guardian", displayName: "Gina Okafor", roles: [], enrollments: [] });
    expect(await d.ok(gina, "guardian.listChildren")).toEqual([]);
    expectError(await d.call(gina, "guardian.childOfferings", { params: { studentId: NF.amara } }), 404, "not-found");

    await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
    expect(await d.ok(gina, "guardian.listChildren")).toEqual([{ studentPrincipalId: NF.amara, displayName: "Amara Okafor" }]);
    const after = await d.ok(admin, "admin.studentGuardians", { params: { studentId: NF.amara } });
    expect(after.pendingSignIns).toEqual([]);
    expect(after.relationships[0]!.history.map((e) => e.action)).toEqual(["guardian-relationship.recorded", "guardian-relationship.confirmed"]);
  });

  it("names the child and school before accepting, and tells a sign-in awaiting approval to wait (SCHO-222)", async () => {
    const d = await district();
    const admin = d.tokenFor(NF.admin);
    const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "Gina Okafor" } });
    const token = tokenIn(invited.invitationUrl);
    const gina = d.idp.issue("gina-okafor");

    // Amara takes classes at one school, so the invitation names it. Previewing spends nothing.
    const preview = await d.ok(gina, "onboarding.previewGuardianInvitation", { body: { token } });
    expect(preview.studentDisplayName).toBe("Amara Okafor");
    expect(preview.schoolName).not.toBe("");
    expect(await d.ok(gina, "onboarding.previewGuardianInvitation", { body: { token } })).toEqual(preview);
    expectError(await d.call(undefined, "onboarding.previewGuardianInvitation", { body: { token } }), 401, "unauthenticated");
    expectError(await d.call(gina, "onboarding.previewGuardianInvitation", { body: { token: "x".repeat(43) } }), 404, "not-found");

    // Before redeeming, the sign-in is simply unlinked.
    const before = await d.call(gina, "me.get");
    expectError(before, 401, "unauthenticated");
    expect((before.body as { unlinkedSignIn?: { awaitingApproval?: true } }).unlinkedSignIn?.awaitingApproval).toBeUndefined();

    await d.ok(gina, "onboarding.redeemGuardianInvitation", { body: { token } });
    // A spent link previews as nothing, exactly as it redeems.
    expectError(await d.call(gina, "onboarding.previewGuardianInvitation", { body: { token } }), 404, "not-found");
    const waiting = await d.call(gina, "me.get");
    expectError(waiting, 401, "unauthenticated");
    expect((waiting.body as { unlinkedSignIn: unknown }).unlinkedSignIn).toMatchObject({ subject: "gina-okafor", awaitingApproval: true });
    // Someone else's sign-in is not marked by Gina's request.
    const other = await d.call(d.idp.issue("someone-else"), "me.get");
    expect((other.body as { unlinkedSignIn?: { awaitingApproval?: true } }).unlinkedSignIn?.awaitingApproval).toBeUndefined();

    // Once decided, the request no longer marks the sign-in.
    const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: { studentId: NF.amara } });
    await d.ok(admin, "admin.rejectIdentityRequest", { params: { requestId: pendingSignIns[0]!.requestId } });
    const rejected = await d.call(gina, "me.get");
    expect((rejected.body as { unlinkedSignIn?: { awaitingApproval?: true } }).unlinkedSignIn?.awaitingApproval).toBeUndefined();
  });

  it("lets only a district administrator invite, review or decide", async () => {
    const d = await district();
    const { relationshipId } = await onboard(d, NF.amara, "gina");
    for (const who of [NF.rivera, "prn_nf-principal-high"]) {
      const token = d.tokenFor(who);
      expectError(await d.call(token, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "X" } }), 403, "forbidden");
      expectError(await d.call(token, "admin.studentGuardians", { params: { studentId: NF.amara } }), 403, "forbidden");
      expectError(await d.call(token, "admin.guardianStudents"), 403, "forbidden");
      expectError(await d.call(token, "admin.revokeGuardian", { params: { relationshipId } }), 403, "forbidden");
    }
    // A student is refused the admin surface outright.
    expectError(await d.call(d.tokenFor(NF.amara), "admin.studentGuardians", { params: { studentId: NF.amara } }), 403, "forbidden");
  });
});

describe("what a guardian sees", () => {
  it("shows the child's classes, assignments and due dates, and feedback and grades only once the child has them", async () => {
    const d = await district();
    const { guardian, guardianId, relationshipId } = await onboard(d, NF.amara, "gina");
    const { assignment } = await teacherSetsUpEssay(d);
    const amara = d.tokenFor(NF.amara);
    const rivera = d.tokenFor(NF.rivera);

    const offerings = await d.ok(guardian, "guardian.childOfferings", { params: { studentId: NF.amara } });
    // Her completed spring class is listed too, as it is for her, with its term.
    expect(offerings.map((o) => o.offering.id).toSorted()).toEqual([NF.bio, NF.bioSpring, NF.eng9].toSorted());
    expect(offerings.find((o) => o.offering.id === NF.bioSpring)!.term.state).toBe("completed");
    expect(offerings.find((o) => o.offering.id === NF.eng9)!.course.title).toBe("English 9");

    const { receipt } = await studentSubmitsEssay(d, assignment.id, amara);
    await d.ok(rivera, "teacher.runCi", { params: { submissionId: receipt.submissionId } });
    await d.ok(rivera, "teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Strong claim; add a counterclaim." } });

    const before = await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    expect(before.assignments.map((a) => [a.assignment.id, a.assignment.title, a.assignment.dueAt])).toEqual([[assignment.id, assignment.title, assignment.dueAt]]);
    // Unreleased feedback is not shown, as it is not shown to Amara.
    expect(before.assignments[0]!.feedback).toEqual([]);
    expect(before.assignments[0]!.grades).toEqual([]);

    await d.ok(rivera, "teacher.releaseFeedback", { params: { submissionId: receipt.submissionId }, body: { state: "shared-with-student" } });
    await d.ok(rivera, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 8, maxPoints: 10 } } });
    const after = await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    const childSees = await d.ok(amara, "student.getFeedback", { params: { submissionId: receipt.submissionId } });
    // Exactly what Amara sees: the teacher's comment, never the evaluator's suggestions.
    expect(after.assignments[0]!.feedback).toEqual([childSees]);
    expect(after.assignments[0]!.feedback[0]!.scores).toEqual([]);
    expect(after.assignments[0]!.grades).toEqual(await d.ok(amara, "student.officialGrades", { params: { assignmentId: assignment.id } }));

    // Every read was decided for the guardian and audited with the relationship that allowed it.
    const reads = d.audit.events().filter((e) => e.principalId === guardianId && e.effect === "allow");
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((e) => [e.ruleId, e.grantId].join(" ")))).toEqual(new Set([`guardian.child.read ${relationshipId}`]));
  });

  it("shows the class's published announcements where the relationship's scope covers them (SCHO-222)", async () => {
    const d = await district();
    const { guardian, relationshipId } = await onboard(d, NF.amara, "gina");
    const rivera = d.tokenFor(NF.rivera);
    await d.ok(rivera, "teacher.createAnnouncement", { params: { offeringId: NF.eng9 }, body: { title: "Library visit", body: "Bring your card." } });
    await d.ok(rivera, "teacher.createAnnouncement", {
      params: { offeringId: NF.eng9 },
      body: { title: "Next month", body: "Not yet.", publishAt: new Date(d.clock.now.getTime() + 30 * 86_400_000).toISOString() },
    });

    const course = await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    // Published ones only, as Amara sees them.
    expect(course.announcements.map((a) => a.title)).toEqual(["Library visit"]);
    expect(course.announcements.map((a) => a.id)).toEqual((await d.ok(d.tokenFor(NF.amara), "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).map((v) => v.announcement.id));

    await d.ok(d.tokenFor(NF.admin), "admin.updateGuardianScope", { params: { relationshipId }, body: { readableKinds: ["offering", "activity", "feedback", "official-grade"] } });
    expect((await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } })).announcements).toEqual([]);
  });

  it("follows the relationship's scope: withheld grades, and only the named offerings", async () => {
    const d = await district();
    const { guardian, relationshipId } = await onboard(d, NF.amara, "gina");
    const admin = d.tokenFor(NF.admin);
    const { assignment } = await teacherSetsUpEssay(d);
    const { receipt } = await studentSubmitsEssay(d, assignment.id);
    await d.ok(d.tokenFor(NF.rivera), "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 8, maxPoints: 10 } } });

    await d.ok(admin, "admin.updateGuardianScope", { params: { relationshipId }, body: { readableKinds: ["offering", "activity", "feedback"] } });
    expect((await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } })).assignments[0]!.grades).toEqual([]);

    await d.ok(admin, "admin.updateGuardianScope", { params: { relationshipId }, body: { readableKinds: ["offering", "activity", "feedback", "official-grade"], offeringIds: [NF.bio] } });
    expect((await d.ok(guardian, "guardian.childOfferings", { params: { studentId: NF.amara } })).map((o) => o.offering.id)).toEqual([NF.bio]);
    expectError(await d.call(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } }), 404, "not-found");
  });
});

describe("guardian isolation", () => {
  it("never reaches a sibling or another family's child, whichever IDs are asked for", async () => {
    const d = await district();
    const gina = await onboard(d, NF.amara, "gina");
    const gus = await onboard(d, NF.elena, "gus");
    for (const [guardian, other] of [[gina.guardian, NF.elena], [gus.guardian, NF.amara]] as const) {
      expectError(await d.call(guardian, "guardian.childOfferings", { params: { studentId: other } }), 404, "not-found");
      expectError(await d.call(guardian, "guardian.childCourse", { params: { studentId: other, offeringId: NF.eng9 } }), 404, "not-found");
    }
    // An unknown student and a staff member answer the same.
    expectError(await d.call(gina.guardian, "guardian.childOfferings", { params: { studentId: "prn_nf-nobody" } }), 404, "not-found");
    expectError(await d.call(gina.guardian, "guardian.childOfferings", { params: { studentId: NF.rivera } }), 404, "not-found");
    // A class the child does not take answers not-found, even one a sibling takes.
    expectError(await d.call(gina.guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: "off_nf-ushist-fall-p5" } }), 404, "not-found");
  });

  it("stops at once when the relationship is suspended, revoked or expires, and never while it is pending", async () => {
    const d = await district();
    const admin = d.tokenFor(NF.admin);
    const { guardian, relationshipId } = await onboard(d, NF.amara, "gina");
    const sees = async () => (await d.ok(guardian, "guardian.listChildren")).length;
    expect(await sees()).toBe(1);

    await d.ok(admin, "admin.suspendGuardian", { params: { relationshipId }, body: { reason: "court-order-review" } });
    expect(await sees()).toBe(0);
    expectError(await d.call(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } }), 404, "not-found");
    expectError(await d.call(admin, "admin.suspendGuardian", { params: { relationshipId }, body: { reason: "Free text about the family" } }), 400, "validation-failed");
    await d.ok(admin, "admin.resumeGuardian", { params: { relationshipId } });
    expect(await sees()).toBe(1);

    await d.ok(admin, "admin.revokeGuardian", { params: { relationshipId } });
    expect(await sees()).toBe(0);
    expectError(await d.call(admin, "admin.confirmGuardian", { params: { relationshipId } }), 409, "conflict");

    // A relationship that ends on its own.
    const dated = await onboard(d, NF.elena, "gus", { validUntil: new Date(d.clock.now.getTime() + 86_400_000).toISOString() });
    expect((await d.ok(dated.guardian, "guardian.listChildren")).length).toBe(1);
    d.clock.now = new Date(d.clock.now.getTime() + 2 * 86_400_000);
    expect(await d.ok(dated.guardian, "guardian.listChildren")).toEqual([]);
    expectError(await d.call(dated.guardian, "guardian.childOfferings", { params: { studentId: NF.elena } }), 404, "not-found");
  });

  it("refuses every write and every other surface to a guardian", async () => {
    const d = await district();
    const { guardian } = await onboard(d, NF.amara, "gina");
    const { assignment } = await teacherSetsUpEssay(d);
    const { receipt, workspace } = await studentSubmitsEssay(d, assignment.id);
    for (const result of [
      await d.call(guardian, "student.listWorkspaces"),
      await d.call(guardian, "student.openPersonalWorkspace"),
      await d.call(guardian, "student.listArtifacts", { params: { workspaceId: workspace.id } }),
      await d.call(guardian, "student.listSubmissions", { params: { assignmentId: assignment.id } }),
      await d.call(guardian, "student.getFeedback", { params: { submissionId: receipt.submissionId } }),
      await d.call(guardian, "student.submit", { params: { assignmentId: assignment.id }, body: { revisions: [receipt.items[0]!] } }),
      await d.call(guardian, "teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Great!" } }),
      await d.call(guardian, "teacher.listOfferings"),
      await d.call(guardian, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "Another" } }),
      await d.call(guardian, "admin.confirmGuardian", { params: { relationshipId: "grl_x" } }),
    ]) {
      expectError(result, 403, "forbidden");
    }
    // Nor does a guardian get the guardian surface's answers by being a student or staff member.
    expectError(await d.call(d.tokenFor(NF.amara), "guardian.listChildren"), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.rivera), "guardian.childOfferings", { params: { studentId: NF.amara } }), 403, "forbidden");
  });

  // Discussions (SCHO-190). Guardians are not given discussions (ADR-0012): not the class's topics,
  // not their own child's posts, and nothing to write, report or moderate.
  it("gives a guardian no discussion, even of a class their child takes and posts in", async () => {
    const d = await district();
    const { guardian, guardianId } = await onboard(d, NF.amara, "gina");
    const rivera = d.tokenFor(NF.rivera);
    const topic = await d.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Warm-up", prompt: "Say hi." } });
    const post = await d.ok(d.tokenFor(NF.amara), "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Hello from Amara" } });
    const at = { offeringId: NF.eng9, topicId: topic.id };
    const on = { offeringId: NF.eng9, postId: post.id };
    for (const result of [
      await d.call(guardian, "student.listDiscussions", { params: { offeringId: NF.eng9 } }),
      await d.call(guardian, "student.discussionThread", { params: at }),
      await d.call(guardian, "student.createPost", { params: at, body: { body: "Hi from Gina" } }),
      await d.call(guardian, "student.editPost", { params: on, body: { body: "Edited by Gina" } }),
      await d.call(guardian, "student.deletePost", { params: on }),
      await d.call(guardian, "student.reportPost", { params: on, body: { reason: "unkind" } }),
      await d.call(guardian, "teacher.listDiscussions", { params: { offeringId: NF.eng9 } }),
      await d.call(guardian, "teacher.discussionThread", { params: at }),
      await d.call(guardian, "teacher.moderationQueue", { params: { offeringId: NF.eng9 } }),
      await d.call(guardian, "teacher.moderatePost", { params: on, body: { decision: "hide" } }),
      await d.call(guardian, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Mine", prompt: "x" } }),
    ]) {
      expectError(result, 403, "forbidden");
    }
    // The family view of the child's class carries none of it either.
    const course = await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    expect(JSON.stringify(course)).not.toMatch(/Warm-up|Say hi|Hello from Amara/);
    // No decision ever allowed the guardian a discussion topic or post.
    const discussionReads = d.audit.events().filter((e) => e.principalId === guardianId && e.effect === "allow" && e.ruleId.startsWith("discussion."));
    expect(discussionReads).toEqual([]);
    // The thread is untouched.
    expect((await d.ok(rivera, "teacher.discussionThread", { params: at })).posts.map((p) => p.id)).toEqual([post.id]);
  });

  // Quizzes (SCHO-191). Guardians are not given quizzes (ADR-0012): not the quiz, not their child's
  // attempts, and nothing to take or grade. A released score reaches them only as the official grade.
  it("gives a guardian no quiz or attempt, only the official grade a release made", async () => {
    const d = await district();
    const { guardian, guardianId } = await onboard(d, NF.amara, "gina");
    const rivera = d.tokenFor(NF.rivera);
    const { assignment } = await teacherSetsUpEssay(d, rivera);
    const draft = await d.ok(rivera, "teacher.createQuiz", {
      params: { offeringId: NF.eng9 },
      body: { title: "Poetry terms", assignmentId: assignment.id, items: [{ type: "true-false", prompt: "A sonnet has 14 lines.", points: 2, correct: true }] },
    });
    const quiz = await d.ok(rivera, "teacher.publishQuiz", { params: { offeringId: NF.eng9, quizId: draft.id }, body: { published: true } });
    const amara = d.tokenFor(NF.amara);
    const attempt = await d.ok(amara, "student.startQuizAttempt", { params: { offeringId: NF.eng9, quizId: quiz.id } });
    await d.ok(amara, "student.submitQuizAttempt", {
      params: { offeringId: NF.eng9, attemptId: attempt.attemptId },
      body: { answers: [{ itemId: quiz.items[0]!.id, response: { type: "true-false", value: true } }] },
    });
    const q = { offeringId: NF.eng9, quizId: quiz.id };
    const a = { offeringId: NF.eng9, attemptId: attempt.attemptId };
    for (const result of [
      await d.call(guardian, "student.listQuizzes", { params: { offeringId: NF.eng9 } }),
      await d.call(guardian, "student.getQuiz", { params: q }),
      await d.call(guardian, "student.startQuizAttempt", { params: q }),
      await d.call(guardian, "student.quizAttemptResult", { params: a }),
      await d.call(guardian, "student.submitQuizAttempt", { params: a, body: { answers: [] } }),
      await d.call(guardian, "teacher.getQuiz", { params: q }),
      await d.call(guardian, "teacher.quizResults", { params: q }),
      await d.call(guardian, "teacher.quizAttempt", { params: a }),
      await d.call(guardian, "teacher.releaseQuizScores", { params: q, body: {} }),
    ]) {
      expectError(result, 403, "forbidden");
    }
    const gradesOf = async () => (await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } }))
      .assignments.find((entry) => entry.assignment.id === assignment.id)!.grades;
    // Before release the guardian sees no score; after it, the official grade and nothing of the quiz.
    expect(await gradesOf()).toEqual([]);
    await d.ok(rivera, "teacher.releaseQuizScores", { params: q, body: {} });
    expect((await gradesOf()).map((g) => g.score)).toEqual([{ points: 2, maxPoints: 2 }]);
    const course = await d.ok(guardian, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    expect(JSON.stringify(course)).not.toMatch(/sonnet has 14 lines|qza_/);
    expect(d.audit.events().filter((e) => e.principalId === guardianId && e.effect === "allow" && e.ruleId.startsWith("quiz."))).toEqual([]);
  });

  it("keeps districts apart: a Northfield guardian is no one at Riverbend, and Riverbend cannot manage Northfield's students", async () => {
    const northfield = await district();
    const riverbend = await district(RIVERBEND);
    const { guardian } = await onboard(northfield, NF.amara, "gina");
    expectError(await riverbend.call(guardian, "guardian.listChildren"), 401, "unauthenticated");
    const rbAdmin = riverbend.tokenFor(RIVERBEND.roleAssignments.find((r) => r.role === "district-admin")!.principalId);
    expectError(await riverbend.call(rbAdmin, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "X" } }), 400, "validation-failed");
    expectError(await riverbend.call(rbAdmin, "admin.studentGuardians", { params: { studentId: NF.amara } }), 404, "not-found");
    // A Northfield invitation means nothing at Riverbend.
    const invited = await northfield.ok(northfield.tokenFor(NF.admin), "admin.inviteGuardian", { params: { studentId: NF.elena }, body: { guardianDisplayName: "Gus" } });
    expectError(await riverbend.call(riverbend.idp.issue("gus"), "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } }), 404, "not-found");
  });

  it("lets an existing guardian add a sibling by redeeming a second invitation, without a second sign-in approval", async () => {
    const d = await district();
    const admin = d.tokenFor(NF.admin);
    const { guardian } = await onboard(d, NF.amara, "gina");
    const second = await d.ok(admin, "admin.inviteGuardian", { params: { studentId: NF.elena }, body: { guardianDisplayName: "Gina" } });
    expect(await d.ok(guardian, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(second.invitationUrl) } })).toEqual({ outcome: "joined" });
    expect((await d.ok(guardian, "guardian.listChildren")).length).toBe(1);
    await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: second.relationship.id } });
    expect((await d.ok(guardian, "guardian.listChildren")).map((c) => c.studentPrincipalId).toSorted()).toEqual([NF.amara, NF.elena].toSorted());
  });
});
