import { expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD } from "../../../educateos-district-app/__tests__/support.ts";
import { renderApp } from "../../__tests__/render.tsx";

it("sends an attributed optional invitation through Teacher Studio and the real district API", async () => {
  const d = await bootDistrict({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) });
  const client = createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(NF.rivera), fetch: (r) => d.app.fetch(r) });
  const user = await renderApp(client, `#/classes/${NF.eng9}/planner`);
  await screen.findByRole("heading", { name: "Personalized Learning Planner" });
  const sections = screen.getByRole("navigation", { name: "Class sections" });
  expect(within(sections).getByRole("link", { name: "Learning planner" }).getAttribute("aria-current")).toBe("page");
  expect(within(sections).getByRole("link", { name: "Classroom setup" }).getAttribute("href")).toBe(`#/classes/${NF.eng9}/setup`);
  expect(document.title).toBe("Personalized Learning Planner · Teacher Studio");
  await user.click(await screen.findByRole("combobox", { name: /Student/ }));
  await user.click(await screen.findByRole("option", { name: "Amara Okafor" }));
  await user.type(screen.getByRole("textbox", { name: "Optional invitation" }), "Compare cookie unit prices");
  await user.click(screen.getByRole("button", { name: "Send optional teacher invitation" }));
  await screen.findByText(/Optional invitation from.*Compare cookie unit prices/);
  const mine = await d.ok(d.tokenFor(NF.amara), "student.planner", { params: { offeringId: NF.eng9 } });
  expect(mine[0]).toMatchObject({ source: "teacher", authorId: NF.rivera, goal: "Compare cookie unit prices" });
  expect((await d.stores.assessment.load()).state.assignments).toEqual([]);
});

it("reviews only explicitly shared evidence, with conservative defaults and teacher correction", async () => {
  const d = await bootDistrict({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) });
  const student = d.tokenFor(NF.amara);
  const params = { offeringId: NF.eng9 };
  let p = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE PIZZA GOAL", skills: [] } });
  const target = { ...params, planId: p.id, opportunityId: p.opportunities[0]!.id };
  p = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: p.revision, decision: "accepted" } });
  await d.ok(student, "student.plannerShare", { params: target, body: { revision: p.revision, assistance: "ai", text: "I used AI to calculate four pizzas per minute." } });
  const client = createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(NF.rivera), fetch: (r) => d.app.fetch(r) });
  const user = await renderApp(client, `#/classes/${NF.eng9}/planner`);
  const review = await screen.findByRole("article", { name: "6.RP.A.3b evidence review" });
  expect(screen.queryByText("PRIVATE PIZZA GOAL")).toBeNull();
  expect(within(review).getByText("Student-disclosed help: ai")).toBeTruthy();
  expect(within(review).getByText("Hold — no mastery recommendation")).toBeTruthy();
  await user.type(within(review).getByRole("textbox", { name: "Review rationale and assessment conditions" }), "Assisted practice only; arrange a new independent check.");
  await user.click(within(review).getByRole("button", { name: "Save teacher review" }));
  await screen.findByText(/practiced · ai · hold/);
  const read = await d.ok(student, "student.planner", { params });
  expect(read[0]!.opportunities[0]!.reviews.at(-1)).toMatchObject({ level: "practiced", assistance: "ai", independentlyAssessed: false, decision: "hold" });
});
