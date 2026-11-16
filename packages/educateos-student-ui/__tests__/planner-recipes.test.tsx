import { expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD } from "../../educateos-district-app/__tests__/support.ts";
import { renderApp } from "./render.tsx";

it("shows a learner the teacher-approved recipe's origin and why it fits, and offers nothing for a weak connection", async () => {
  const directory = { ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => c.id === "crs_nf-english-9" ? { ...c, subject: "mathematics" as const, gradeBand: "6" } : c) };
  const d = await bootDistrict(directory);
  const params = { offeringId: NF.eng9 };
  await d.ok(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "approve", starterId: "g6-unit-rate-game-production", revision: 0, note: "Fits our rates unit." } });
  const client = createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(NF.amara), fetch: (r) => d.app.fetch(r) });
  const user = userEvent.setup();
  await renderApp(client, `/courses/${NF.eng9}`);
  await user.click(await screen.findByRole("button", { name: /Personalized Learning Planner/ }));
  const planner = await screen.findByRole("region", { name: "Personalized Learning Planner" });
  const goal = within(planner).getByRole("textbox", { name: "What do you want to build or explore?" });

  await user.type(goal, "I want to eat pizza");
  await user.click(within(planner).getByRole("button", { name: "Find optional opportunities" }));
  await within(planner).findByText(/No verified, approved match was found/);
  expect(within(planner).queryByRole("article", { name: "6.RP.A.3b opportunity" })).toBeNull();

  await user.clear(goal);
  await user.type(goal, "I want to build a Roblox pizza tycoon");
  await user.click(within(planner).getByRole("button", { name: "Find optional opportunities" }));
  const card = await within(planner).findByRole("article", { name: "6.RP.A.3b opportunity" });
  const origin = within(card).getByRole("region", { name: "Where this opportunity came from" });
  expect(within(origin).getByText(/Approved for your class by Sam Rivera/)).toBeTruthy();
  expect(within(origin).getByText(/Starter text, approved as written/)).toBeTruthy();
  expect(within(origin).getByText(/your goal mentioned: roblox, tycoon, pizza/)).toBeTruthy();
  expect(within(origin).getByText(/Why now:/)).toBeTruthy();
  expect(within(origin).getByText(/It is optional, you can skip it, and it never changes a grade/)).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "Skip" }));
  expect((await d.ok(d.tokenFor(NF.amara), "student.plannerKnowledge", { params })).competencies.every((c) => c.status === "unverified")).toBe(true);
  expect(await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params })).toEqual([]);
});
