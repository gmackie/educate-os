import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD } from "../../../educateos-district-app/__tests__/support.ts";
import { renderApp } from "../../__tests__/render.tsx";

const mathClass = () => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => c.id === "crs_nf-english-9" ? { ...c, subject: "mathematics" as const, gradeBand: "6" } : c) });
const params = { offeringId: NF.eng9 };

it("lets a teacher preview, edit, approve, reject, withdraw and pause recipes through the real district API", async () => {
  const d = await bootDistrict(mathClass());
  const client = createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(NF.rivera), fetch: (r) => d.app.fetch(r) });
  const user = await renderApp(client, `#/classes/${NF.eng9}/planner`);
  const section = await screen.findByRole("region", { name: "Learning recipes" });
  const game = await within(section).findByRole("article", { name: "Unit rates in a game production line recipe" });
  expect(within(game).getByText(/Not reviewed yet/)).toBeTruthy();
  expect(within(game).getByText(/not educator-reviewed until you approve it/)).toBeTruthy();
  expect(within(section).getByText(/still uses the built-in fixed connections/)).toBeTruthy();
  // Nothing reaches a student before a decision.
  expect((await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "I want to eat pizza", skills: [] } })).opportunities.every((o) => o.recipe === undefined)).toBe(true);

  // A recipe for another subject cannot be approved here, and says why.
  const argument = within(section).getByRole("article", { name: "An evidence-based argument about a real decision recipe" });
  expect(within(argument).getByText(/Not usable in this class/)).toBeTruthy();
  expect(within(argument).getByRole("button", { name: "Approve for this class" }).hasAttribute("disabled")).toBe(true);

  // Edit then approve: the edit becomes a new, teacher-attributed starter-edited version.
  await user.clear(within(game).getByRole("textbox", { name: "Why now for Unit rates in a game production line" }));
  await user.type(within(game).getByRole("textbox", { name: "Why now for Unit rates in a game production line" }), "We are comparing machines this week.");
  await user.click(within(game).getByRole("button", { name: "Approve for this class" }));
  await within(section).findByText(/Approved · version 1/);
  const approved = within(section).getByRole("article", { name: "Unit rates in a game production line recipe" });
  expect(within(approved).getByText(/Starter text that a teacher edited before approving/)).toBeTruthy();
  expect(within(approved).getByText(/approved by Sam Rivera/)).toBeTruthy();
  const plan = await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "I want to build a Roblox pizza tycoon", skills: [] } });
  expect(plan.opportunities[0]!.recipe).toMatchObject({ origin: "starter-edited", approvedBy: "Sam Rivera", whyNow: "We are comparing machines this week." });
  expect((await d.stores.assessment.load()).state.assignments).toEqual([]);

  // Reject another, then withdraw the approval.
  const basketball = within(section).getByRole("article", { name: "Unit rates in basketball practice recipe" });
  await user.type(within(basketball).getByRole("textbox", { name: "Note for the record about Unit rates in basketball practice" }), "Not this term.");
  await user.click(within(basketball).getByRole("button", { name: "Reject" }));
  await within(section).findByText(/Rejected · version 1/);
  await user.click(within(within(section).getByRole("article", { name: "Unit rates in a game production line recipe" })).getByRole("button", { name: "Withdraw approval" }));
  await within(section).findByText(/Withdrawn · version 1/);
  expect((await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "I want to build a Roblox pizza tycoon", skills: [] } })).opportunities).toEqual([]);

  // The pause switch is the teacher's, per class.
  await user.click(within(section).getByRole("button", { name: "Pause learning recipes" }));
  await within(section).findByRole("button", { name: "Resume learning recipes" });
  await waitFor(() => expect(within(section).getByText(/Paused: no opportunities/)).toBeTruthy());
});
