/// <reference types="node" />
// Guidance and Evidence: guardian opt-in, learning invitations, teacher coverage and CASEL practice.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PrincipalId } from "@educateos/contracts";
import { nextGuardianGuidanceGrant } from "@educateos/policy";
import { DurableObjectGuardianGuidanceGrantStore, DurableObjectGuidanceStore, type DistrictSqlStorage } from "../src/durable-stores.ts";
import type { PlannerPlan } from "../src/planner.ts";
import { InMemoryGuidanceStore, PLANNER_EVIDENCE_CODES, type GuidanceRecord } from "../src/guidance.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RIVERBEND, type TestDistrict } from "./support.ts";

const gradeSix = () => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) });
const params = { offeringId: NF.eng9 };
const tokenIn = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("invitation")!;
const AMARA = PrincipalId.parse(NF.amara);
const ELENA = PrincipalId.parse(NF.elena);

async function setup() {
  const clock = { now: new Date("2026-11-15T12:00:00Z") };
  const d = await bootDistrict(gradeSix(), { now: () => clock.now });
  return { d, clock };
}

/** Onboards a guardian end to end (invitation, sign-in approval, confirmation). Opens no guidance. */
async function onboard(d: TestDistrict, studentId: string, subject: string) {
  const admin = d.tokenFor(NF.admin);
  const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId: PrincipalId.parse(studentId) }, body: { guardianDisplayName: `Guardian ${subject}` } });
  const guardian = d.idp.issue(subject);
  await d.ok(guardian, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } });
  const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: { studentId: PrincipalId.parse(studentId) } });
  await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!.requestId } });
  await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  return { guardian, relationshipId: invited.relationship.id, guardianId: invited.invitation.reservedGuardianPrincipalId };
}
const enable = (d: TestDistrict, relationshipId: string, capabilities: ("suggest" | "progress")[], revision = 0) =>
  d.ok(d.tokenFor(NF.admin), "admin.setGuardianGuidance", { params: { relationshipId: relationshipId as never }, body: { revision, capabilities } });
const childParams = (studentId: PrincipalId) => ({ studentId });
const suggest = (d: TestDistrict, guardian: string, studentId: PrincipalId, topic = "Space exploration", extra: Record<string, unknown> = {}) =>
  d.call(guardian, "guardian.guidanceSuggest", { params: { studentId, offeringId: NF.eng9 as never }, body: { kind: "curiosity", topic, ...extra } });
const inEng9 = (view: { offerings: { offeringId: string }[] }) => view.offerings.find((o) => o.offeringId === NF.eng9)! as typeof view.offerings[number] & { suggestions?: { id: string; revision: number; status: string; topic: string }[]; progress?: unknown[] };
const codeOf = (r: { body: unknown }) => (r.body as { code: string }).code;

async function mathNode(d: TestDistrict, code: string) {
  const goals = await d.ok(d.tokenFor(NF.rivera), "teacher.learningGoals", { params });
  const goal = goals.goals.find((g) => g.code === code);
  if (goal === undefined) throw new Error(`no ${code}`);
  return { frameworkKey: goal.frameworkKey, competencyUri: goal.competencyUri };
}
const prioritise = async (d: TestDistrict, codes: [string, "focus" | "supporting"][]) =>
  d.ok(d.tokenFor(NF.rivera), "teacher.guidanceAgenda", {
    params, body: { revision: 0, priorities: await Promise.all(codes.map(async ([code, level]) => ({ ...(await mathNode(d, code)), level }))) },
  });

/** Practice remains separate from the unseen assessment performed by the teacher. */
async function independentPractice(d: TestDistrict, plan: PlannerPlan, opportunityId: string) {
  const target = { ...params, planId: plan.id, opportunityId };
  const student = d.tokenFor(NF.amara);
  const started = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: plan.revision, action: "try", allowAi: false } });
  return d.ok(student, "student.plannerChallenge", { params: target, body: { revision: started.revision, text: "A new claim with credible supporting sources, reasons and a conclusion.", reflection: "I can explain this in another project.", assistance: "independent" } });
}
const unseenAssessment = (plan: PlannerPlan, opportunityId: string) => ({ method: "independent-task" as const, observedAt: plan.opportunities.find((o) => o.id === opportunityId)!.challenge!.sharedAt, context: "Teacher selected a separate unseen argument task and observed every criterion independently." });

