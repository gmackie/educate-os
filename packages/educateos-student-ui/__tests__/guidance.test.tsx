import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD, type TestDistrict } from "../../educateos-district-app/__tests__/support.ts";
import { renderApp } from "./render.tsx";

const directory = { ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) };
const clientFor = (d: TestDistrict, token: string) => createDistrictApiClient({ baseUrl: "https://district.example", token, fetch: (r) => d.app.fetch(r) });
const params = { offeringId: NF.eng9 };

/** A confirmed guardian of Amara. Onboarding grants no learning guidance. */
async function guardianOfAmara(d: TestDistrict) {
  const admin = d.tokenFor(NF.admin);
  const studentId = NF.amara as never;
  const invited = await d.ok(admin, "admin.inviteGuardian", { params: { studentId }, body: { guardianDisplayName: "Gina Okafor" } });
  const token = d.idp.issue("gina");
  await d.ok(token, "onboarding.redeemGuardianInvitation", { body: { token: new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")! } });
  const { pendingSignIns } = await d.ok(admin, "admin.studentGuardians", { params: { studentId } });
  await d.ok(admin, "admin.approveIdentityRequest", { params: { requestId: pendingSignIns[0]!.requestId } });
  await d.ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  return { token, relationshipId: invited.relationship.id };
}

it("tells a family plainly when learning guidance is not switched on, and offers no form", async () => {
  const d = await bootDistrict(directory);
  const { token } = await guardianOfAmara(d);
  await renderApp(clientFor(d, token), `/family/children/${NF.amara}/guidance`);
  expect(await screen.findByText("Not turned on for your family")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send to the teacher" })).toBeNull();
});

it("carries a family suggestion from the guardian to the student with its origin, never as an assignment", async () => {
  const d = await bootDistrict(directory);
  const { token, relationshipId } = await guardianOfAmara(d);
  await d.ok(d.tokenFor(NF.admin), "admin.setGuardianGuidance", { params: { relationshipId }, body: { revision: 0, capabilities: ["suggest", "progress"] } });
  const user = userEvent.setup();

  // The guardian suggests a hobby.
  const family = await renderApp(clientFor(d, token), `/family/children/${NF.amara}/guidance`);
  const section = await screen.findByRole("region", { name: "English 9" });
  await user.type(within(section).getByRole("textbox", { name: "Topic" }), "Building model rockets");
  await user.click(within(section).getByRole("button", { name: "Send to the teacher" }));
  await within(section).findByText(/Waiting for the teacher to review/);
  expect(within(section).getByText(/never homework, never graded/)).toBeTruthy();
  family.unmount();

  // Nothing reaches the student until the teacher shares it.
  const studentToken = d.tokenFor(NF.amara);
  expect((await d.ok(studentToken, "student.guidance", { params })).invitations).toEqual([]);
  const inbox = (await d.ok(d.tokenFor(NF.rivera), "teacher.guidance", { params })).suggestions[0]!;
  await d.ok(d.tokenFor(NF.rivera), "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: inbox.id }, body: { revision: inbox.revision, decision: "share" } });

  const student = await renderApp(clientFor(d, studentToken), `/courses/${NF.eng9}`);
  await user.click(await screen.findByRole("button", { name: /Suggestions for you/ }));
  const list = await screen.findByRole("region", { name: "Suggestions for you" });
  const card = await within(list).findByRole("article", { name: "Building model rockets" });
  expect(within(card).getByText("Family suggestion")).toBeTruthy();
  expect(within(card).getByText("Suggestion · not an assignment")).toBeTruthy();
  expect(within(card).getByText(/From your family: /)).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "No thanks" }));
  await within(card).findByText("You said no thanks. Nobody was told.");
  // A decline is invisible to the teacher.
  expect((await d.ok(d.tokenFor(NF.rivera), "teacher.guidance", { params })).suggestions[0]!.studentAccepted).toBe(false);
  // The student can turn family suggestions off.
  await user.click(within(list).getByRole("checkbox", { name: "Show suggestions from my family" }));
  await waitFor(() => expect(within(list).queryByRole("article", { name: "Building model rockets" })).toBeNull());
  expect(within(list).getByText("No suggestions right now.")).toBeTruthy();
  student.unmount();
});

it("shows a guardian only labels for the standards the teacher chose, for their own child", async () => {
  const d = await bootDistrict(directory);
  const { token, relationshipId } = await guardianOfAmara(d);
  await d.ok(d.tokenFor(NF.admin), "admin.setGuardianGuidance", { params: { relationshipId }, body: { revision: 0, capabilities: ["progress"] } });
  const teacher = d.tokenFor(NF.rivera);
  const goals = await d.ok(teacher, "teacher.learningGoals", { params });
  const w61 = goals.goals.find((g) => g.code === "W.6.1")!;
  await d.ok(teacher, "teacher.guidanceAgenda", { params, body: { revision: 0, priorities: [{ frameworkKey: w61.frameworkKey, competencyUri: w61.competencyUri, level: "focus" }] } });
  await renderApp(clientFor(d, token), `/family/children/${NF.amara}/guidance`);
  const progress = await screen.findByRole("region", { name: "Progress in English 9" });
  expect(within(progress).getByText("W.6.1")).toBeTruthy();
  expect(within(progress).getByText("No shared work yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send to the teacher" })).toBeNull();
});
