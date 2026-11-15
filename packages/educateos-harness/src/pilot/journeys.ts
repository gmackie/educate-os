// Replays the pilot's scripted student journeys against the real district API and returns a
// normalized transcript: no IDs, tokens or wall-clock times, so it can be compared with a golden.
//
// What a passing replay shows: the software routes interest, help, practice, review and coverage as
// designed. What it does NOT show: that a child learned anything. Learning gains need the
// independent pre/post and delayed test in docs/educateos/pilot/learning-pilot-evaluation.md.
import { PILOT_PERSONAS, PL, type PilotPersona, type PilotWork } from "@educateos/fixtures";
import { auditOpportunity } from "./alignment-audit.ts";
import { bootPilotDistrict, outcomeOf, type PilotDistrict, type PilotOptions, type PilotPlan } from "./district.ts";

type Opportunity = PilotPlan["opportunities"][number];

/** One thing somebody did, and what the system answered. Contains no identifiers. */
export interface PilotStep {
  actor: "student" | "teacher" | "guardian" | "admin" | "system";
  action: string;
  result: unknown;
}

/** The whole replay. Version 1; any change to what it records is a deliberate golden update. */
export interface PilotTranscript {
  version: 1;
  personas: Record<PilotPersona["key"], PilotStep[]>;
  /** Spaced practice for the Roblox learner: a second, delayed independent check. */
  retention: PilotStep[];
  /** Verified guardian opt-in, the visible source of a family suggestion, and the family boundary. */
  family: PilotStep[];
  /** Teacher coverage for the grade 6 class: opportunities and evidence counted separately. */
  coverage: unknown[];
}

const MINUTE = 60_000;
const advance = (d: PilotDistrict, minutes: number) => d.setNow(new Date(d.now().getTime() + minutes * MINUTE).toISOString());

const summarize = (o: Opportunity) => ({
  code: o.code,
  framework: o.frameworkKey,
  nodeCode: o.node.humanCodingScheme,
  nodeUri: o.node.uri,
  release: `${o.releaseVersion} ${o.releaseDigest.slice(0, 19)}`,
  nodeProvenance: o.node.provenance.source,
  task: o.task.slice(0, 64),
  decision: o.decision,
});

const levelsOf = (offeringId: string) => new Set([offeringId === PL.grade7 ? "07" : "06"]);

/** The student's, teacher's and API's view of one persona's journey. */
async function replayPersona(d: PilotDistrict, persona: PilotPersona): Promise<PilotStep[]> {
  const steps: PilotStep[] = [];
  const log = (actor: PilotStep["actor"], action: string, result: unknown) => steps.push({ actor, action, result });
  const student = d.tokenFor(persona.principalId);
  const teacher = d.tokenFor(PL.okoye);
  const params = { offeringId: persona.offeringId as never };

  const created = await d.call(student, "student.planGoal", { params, body: { goal: persona.interest, skills: [] } });
  if (created.status >= 400) {
    log("student", "enter interest", { interest: persona.interest, answer: outcomeOf(created), message: (created.body as { message: string }).message });
    return steps;
  }
  let plan = created.body as PilotPlan;
  const problems = (await Promise.all(plan.opportunities.map((o) => auditOpportunity(d.app.catalog, o, levelsOf(persona.offeringId))))).flat();
  log("student", "enter interest", { interest: persona.interest, offered: plan.opportunities.map(summarize), alignmentAudit: problems.length === 0 ? "clean" : problems });
  if (plan.opportunities.length === 0) {
    const knowledge = await d.ok(student, "student.plannerKnowledge", { params });
    log("system", "no natural alignment", { lesson: "none", opportunities: 0, trackedStandards: knowledge.competencies.length });
    return steps;
  }

  for (const work of persona.work) {
    const index = plan.opportunities.findIndex((o) => o.code === work.code);
    plan = await replayWork(d, student, teacher, params, plan, index, work, log);
  }
  const seen = JSON.stringify(await d.ok(teacher, "teacher.planner", { params }));
  log("teacher", "privacy check", { teacherSeesPrivateInterest: seen.includes(persona.interest) });
  return steps;
}