describe("guardian opt-in is explicit, per relationship and off by default", () => {
  it("gives a confirmed guardian nothing until an administrator enables it, including for new relationships", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    const view = await d.ok(gina.guardian, "guardian.guidance", { params: childParams(AMARA) });
    expect(view).toMatchObject({ capabilities: { suggest: false, progress: false }, offerings: [] });
    expectError(await suggest(d, gina.guardian, AMARA), 403, "forbidden");
    // The relationship record is untouched by the feature: still the five read-only kinds.
    const record = await d.stores.guardianRelationships.get(gina.relationshipId as never);
    expect(record!.readableKinds).toEqual(["offering", "activity", "feedback", "official-grade", "announcement"]);
    // A second guardian onboarded later starts closed as well, whatever the first one was given.
    await enable(d, gina.relationshipId, ["suggest"]);
    const later = await onboard(d, NF.amara, "grace");
    expect((await d.ok(later.guardian, "guardian.guidance", { params: childParams(AMARA) })).capabilities).toEqual({ suggest: false, progress: false });
    expectError(await suggest(d, later.guardian, AMARA), 403, "forbidden");
    expect((await suggest(d, gina.guardian, AMARA)).status).toBe(201);
    expect((await d.stores.guardianRelationships.get(gina.relationshipId as never))!.readableKinds).toEqual(record!.readableKinds);
  });

  it("is managed only by a district administrator, with a revision-checked, audited history", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    for (const who of [NF.rivera, NF.amara, NF.morgan]) {
      expectError(await d.call(d.tokenFor(who), "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["suggest"] } }), 403, "forbidden");
    }
    expectError(await d.call(gina.guardian, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["suggest"] } }), 403, "forbidden");
    await enable(d, gina.relationshipId, ["suggest"]);
    expectError(await d.call(d.tokenFor(NF.admin), "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["progress"] } }), 409, "conflict");
    await enable(d, gina.relationshipId, ["suggest", "progress"], 1);
    const after = await enable(d, gina.relationshipId, [], 2);
    expect(after.relationships[0]).toMatchObject({ enabled: false, revision: 3 });
    expect(after.relationships[0]!.history.map((h) => h.action)).toEqual(["enabled", "changed", "revoked"]);
    expectError(await suggest(d, gina.guardian, AMARA), 403, "forbidden");
  });

  it("never reaches another district's relationship", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    const rb = await bootDistrict(RIVERBEND);
    expectError(await rb.call(rb.tokenFor(RIVERBEND.roleAssignments.find((r) => r.role === "district-admin")!.principalId), "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["suggest"] } }), 404, "not-found");
  });

  it("stops when the relationship is suspended or revoked, and keeps other families apart", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    const gus = await onboard(d, NF.elena, "gus");
    await enable(d, gina.relationshipId, ["suggest", "progress"]);
    await enable(d, gus.relationshipId, ["suggest", "progress"]);
    // Wrong guardian / wrong child: not found, as if the child did not exist.
    expectError(await d.call(gus.guardian, "guardian.guidance", { params: childParams(AMARA) }), 404, "not-found");
    expectError(await suggest(d, gus.guardian, AMARA), 404, "not-found");
    expectError(await d.call(gina.guardian, "guardian.guidance", { params: childParams(ELENA) }), 404, "not-found");
    // Wrong class: Amara is not enrolled in Math 7.
    expectError(await d.call(gina.guardian, "guardian.guidanceSuggest", { params: { studentId: AMARA, offeringId: "off_nf-math7-fall-p1" as never }, body: { kind: "hobby", topic: "Chess" } }), 404, "not-found");
    await d.ok(d.tokenFor(NF.admin), "admin.suspendGuardian", { params: { relationshipId: gina.relationshipId as never }, body: { reason: "custody-review" } });
    expectError(await d.call(gina.guardian, "guardian.guidance", { params: childParams(AMARA) }), 404, "not-found");
    expectError(await suggest(d, gina.guardian, AMARA), 404, "not-found");
    expect((await suggest(d, gus.guardian, ELENA)).status).toBe(201);
  });

  it("audits every guardian decision under the relationship and the dedicated rule", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["suggest"]);
    await suggest(d, gina.guardian, AMARA);
    const allowed = d.audit.events().filter((e) => e.principalId === gina.guardianId && e.ruleId === "guardian.child.learning-guidance" && e.effect === "allow");
    expect(allowed.length).toBeGreaterThan(0);
    expect(new Set(allowed.map((e) => e.grantId))).toEqual(new Set([gina.relationshipId]));
  });
});

