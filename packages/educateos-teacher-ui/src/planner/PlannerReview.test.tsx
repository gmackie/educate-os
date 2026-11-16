import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrict, NF, NORTHFIELD } from "../../../educateos-district-app/__tests__/support.ts";
import { renderApp } from "../../__tests__/render.tsx";
import { chooseOption } from "../../__tests__/chooseOption.ts";

const at = "2026-11-15T14:00:00.000Z";

it("reconfirms a historical judgment with independent criterion excerpts, then withdraws without erasing history", async () => {
  const d = await bootDistrict({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) }, { now: () => new Date(at) });
  const student = d.tokenFor(NF.amara), params = { offeringId: NF.eng9 };
  let p = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE pizza game goal", skills: [] } });
  const target = { ...params, planId: p.id, opportunityId: p.opportunities[0]!.id };
  p = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: p.revision, decision: "accepted" } });
  p = await d.ok(student, "student.plannerShare", { params: target, body: { revision: p.revision, assistance: "ai", text: "Shared AI-assisted project: four pizzas/minute." } });
  p = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: p.revision, action: "try", allowAi: false } });
  p = await d.ok(student, "student.plannerChallenge", { params: target, body: { revision: p.revision, assistance: "independent", text: "Shared independent printer practice.", reflection: "Ready for a new check." } });
  const legacy = { level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Historical teacher judgment", by: NF.rivera as typeof p.authorId, at, assessment: { method: "independent-task" as const, context: "Original unseen oral check", observedAt: at } };
  p.opportunities[0]!.reviews.push(legacy); p.revision++;
  await d.stores.planner.save(p, p.revision - 1);
  const client = createDistrictApiClient({ baseUrl: "https://district.example", token: d.tokenFor(NF.rivera), fetch: (r) => d.app.fetch(r) });
  const user = await renderApp(client, `#/classes/${NF.eng9}/planner`);
  let review = await screen.findByRole("article", { name: "6.RP.A.3b evidence review" });
  expect(within(review).getByRole("status").textContent).toContain("Needs criterion-level reconfirmation");
  expect(within(review).getByText(/Reviewer: prn_nf-teacher-rivera/)).toBeTruthy();
  expect(screen.queryByText("PRIVATE pizza game goal")).toBeNull();
  expect(within(review).getByText(/Shared AI-assisted project/)).toBeTruthy();
  expect(within(review).getByText(/Shared independent printer practice/)).toBeTruthy();
  await user.click(within(review).getByText(/Calibrate with a synthetic common check/));
  expect(within(review).getByText(/60 L and 45 L/)).toBeTruthy();
  await chooseOption(user, "Evidence level", "Demonstrated", review);
  await chooseOption(user, "Observed assistance", "Independent", review);
  await user.click(within(review).getByRole("checkbox", { name: /I independently assessed/ }));
  await chooseOption(user, "Teacher decision", "Recommend mastery for teacher consideration", review);
  await user.type(within(review).getByRole("textbox", { name: "Unseen assessment task, observed reasoning and context" }), "Fresh tap-flow common check, individually observed.");
  await user.type(within(review).getByRole("textbox", { name: "Assessment time (ISO 8601, with timezone)" }), at);
  await user.type(within(review).getByRole("textbox", { name: "Review rationale and assessment conditions" }), "Observed every criterion without help.");
  expect(within(review).getByRole("button", { name: "Save teacher review" }).hasAttribute("disabled")).toBe(true);
  const snippets = ["24/6 = 4 L/min; 30/10 = 3 L/min.", "4 x 15 = 60 L; 3 x 15 = 45 L.", "First tap is faster if flow is constant. Units cancel."];
  for (let i = 0; i < 3; i++) {
    const rating = within(review).getByRole("combobox", { name: `Criterion ${i + 1} rating` });
    expect(rating.textContent).toContain("Not observed");
    // Keyboard interaction verifies the new selects work without a pointer.
    rating.focus(); await user.keyboard("{ArrowDown}");
    const met = await screen.findByRole("option", { name: "Met independently" });
    met.focus(); await user.keyboard("{Enter}");
    await user.type(within(review).getByRole("textbox", { name: `Criterion ${i + 1} observed excerpt from separate check` }), snippets[i]!);
  }
  await user.click(within(review).getByRole("button", { name: "Save teacher review" }));
  await waitFor(() => expect(screen.queryByText(/Needs criterion-level reconfirmation/)).toBeNull());
  review = screen.getByRole("article", { name: "6.RP.A.3b evidence review" });
  expect(within(review).getByText(snippets[0]!)).toBeTruthy();
  expect(within(review).getByText(/Source: teacher-observed common check/)).toBeTruthy();
  const read = (await d.ok(student, "student.planner", { params }))[0]!;
  expect(read.opportunities[0]!.reviews[0]).toEqual(legacy);
  expect(read.opportunities[0]!.reviews.at(-1)!.assessment!.rubric!.criteria.every((c) => c.rating === "met")).toBe(true);
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("demonstrated");
  await user.type(within(review).getByRole("textbox", { name: "Review rationale and assessment conditions" }), "Withdraw pending another observation.");
  await user.click(within(review).getByRole("button", { name: "Withdraw recommendation" }));
  await screen.findByText(/practiced · ai · hold · Withdraw pending/);
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("practiced");
  expect((await d.stores.planner.list(NF.eng9))[0]!.opportunities[0]!.reviews).toHaveLength(3);
});