async function replayWork(
  d: PilotDistrict, student: string, teacher: string, params: { offeringId: never }, start: PilotPlan, index: number, work: PilotWork,
  log: (actor: PilotStep["actor"], action: string, result: unknown) => void,
): Promise<PilotPlan> {
  let plan = start;
  const target = () => ({ ...params, planId: plan.id, opportunityId: plan.opportunities[index]!.id }) as never;
  const opp = () => plan.opportunities[index]!;
  // A teacher's review bumps the plan revision; the learner's next move must start from the stored plan.
  const refresh = async () => { plan = (await d.ok(student, "student.planner", { params })).find((p) => p.id === plan.id)!; };
  const status = async () => (await d.ok(student, "student.plannerKnowledge", { params })).competencies.find((c) => c.code === work.code)?.status ?? "unverified";

  if (work.action === "skip") {
    plan = await d.ok(student, "student.plannerDecision", { params: target(), body: { revision: plan.revision, decision: "skipped" } });
    log("student", `skip ${work.code}`, { decision: opp().decision, evidence: await status() });
    return plan;
  }
  plan = await d.ok(student, "student.plannerDecision", { params: target(), body: { revision: plan.revision, decision: "accepted" } });
  const coach = async (action: "show" | "hint" | "next" | "try" | "reflect") => {
    plan = await d.ok(student, "student.plannerCoach", { params: target(), body: { revision: plan.revision, action, allowAi: false } });
    return opp().coaching!;
  };
  const shown = await coach("show");
  await coach("hint");
  const hinted = await coach("hint");
  log("student", `learn ${work.code}`, { decision: opp().decision, mode: shown.mode, step: shown.lesson.steps[0]!.title, hintsUsed: hinted.hints, source: hinted.source, evidence: await status() });

  plan = await d.ok(student, "student.plannerShare", { params: target(), body: { revision: plan.revision, text: work.project!.text, assistance: work.project!.assistance } });
  log("student", `share project ${work.code}`, { assistanceDisclosed: opp().response!.assistance, evidence: await status() });

  const independent = await coach("try");
  const helpAfterTry = await d.call(student, "student.plannerCoach", { params: target(), body: { revision: plan.revision, action: "hint", allowAi: false } });
  await coach("reflect");
  plan = await d.ok(student, "student.plannerChallenge", { params: target(), body: { revision: plan.revision, text: work.challenge!.text, reflection: work.challenge!.reflection, assistance: work.challenge!.assistance } });
  log("student", `independent challenge ${work.code}`, { mode: independent.mode, helpClosedDuringAttempt: outcomeOf(helpAfterTry), assistanceDisclosed: opp().challenge!.assistance, evidence: await status() });

  advance(d, 10);
  const base = { revision: plan.revision };
  const unseen = { method: "independent-task" as const, observedAt: d.now().toISOString(), context: "Teacher-selected unseen unit-rate or argument task, observed without help." };
  const recommend = { ...base, level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Observed the learner independently meet every criterion on a task they had not seen.", assessment: unseen };
  const attempt = await d.call(teacher, "teacher.plannerReview", { params: target(), body: recommend });
  if (attempt.status < 400) {
    log("teacher", `unseen assessment ${work.code}`, { recommendation: "accepted", evidence: await status() });
    await refresh();
    return plan;
  }
  log("teacher", `recommend mastery ${work.code}`, { answer: outcomeOf(attempt), reason: "the learner's own challenge disclosed help" });
  await d.ok(teacher, "teacher.plannerReview", { params: target(), body: { ...base, level: "practiced", assistance: work.challenge!.assistance, independentlyAssessed: false, decision: "hold", rationale: "Practice was helped, so an independent check is still needed." } });
  log("teacher", `hold ${work.code}`, { evidence: await status() });
  await refresh();
  return plan;
}

/** A second, delayed independent check seven days later for the Roblox learner. */
async function replayRetention(d: PilotDistrict): Promise<PilotStep[]> {
  const steps: PilotStep[] = [];
  const student = d.tokenFor(PL.jules);
  const teacher = d.tokenFor(PL.okoye);
  const params = { offeringId: PL.grade6 as never };
  const persona = PILOT_PERSONAS.find((p) => p.key === "roblox-pizza")!;
  d.setNow(new Date(d.now().getTime() + 7 * 24 * 60 * MINUTE).toISOString());
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: persona.interest, skills: [] } });
  steps.push({ actor: "student", action: "new plan seven days later", result: { priorEvidence: plan.opportunities[0]!.priorEvidence.includes("test this skill in a new setting") ? "suggests a new setting or delayed check" : plan.opportunities[0]!.priorEvidence } });
  const target = () => ({ ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id }) as never;
  plan = await d.ok(student, "student.plannerDecision", { params: target(), body: { revision: plan.revision, decision: "accepted" } });
  plan = await d.ok(student, "student.plannerShare", { params: target(), body: { revision: plan.revision, text: "I solved a new rate problem about delivery drivers.", assistance: "independent" } });
  plan = await d.ok(student, "student.plannerCoach", { params: target(), body: { revision: plan.revision, action: "try", allowAi: false } });
  plan = await d.ok(student, "student.plannerChallenge", { params: target(), body: { revision: plan.revision, text: "Truck A: 150 miles in 3 hours is 50 mph. Truck B: 180 miles in 4 hours is 45 mph. Truck A is faster.", reflection: "I would check the units before comparing.", assistance: "independent" } });
  advance(d, 10);
  const early = await d.call(teacher, "teacher.plannerReview", { params: target(), body: { revision: plan.revision, level: "retained", assistance: "independent", independentlyAssessed: true, decision: "recommend", rationale: "Delayed check.", assessment: { method: "delayed-check", observedAt: d.now().toISOString(), context: "Unseen delivery-rate problem after one week." } } });
  steps.push({ actor: "teacher", action: "record delayed check", result: { answer: outcomeOf(early) } });
  const knowledge = await d.ok(student, "student.plannerKnowledge", { params });
  steps.push({ actor: "system", action: "advisory knowledge", result: knowledge.competencies.map((c) => ({ code: c.code, status: c.status })).toSorted((a, b) => a.code.localeCompare(b.code)) });
  return steps;
}