describe("a guardian suggestion is never an assignment and never reaches the student unreviewed", () => {
  it("flows guardian → teacher → student with its origin, and the student's choice stays theirs", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["suggest", "progress"]);
    const before = await d.stores.assessment.load();
    expect((await suggest(d, gina.guardian, AMARA, "Rockets and space travel", { note: "She loves the planetarium." })).status).toBe(201);
    const student = d.tokenFor(NF.amara);
    expect((await d.ok(student, "student.guidance", { params })).invitations).toEqual([]);
    const teacher = d.tokenFor(NF.rivera);
    const inbox = (await d.ok(teacher, "teacher.guidance", { params })).suggestions;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ status: "awaiting-teacher", studentName: "Amara Okafor", topic: "Rockets and space travel" });
    const shared = await d.ok(teacher, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: inbox[0]!.id }, body: { revision: inbox[0]!.revision, decision: "share" } });
    expect(shared.suggestions[0]!.status).toBe("shared");
    const mine = (await d.ok(student, "student.guidance", { params })).invitations;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "suggestion", isAssignment: false, required: false, type: "family-topic", origin: { kind: "guardian", name: "Guardian gina" }, decision: "pending" });
    // Accepting is visible to the teacher; the guardian only ever sees the status of what they sent.
    await d.ok(student, "student.guidanceRespond", { params: { ...params, invitationId: mine[0]!.id as never }, body: { revision: mine[0]!.revision!, decision: "accepted" } });
    expect((await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!.studentAccepted).toBe(true);
    const family = await d.ok(gina.guardian, "guardian.guidance", { params: childParams(AMARA) });
    expect(JSON.stringify(family)).not.toMatch(/accepted|declined/i);
    expect(inEng9(family).suggestions![0]).toMatchObject({ status: "shared", topic: "Rockets and space travel" });
    // No assignment, due date or grade was created anywhere.
    expect(await d.stores.assessment.load()).toEqual(before);
    expect(JSON.stringify(mine)).not.toMatch(/dueAt|grade/i);
  });

  it("keeps a decline private from the teacher and the family, and lets the student switch family suggestions off", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["suggest"]);
    await suggest(d, gina.guardian, AMARA, "Skateboarding");
    const teacher = d.tokenFor(NF.rivera);
    const student = d.tokenFor(NF.amara);
    const inbox = (await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!;
    await d.ok(teacher, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: inbox.id }, body: { revision: inbox.revision, decision: "share" } });
    const inv = (await d.ok(student, "student.guidance", { params })).invitations[0]!;
    await d.ok(student, "student.guidanceRespond", { params: { ...params, invitationId: inv.id as never }, body: { revision: inv.revision!, decision: "declined" } });
    const seenByTeacher = JSON.stringify(await d.ok(teacher, "teacher.guidance", { params }));
    expect(seenByTeacher).not.toMatch(/declined"?:\s*true|"decision":"declined"/);
    expect((await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!.studentAccepted).toBe(false);
    // Off hides family suggestions from the student and stops new ones, without telling the family why.
    const pref = await d.ok(student, "student.guidancePreference", { body: { revision: 0, guardianSuggestions: "off" } });
    expect(pref).toEqual({ guardianSuggestions: "off", revision: 1 });
    expect((await d.ok(student, "student.guidance", { params })).invitations).toEqual([]);
    const refused = await suggest(d, gina.guardian, AMARA, "Chess club");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toMatch(/switched|off|opted/i);
  });

  it("rejects links and contact details, caps open suggestions, lets a guardian withdraw, and expires waits", async () => {
    const { d, clock } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["suggest"]);
    for (const topic of ["see https://example.com/x", "call 555-123-4567", "mail me@home.org"]) expect((await suggest(d, gina.guardian, AMARA, topic)).status).toBe(400);
    for (const topic of ["One", "Two", "Three"]) expect((await suggest(d, gina.guardian, AMARA, topic)).status).toBe(201);
    expect(codeOf(await suggest(d, gina.guardian, AMARA, "Four"))).toBe("conflict");
    const offering = inEng9(await d.ok(gina.guardian, "guardian.guidance", { params: childParams(AMARA) }));
    await d.ok(gina.guardian, "guardian.guidanceWithdraw", { params: { studentId: AMARA, offeringId: NF.eng9 as never, suggestionId: offering.suggestions![0]!.id as never }, body: {} });
    expect((await suggest(d, gina.guardian, AMARA, "Four")).status).toBe(201);
    clock.now = new Date(clock.now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect((await d.ok(d.tokenFor(NF.rivera), "teacher.guidance", { params })).suggestions).toEqual([]);
    expect(inEng9(await d.ok(gina.guardian, "guardian.guidance", { params: childParams(AMARA) })).suggestions).toEqual([]);
  });

  it("lets only teachers of the class review a suggestion", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["suggest"]);
    await suggest(d, gina.guardian, AMARA);
    const s = (await d.ok(d.tokenFor(NF.rivera), "teacher.guidance", { params })).suggestions[0]!;
    const body = { revision: s.revision, decision: "share" as const };
    for (const token of [d.tokenFor(NF.morgan), d.tokenFor(NF.admin), d.tokenFor(NF.amara), gina.guardian]) {
      expectError(await d.call(token, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: s.id }, body }), 403, "forbidden");
    }
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: s.id }, body: { ...body, revision: 9 } }), 409, "conflict");
  });
});

