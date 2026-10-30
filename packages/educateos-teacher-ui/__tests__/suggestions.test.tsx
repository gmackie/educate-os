// Suggestions, from an AI model or an automatic check, help the teacher; they never become the
// student's official grade, or the teacher's score, without the teacher acting.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const reviewHash = (assignmentId: string, submissionId: string) => `#/classes/${IDS.offering}/assignments/${assignmentId}/submissions/${submissionId}`;

const setUp = () => {
  const district = fakeDistrict();
  const assignmentId = district.assignments[0]!.id;
  const submissionId = district.studentSubmits(assignmentId, "A short essay about sleep.");
  district.suggest(submissionId, { criterionId: "argument", points: 4, maxPoints: 4, suggester: { kind: "ai", modelId: "synthetic-demo-model" } });
  district.suggest(submissionId, { criterionId: "conventions", points: 2, maxPoints: 4, suggester: { kind: "evaluator", evaluatorId: "writing.conventions@1.0.0" } });
  return { district, hash: reviewHash(assignmentId, submissionId) };
};

describe("suggested scores", () => {
  it("label each suggestion with its source and leave the official grade empty", async () => {
    const { district, hash } = setUp();
    await renderApp(district.client, hash);
    await onScreen(/Amara Okafor’s work/);

    const argument = await screen.findByRole("group", { name: "argument" });
    expect(within(argument).getByText("AI suggestion")).toBeTruthy();
    expect(within(argument).getByText("Model: synthetic-demo-model")).toBeTruthy();
    expect(screen.getByText("Evaluator: writing.conventions@1.0.0")).toBeTruthy();
    expect(within(argument).getByText(/Suggests 4 of 4\. Not your score until you save it\./)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "conventions" })).getByText("Automatic check")).toBeTruthy();

    // No teacher scores, so nothing adds up to a grade, and approving is not offered.
    expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Out of" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Approve official grade" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Official")).toBeNull();
  });

  it("only fill the teacher's box when used, and count only what the teacher saved", async () => {
    const { district, hash } = setUp();
    const user = await renderApp(district.client, hash);
    const argument = await screen.findByRole("group", { name: "argument" });

    await user.click(within(argument).getByRole("button", { name: "Use 4" }));
    expect((within(argument).getByRole("textbox", { name: "Your score for argument" }) as HTMLInputElement).value).toBe("4");
    expect(district.callsTo("teacher.scoreCriterion")).toStrictEqual([]);
    // Using one suggestion is not a grade: the other criterion is unscored, so there is no total.
    expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("");

    await user.click(within(argument).getByRole("button", { name: "Save score" }));
    const conventions = screen.getByRole("group", { name: "conventions" });
    await user.type(within(conventions).getByRole("textbox", { name: "Your score for conventions" }), "3");
    await user.click(within(conventions).getByRole("button", { name: "Save score" }));
    // The total is the teacher's 4 + 3, not the suggested 4 + 2.
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("7"));
    expect((screen.getByRole("textbox", { name: "Out of" }) as HTMLInputElement).value).toBe("8");
    expect(district.callsTo("teacher.recordGrade")).toStrictEqual([]);
  });

  it("never record an official grade without the confirmation that names it official", async () => {
    const { district, hash } = setUp();
    const user = await renderApp(district.client, hash);
    await screen.findByRole("group", { name: "argument" });
    await user.type(screen.getByRole("textbox", { name: "Points" }), "6");
    await user.type(screen.getByRole("textbox", { name: "Out of" }), "8");

    await user.click(screen.getByRole("button", { name: "Approve official grade" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve the official grade?" });
    expect(within(dialog).getByText(/This is the official grade: 6 out of 8 for Amara Okafor/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(district.callsTo("teacher.recordGrade")).toStrictEqual([]);
    expect(screen.queryByText("Official")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Approve official grade" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Yes, approve official grade" }));
    await screen.findByText("Official");
    expect(district.callsTo("teacher.recordGrade").map((c) => c.input.body)).toStrictEqual([{ score: { points: 6, maxPoints: 8 } }]);
  });

  it("are labelled as AI suggestions on a resource's review report too", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/resources`);
    await user.type(await screen.findByRole("textbox", { name: /Web address/ }), "https://open-lessons.example/persuasive-writing");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    const ai = await screen.findByRole("region", { name: "AI suggestion — check before approving" });
    expect(within(ai).getByText("One model essay presents only one side.")).toBeTruthy();
    expect(within(ai).getByText("AI suggestion")).toBeTruthy();
    expect(within(ai).getByText(/not a certification of rights/)).toBeTruthy();
    // The AI review decides nothing: the item still waits for the teacher.
    expect(screen.getByText("Ready for your review")).toBeTruthy();
    expect(district.callsTo("teacher.approveResource")).toStrictEqual([]);
  });
});
