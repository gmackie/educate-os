import { expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD } from "../../../educateos-district-app/__tests__/support.ts";
import { TeacherEvidenceBody, TeacherGuidanceBody } from "../../../educateos-district-app/src/guidance.ts";
import { GUIDANCE_DASHBOARD_SAMPLE, GUIDANCE_EVIDENCE_SAMPLE } from "../../../educateos-fixtures/src/guidance-sample.ts";
import { renderApp } from "../../__tests__/render.tsx";

const gradeSix = () => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) });
const params = { offeringId: NF.eng9 };
const clientFor = (d: Awaited<ReturnType<typeof bootDistrict>>, who: string) => createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(who), fetch: (r) => d.app.fetch(r) });

it("keeps the synthetic sample dashboard in step with the real route schemas", () => {
  const body = TeacherGuidanceBody.parse(GUIDANCE_DASHBOARD_SAMPLE);
  expect(body.coverage.map((r) => r.state).toSorted()).toEqual(["approved", "approved", "hidden", "unmapped"]);
  expect(body.coverage.every((r) => r.roster === Object.values(r.mastery).reduce((a, b) => a + b, 0))).toBe(true);
  TeacherEvidenceBody.parse(GUIDANCE_EVIDENCE_SAMPLE);
  expect(JSON.stringify(GUIDANCE_DASHBOARD_SAMPLE)).not.toMatch(/goal|private|conversation/i);
});

it("shows separate opportunity and evidence counters, drills into shared work only, and never offers an assignment", async () => {
  const d = await bootDistrict(gradeSix());
  const teacher = d.tokenFor(NF.rivera);
  const goals = await d.ok(teacher, "teacher.learningGoals", { params });
  const w61 = goals.goals.find((g) => g.code === "W.6.1")!;
  await d.ok(teacher, "teacher.guidanceAgenda", { params, body: { revision: 0, priorities: [{ frameworkKey: w61.frameworkKey, competencyUri: w61.competencyUri, level: "focus", discussionPrompt: "Which claim had the best evidence?" }] } });
  // Amara shares a response on W.6.1; Elena only plans privately.
  const amara = d.tokenFor(NF.amara);
  const plan = await d.ok(amara, "student.planGoal", { params, body: { goal: "PRIVATE PIZZA GOAL", skills: ["planning"] } });
  const opportunity = plan.opportunities[1]!;
  const accepted = await d.ok(amara, "student.plannerDecision", { params: { ...params, planId: plan.id, opportunityId: opportunity.id }, body: { revision: plan.revision, decision: "accepted" } });
  await d.ok(amara, "student.plannerShare", { params: { ...params, planId: plan.id, opportunityId: opportunity.id }, body: { revision: accepted.revision, text: "SHARED ARGUMENT TEXT", assistance: "independent" } });
  await d.ok(d.tokenFor(NF.elena), "student.planGoal", { params, body: { goal: "ELENA PRIVATE GOAL", skills: [] } });

  const user = await renderApp(clientFor(d, NF.rivera), `#/classes/${NF.eng9}/guidance`);
  expect(await screen.findByRole("heading", { name: /Guidance and evidence/ })).toBeTruthy();
  const table = await screen.findByRole("table");
  expect(within(table).getByRole("columnheader", { name: /^Opportunities/ })).toBeTruthy();
  expect(within(table).getByRole("columnheader", { name: /^Evidence by student/ })).toBeTruthy();
  const opportunities = within(table).getByRole("list", { name: "W.6.1 opportunities" });
  expect(opportunities.textContent).toBe("1 offered1 accepted1 shared0 reviewed");
  const evidence = within(table).getByRole("list", { name: "W.6.1 evidence by student" });
  expect(evidence.textContent).toMatch(/1\s*encountered/i);
  expect(evidence.textContent).toMatch(/1\s*needs evidence/i);
  expect(within(table).getByRole("img", { name: /W\.6\.1, evidence by student, 2 students/ })).toBeTruthy();
  expect(within(table).getByText(/Discussion prompt: Which claim had the best evidence\?/)).toBeTruthy();
  expect(screen.getByTestId("assignment-note").textContent).toMatch(/not assignments/i);

  await user.click(within(table).getByRole("button", { name: "View student evidence for W.6.1" }));
  const amaraCard = await screen.findByRole("article", { name: "Amara Okafor, W.6.1" });
  expect(within(amaraCard).getByText("SHARED ARGUMENT TEXT")).toBeTruthy();
  expect(within(screen.getByRole("article", { name: "Elena Sato, W.6.1" })).getByText("No work shared on this standard yet.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/PRIVATE PIZZA GOAL|ELENA PRIVATE GOAL/);
});

it("lets the teacher share a family suggestion as an optional suggestion, and the student sees its origin", async () => {
  const d = await bootDistrict(gradeSix());
  const admin = d.tokenFor(NF.admin), child = { studentId: NF.amara as never };
  const invited = await d.ok(admin, "admin.inviteGuardian", { params: child, body: { guardianDisplayName: "Gina Okafor" } });
  const guardian = d.idp.issue("guidance-ui-gina");
  await d.ok(guardian, "onboarding.redeemGuardianInvitation", { body: { token: new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")! } });
  const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: child });
  await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!.requestId } });
  await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: invited.relationship.id }, body: { revision: 0, capabilities: ["suggest"] } });
  await d.ok(guardian, "guardian.guidanceSuggest", { params: { ...child, ...params }, body: { kind: "hobby", topic: "Skateboard physics" } });
  expect((await d.ok(d.tokenFor(NF.amara), "student.guidance", { params })).invitations).toEqual([]);
  const user = await renderApp(clientFor(d, NF.rivera), `#/classes/${NF.eng9}/guidance`);
  const inbox = await screen.findByRole("region", { name: "Family suggestions" });
  expect(within(inbox).getByText(/never an assignment/)).toBeTruthy();
  const card = within(inbox).getByRole("article", { name: "Suggestion for Amara Okafor: Skateboard physics" });
  await user.click(within(card).getByRole("button", { name: "Share with student: Skateboard physics" }));
  expect(await within(inbox).findByText("Shared with the student")).toBeTruthy();
  const seen = (await d.ok(d.tokenFor(NF.amara), "student.guidance", { params })).invitations;
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ isAssignment: false, required: false, origin: { kind: "guardian", name: "Gina Okafor" } });
});

it("sends optional practice invitations that say they are unscored and not assessments", async () => {
  const d = await bootDistrict(gradeSix());
  const user = await renderApp(clientFor(d, NF.rivera), `#/classes/${NF.eng9}/guidance`);
  const section = await screen.findByRole("region", { name: "Optional practice invitations" });
  expect(within(section).getByText(/not (a )?test|unscored|no score/i)).toBeTruthy();
  await user.click(within(section).getByRole("checkbox", { name: "Amara Okafor" }));
  await user.click(within(section).getByRole("button", { name: "Send optional practice invitations" }));
  await within(section).findByRole("list", { name: "Practice invitations sent" });
  const mine = (await d.ok(d.tokenFor(NF.amara), "student.guidance", { params })).invitations;
  expect(mine[0]).toMatchObject({ type: "practice", isAssignment: false, origin: { kind: "teacher" } });
});