const tokenIn = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("invitation")!;

/** Onboards a verified guardian (invitation, sign-in approval, administrator confirmation). Opens no guidance. */
export async function onboardGuardian(d: PilotDistrict, studentId: string, subject: string, name: string) {
  const admin = d.tokenFor(PL.admin);
  const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId: studentId as never }, body: { guardianDisplayName: name } });
  const guardian = d.issue(subject);
  await d.ok(guardian, "onboarding.redeemGuardianInvitation", { body: { token: tokenIn(invited.invitationUrl) } });
  const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: { studentId: studentId as never } });
  await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!.requestId } });
  await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  return { token: guardian, relationshipId: invited.relationship.id as string };
}

/** Optional family suggestion: off by default, enabled per relationship, reviewed by the teacher, never an assignment. */
async function replayFamily(d: PilotDistrict): Promise<PilotStep[]> {
  const steps: PilotStep[] = [];
  const log = (actor: PilotStep["actor"], action: string, result: unknown) => steps.push({ actor, action, result });
  const admin = d.tokenFor(PL.admin), teacher = d.tokenFor(PL.okoye), student = d.tokenFor(PL.jules);
  const params = { offeringId: PL.grade6 as never };
  const parent = await onboardGuardian(d, PL.jules, "pl-g-4001", "Sam Park (synthetic guardian)");
  const other = await onboardGuardian(d, PL.maribel, "pl-g-4002", "Rosa Ortiz (synthetic guardian)");
  const child = { studentId: PL.jules as never };
  const suggest = (token: string, studentId: string, topic: string) => d.call(token, "guardian.guidanceSuggest", { params: { studentId: studentId as never, offeringId: PL.grade6 as never }, body: { kind: "curiosity", topic } });

  const initial = await d.ok(parent.token, "guardian.guidance", { params: child });
  log("guardian", "view child after verified onboarding, before any opt-in", { capabilities: initial.capabilities, classes: initial.offerings.length });
  log("guardian", "send a suggestion", { answer: outcomeOf(await suggest(parent.token, PL.jules, "How pizza shops price slices")) });

  await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: parent.relationshipId as never }, body: { revision: 0, capabilities: ["suggest"] } });
  log("admin", "opt this one relationship in to suggestions", { capabilities: ["suggest"] });
  log("guardian", "send a suggestion", { answer: outcomeOf(await suggest(parent.token, PL.jules, "How pizza shops price slices")) });
  log("guardian", "link in a suggestion", { answer: outcomeOf(await suggest(parent.token, PL.jules, "see https://example.com/pizza")) });
  const before = (await d.ok(student, "student.guidance", { params })).invitations;
  log("student", "see suggestions before teacher review", { count: before.length });

  const inbox = (await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!;
  await d.ok(teacher, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: inbox.id as never }, body: { revision: inbox.revision, decision: "share" } });
  const mine = (await d.ok(student, "student.guidance", { params })).invitations[0]!;
  log("student", "see the shared suggestion with its source", { kind: mine.kind, isAssignment: mine.isAssignment, required: mine.required, type: mine.type, origin: mine.origin, decision: mine.decision });
  await d.ok(student, "student.guidanceRespond", { params: { ...params, invitationId: mine.id as never }, body: { revision: mine.revision!, decision: "accepted" } });
  log("teacher", "see that the student chose to accept", { studentAccepted: (await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!.studentAccepted });

  log("guardian", "another family reads this child", { answer: outcomeOf(await d.call(other.token, "guardian.guidance", { params: child })) });
  log("guardian", "another family suggests for this child", { answer: outcomeOf(await suggest(other.token, PL.jules, "Chess club")) });
  log("guardian", "wrong child's class", { answer: outcomeOf(await d.call(parent.token, "guardian.guidanceSuggest", { params: { studentId: PL.jules as never, offeringId: PL.grade7 as never }, body: { kind: "hobby", topic: "Chess" } })) });
  await d.ok(student, "student.guidancePreference", { body: { revision: 0, guardianSuggestions: "off" } });
  log("student", "switch family suggestions off", { guardianSuggestions: "off", nextSuggestion: outcomeOf(await suggest(parent.token, PL.jules, "Another topic")) });
  return steps;
}

/** Teacher coverage rows, flattened to what a teacher decides on. */
async function coverage(d: PilotDistrict): Promise<unknown[]> {
  const dashboard = await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params: { offeringId: PL.grade6 as never } });
  return dashboard.coverage.map((row) => ({
    code: row.code, framework: row.frameworkKey, state: row.state, provenance: row.provenance, pathway: row.evidencePathway,
    roster: row.roster, opportunities: row.opportunities, evidenceByStudent: row.mastery,
  })).toSorted((a, b) => a.code.localeCompare(b.code));
}

/** Runs every scripted journey in a fresh synthetic district and returns the normalized transcript. */
export async function replayPilot(options: PilotOptions = {}): Promise<PilotTranscript> {
  const d = await bootPilotDistrict(options);
  const personas = {} as Record<PilotPersona["key"], PilotStep[]>;
  for (const persona of PILOT_PERSONAS) {
    personas[persona.key] = await replayPersona(d, persona);
    advance(d, 5);
  }
  const grade6Coverage = await coverage(d);
  const retention = await replayRetention(d);
  const family = await replayFamily(d);
  return { version: 1, personas, retention, family, coverage: grade6Coverage };
}