describe("teacher coverage separates opportunities from mastery", () => {
  it("shows explicit unmapped and no-pathway states for standards", async () => {
    const { d } = await setup();
    const teacher = d.tokenFor(NF.rivera);
    const other = (await d.ok(teacher, "teacher.learningGoals", { params })).goals.find((g) => !PLANNER_EVIDENCE_CODES.has(g.code))!;
    const agenda = await d.ok(teacher, "teacher.guidanceAgenda", { params, body: { revision: 0, priorities: [
      { ...(await mathNode(d, "W.6.1")), level: "focus", pacing: { startsOn: "2026-11-16", endsOn: "2026-12-04" }, discussionPrompt: "Which oven would you buy, and why?" },
      { frameworkKey: other.frameworkKey, competencyUri: other.competencyUri, level: "supporting" },
    ] } });
    expect(agenda.coverage.map((r) => [r.code, r.evidencePathway, r.state])).toEqual([["W.6.1", "planner", "approved"], [other.code, "none", "approved"]]);
    expect(agenda.coverage[0]).toMatchObject({ roster: 2, mastery: { "needs-evidence": 2 }, provenance: "derived", priority: { level: "focus", discussionPrompt: "Which oven would you buy, and why?" } });
    // A standard the district has not approved cannot be prioritised; one later withdrawn is shown, not hidden.
    expect((await d.call(teacher, "teacher.guidanceAgenda", { params, body: { revision: 1, priorities: [{ frameworkKey: "ccss-ela", competencyUri: "urn:not-a-standard", level: "focus" }] } })).status).toBe(400);
    expect((await d.call(teacher, "teacher.guidanceAgenda", { params, body: { revision: 0, priorities: [] } })).status).toBe(409);
    await d.ok(d.tokenFor(NF.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-ela" } });
    const withdrawn = await d.ok(teacher, "teacher.guidance", { params });
    expect(withdrawn.coverage.map((r) => r.state)).toEqual(["not-approved", "not-approved"]);
    expect(withdrawn.coverage[0]!.code).toBe("W.6.1");
  });

  it("counts only shared evidence, keeps private goals out, and never infers mastery from offers or acceptance", async () => {
    const { d } = await setup();
    const teacher = d.tokenFor(NF.rivera);
    await prioritise(d, [["W.6.1", "focus"]]);
    const amara = d.tokenFor(NF.amara);
    const elena = d.tokenFor(NF.elena);
    const plan = await d.ok(amara, "student.planGoal", { params, body: { goal: "PRIVATE Roblox pizza surprise", skills: ["planning"] } });
    // Elena plans and accepts, but shares nothing.
    const hers = await d.ok(elena, "student.planGoal", { params, body: { goal: "My secret pizza tycoon", skills: [] } });
    await d.ok(elena, "student.plannerDecision", { params: { ...params, planId: hers.id, opportunityId: hers.opportunities[1]!.id }, body: { revision: hers.revision, decision: "accepted" } });
    const math = plan.opportunities[1]!;
    const accepted = await d.ok(amara, "student.plannerDecision", { params: { ...params, planId: plan.id, opportunityId: math.id }, body: { revision: plan.revision, decision: "accepted" } });
    let dash = await d.ok(teacher, "teacher.guidance", { params });
    expect(dash.coverage[0]).toMatchObject({ mastery: { "needs-evidence": 2, encountered: 0 }, opportunities: { offered: 0, shared: 0 } });
    const sharedPlan = await d.ok(amara, "student.plannerShare", { params: { ...params, planId: plan.id, opportunityId: math.id }, body: { revision: accepted.revision, text: "My claim, two reasons, two credible sources, a conclusion. I defended it alone.", assistance: "independent" } });
    dash = await d.ok(teacher, "teacher.guidance", { params });
    expect(dash.coverage[0]).toMatchObject({ mastery: { "needs-evidence": 1, encountered: 1, practiced: 0, "independent-reviewed": 0 }, opportunities: { offered: 1, accepted: 1, shared: 1, reviewed: 0 } });
    const practiced = await independentPractice(d, sharedPlan, math.id);
    const review = { assessment: unseenAssessment(practiced, math.id), revision: practiced.revision, level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Fresh problem, oral explanation, no help." };
    await d.ok(teacher, "teacher.plannerReview", { params: { ...params, planId: plan.id, opportunityId: math.id }, body: review });
    dash = await d.ok(teacher, "teacher.guidance", { params });
    expect(dash.coverage[0]!.mastery).toEqual({ "needs-evidence": 1, "encountered": 0, "practiced": 0, "independent-reviewed": 1 });
    expect(dash.coverage).toHaveLength(1);
    expect(JSON.stringify(dash)).not.toMatch(/PRIVATE|secret pizza/);
    // A later hold supersedes the recommendation: the dashboard follows the teacher's latest word.
    const held = (await d.ok(amara, "student.planner", { params })).find((p) => p.id === plan.id)!;
    await d.ok(teacher, "teacher.plannerReview", { params: { ...params, planId: plan.id, opportunityId: math.id }, body: { ...review, revision: held.revision, level: "practiced", decision: "hold", rationale: "Needs a delayed check." } });
    expect((await d.ok(teacher, "teacher.guidance", { params })).coverage[0]!.mastery).toMatchObject({ practiced: 1, "independent-reviewed": 0 });
  });

  it("drills into the shared response without chats, goals or other classes", async () => {
    const { d } = await setup();
    const teacher = d.tokenFor(NF.rivera);
    await prioritise(d, [["W.6.1", "focus"]]);
    const amara = d.tokenFor(NF.amara);
    const plan = await d.ok(amara, "student.planGoal", { params, body: { goal: "PRIVATE intent pizza", skills: ["teamwork"] } });
    const accepted = await d.ok(amara, "student.plannerDecision", { params: { ...params, planId: plan.id, opportunityId: plan.opportunities[1]!.id }, body: { revision: plan.revision, decision: "accepted" } });
    await d.ok(amara, "student.plannerShare", { params: { ...params, planId: plan.id, opportunityId: plan.opportunities[1]!.id }, body: { revision: accepted.revision, text: "SHARED work text", assistance: "independent" } });
    const detail = await d.ok(teacher, "teacher.guidanceEvidence", { params: { ...params, frameworkKey: "ccss-ela", code: "W.6.1" } });
    expect(detail.students.map((s) => [s.displayName, s.state])).toEqual([["Amara Okafor", "encountered"], ["Elena Sato", "needs-evidence"]]);
    expect(detail.students[0]!.evidence[0]!.response!.text).toBe("SHARED work text");
    expect(detail.students[1]!.evidence).toEqual([]);
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|conversation|chat/i);
    expectError(await d.call(teacher, "teacher.guidanceEvidence", { params: { ...params, frameworkKey: "ccss-ela", code: "9.Z.Z.9" } }), 404, "not-found");
    for (const token of [d.tokenFor(NF.morgan), d.tokenFor(NF.admin), amara]) {
      expectError(await d.call(token, "teacher.guidanceEvidence", { params: { ...params, frameworkKey: "ccss-ela", code: "W.6.1" } }), 403, "forbidden");
    }
  });

  it("covers only standards this build can actually collect evidence for, and says so", () => {
    expect([...PLANNER_EVIDENCE_CODES].toSorted()).toEqual(["6.RP.A.3", "7.RP.A.1", "W.6.1", "W.7.1"]);
  });
});

describe("guardian progress is a permitted summary of their own child", () => {
  it("shows coarse labels for teacher-chosen standards only, never work, reviews or other students", async () => {
    const { d } = await setup();
    const gina = await onboard(d, NF.amara, "gina");
    await enable(d, gina.relationshipId, ["progress"]);
    const teacher = d.tokenFor(NF.rivera);
    await prioritise(d, [["W.6.1", "focus"]]);
    const amara = d.tokenFor(NF.amara);
    const plan = await d.ok(amara, "student.planGoal", { params, body: { goal: "Pizza PRIVATE", skills: [] } });
    const opp = plan.opportunities[1]!;
    const a = await d.ok(amara, "student.plannerDecision", { params: { ...params, planId: plan.id, opportunityId: opp.id }, body: { revision: plan.revision, decision: "accepted" } });
    const s = await d.ok(amara, "student.plannerShare", { params: { ...params, planId: plan.id, opportunityId: opp.id }, body: { revision: a.revision, text: "SHARED SECRET ANSWER", assistance: "independent" } });
    const practiced = await independentPractice(d, s, opp.id);
    await d.ok(teacher, "teacher.plannerReview", { params: { ...params, planId: plan.id, opportunityId: opp.id }, body: { assessment: unseenAssessment(practiced, opp.id), revision: practiced.revision, level: "demonstrated", assistance: "independent", independentlyAssessed: true, decision: "recommend", rationale: "RATIONALE TEXT" } });
    const view = await d.ok(gina.guardian, "guardian.guidance", { params: childParams(AMARA) });
    expect(view.capabilities).toEqual({ suggest: false, progress: true });
    expect(inEng9(view).progress).toEqual([{ code: "W.6.1", statement: expect.any(String), focus: true, label: "Showed this independently, reviewed by the teacher" }]);
    expect(inEng9(view).suggestions).toBeUndefined();
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/SHARED SECRET|RATIONALE|PRIVATE|Elena|conversation|chat/);
    expectError(await suggest(d, gina.guardian, AMARA), 403, "forbidden");
  });
});

describe("CASEL practice invitations are optional, fixed and non-clinical", () => {
  it("shows the teacher as origin, has no score or reply field, and keeps a decline private", async () => {
    const { d } = await setup();
    const teacher = d.tokenFor(NF.rivera);
    const dash = await d.ok(teacher, "teacher.guidancePracticeInvite", { params, body: { studentIds: [AMARA, ELENA], skill: "teamwork", note: "For the group project." } });
    expect(dash.practice).toHaveLength(2);
    const amara = d.tokenFor(NF.amara);
    const elena = d.tokenFor(NF.elena);
    const mine = (await d.ok(amara, "student.guidance", { params })).invitations;
    expect(mine[0]).toMatchObject({ kind: "suggestion", isAssignment: false, required: false, type: "practice", area: "Relationship skills", origin: { kind: "teacher", name: "Sam Rivera" } });
    expect(Object.keys(mine[0]!).join()).not.toMatch(/score|emotion|mood|trait|diagnos|sentiment|reply|text/i);
    expect(mine[0]!.detail).toContain("ask a teammate what they think");
    await d.ok(amara, "student.guidanceRespond", { params: { ...params, invitationId: mine[0]!.id as never }, body: { revision: mine[0]!.revision!, decision: "accepted" } });
    const theirs = (await d.ok(elena, "student.guidance", { params })).invitations[0]!;
    await d.ok(elena, "student.guidanceRespond", { params: { ...params, invitationId: theirs.id as never }, body: { revision: theirs.revision!, decision: "declined" } });
    const seen = await d.ok(teacher, "teacher.guidance", { params });
    expect(seen.practice.map((p) => [p.studentName, p.accepted])).toEqual(expect.arrayContaining([["Amara Okafor", true], ["Elena Sato", false]]));
    expect(JSON.stringify(seen.practice)).not.toMatch(/declin/i);
    expectError(await d.call(d.tokenFor(NF.morgan), "teacher.guidancePracticeInvite", { params, body: { studentIds: [AMARA], skill: "planning" } }), 403, "forbidden");
    expectError(await d.call(teacher, "teacher.guidancePracticeInvite", { params, body: { studentIds: [PrincipalId.parse(NF.morgan)], skill: "planning" } }), 404, "not-found");
    expectError(await d.call(d.tokenFor(NF.dmitri), "student.guidance", { params }), 404, "not-found");
  });

  it("lists a student's teacher planner invitations beside family and practice ones, each with its origin", async () => {
    const { d } = await setup();
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerInvite", { params, body: { studentId: AMARA, goal: "Compare cookie unit prices", skills: [] } });
    const list = (await d.ok(d.tokenFor(NF.amara), "student.guidance", { params })).invitations;
    expect(list[0]).toMatchObject({ type: "planner-invitation", origin: { kind: "teacher", name: "Sam Rivera" }, title: "Compare cookie unit prices", isAssignment: false, decision: "pending" });
  });
});

describe("persistence", () => {
  it("survives SQLite reconstruction and refuses stale writes for records and grants", async () => {
    const db = new DatabaseSync(":memory:");
    const storage: DistrictSqlStorage = {
      sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings.map((b) => b instanceof ArrayBuffer ? new Uint8Array(b) : b)); return { toArray: () => rows }; } },
      transactionSync(closure) { db.exec("BEGIN"); try { const result = closure(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    };
    try {
      const record: GuidanceRecord = { type: "preference", id: "pref:p", scope: "student:p", revision: 1, studentId: AMARA, guardianSuggestions: "off", updatedAt: "2026-11-15T12:00:00.000Z" };
      const first = new DurableObjectGuidanceStore(storage);
      await first.save(record, 0);
      const second = new DurableObjectGuidanceStore(storage);
      expect(await second.list("student:p")).toEqual([record]);
      await expect(first.save(record, 0)).rejects.toMatchObject({ code: "conflict" });
      expect(await second.list("student:other")).toEqual([]);
      const memory = new InMemoryGuidanceStore();
      await memory.save(record, 0);
      await expect(memory.save({ ...record, revision: 3 }, 1)).rejects.toMatchObject({ code: "conflict" });
      const { d } = await setup();
      const gina = await onboard(d, NF.amara, "gina");
      const relationship = (await d.stores.guardianRelationships.get(gina.relationshipId as never))!;
      const grants = new DurableObjectGuardianGuidanceGrantStore(storage);
      expect(await grants.get(relationship.id)).toBeUndefined();
      await grants.save(nextGuardianGuidanceGrant(undefined, relationship, ["suggest"], PrincipalId.parse(NF.admin), new Date("2026-11-15T12:00:00Z")), 0);
      expect((await new DurableObjectGuardianGuidanceGrantStore(storage).listForStudent(AMARA))[0]).toMatchObject({ enabled: true, capabilities: ["suggest"] });
      await expect(grants.save(nextGuardianGuidanceGrant(undefined, relationship, [], PrincipalId.parse(NF.admin), new Date()), 0)).rejects.toMatchObject({ code: "conflict" });
    } finally { db.close(); }
  });
});
