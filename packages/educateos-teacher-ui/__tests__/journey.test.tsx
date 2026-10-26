// The U02 acceptance journey: a teacher runs their first class, end to end, without SDK or Git.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, GOAL, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const ESSAY = "School should start later. Teenagers need more sleep, and the research supports a later start.";

describe("a teacher's first class", () => {
  it("imports, approves, creates, publishes, reviews, runs checks, shares feedback and approves the grade", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client);

    // My classes, with the active student count.
    await onScreen("My classes");
    expect(await screen.findByText("1 student")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: /English 9 · Period 3/ }));
    await onScreen("Roster · English 9 · Period 3");

    // Import a page into the review queue; the report opens.
    await user.click(screen.getByRole("link", { name: "Resources" }));
    await onScreen(/^Resources/);
    await user.type(screen.getByRole("textbox", { name: /Web address/ }), "https://open-lessons.example/persuasive-writing");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await onScreen("Persuasive Writing Models");
    expect(district.callsTo("teacher.importResource")[0]!.input).toStrictEqual({ params: { offeringId: IDS.offering }, body: { url: "https://open-lessons.example/persuasive-writing" } });
    expect(screen.getByText("Open Lessons Collective")).toBeTruthy();
    expect(screen.getByText("Licensed CC BY-NC 4.0.")).toBeTruthy();
    expect(screen.getByText("1 of 2 images has no text description.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AI suggestion — check before approving" })).toBeTruthy();

    // Approve it for the class.
    await user.click(screen.getByRole("button", { name: "Approve for this class" }));
    await waitFor(() => expect(screen.getByText("You've decided on this resource.")).toBeTruthy());
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("approved for this class");

    // Create a writing task from the template, with a teacher-only note and a new rubric.
    await user.click(screen.getByRole("link", { name: "Create activity" }));
    await onScreen(/^Create activity/);
    await user.click(await screen.findByRole("radio", { name: /Writing task/ }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Should school start later?");
    await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "Argue for or against a later start.");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Take a position on a later start.");
    await user.click(screen.getByRole("checkbox", { name: /^CCSS-ELA W\.9-10\.1 / }));
    await user.click(screen.getByRole("checkbox", { name: "Persuasive Writing Models" }));
    await user.click(screen.getByRole("button", { name: "Add a note" }));
    await user.type(screen.getByRole("textbox", { name: "Note title" }), "Watch for");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Amara tends to skip counterclaims.");
    await user.click(screen.getByRole("switch", { name: "Teacher only" }));
    await user.click(screen.getByRole("radio", { name: /Hints only/ }));
    await user.type(screen.getByRole("textbox", { name: "Rubric title" }), "Essay basics");
    await user.type(screen.getByRole("textbox", { name: "Criteria" }), "Length");
    await user.type(screen.getByRole("textbox", { name: /Automatic check/ }), "20");
    await user.click(screen.getByRole("button", { name: "Sign and use this rubric" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Essay basics" }).getAttribute("aria-checked")).toBe("true"));

    // Preview as a student: the teacher-only note is not there.
    await user.click(screen.getByRole("button", { name: "Preview as student" }));
    const preview = await screen.findByRole("region", { name: "Preview as a student" });
    expect(within(preview).getByText("Should school start later?")).toBeTruthy();
    expect(within(preview).queryByText(/counterclaims/)).toBeNull();
    const created = district.callsTo("teacher.createActivity")[0]!.input.body!.activity as Record<string, unknown>;
    expect(created).toMatchObject({
      template: "writing-task",
      subject: "english-language-arts",
      gradeBand: "9",
      alignments: [GOAL],
      aiHelp: "hints-only",
      codex: [
        { kind: "resource", visibility: "students" },
        { kind: "note", title: "Watch for", body: "Amara tends to skip counterclaims.", visibility: "teacher-only" },
      ],
      structureRubric: { version: 1 },
    });

    // Publish and assign, due on a date.
    await user.type(screen.getByLabelText(/Due date/), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Publish and assign" }));
    await screen.findByText("“Should school start later?” is assigned");
    const install = district.callsTo("teacher.installActivity")[0]!.input;
    expect(install.body).toMatchObject({ offeringId: IDS.offering, version: 1, assignment: { rubric: created.structureRubric } });
    expect(new Date((install.body!.assignment as { dueAt: string }).dueAt).getDate()).toBe(10);

    // A student turns in an essay; the teacher opens it from Submissions.
    const assignmentId = district.assignments.at(-1)!.id;
    district.studentSubmits(assignmentId, ESSAY);
    await user.click(screen.getByRole("link", { name: "Go to submissions" }));
    await user.click(await screen.findByRole("link", { name: "Review Amara Okafor’s work" }));
    await onScreen("Amara Okafor’s work · Should school start later?");
    expect(screen.getByRole("region", { name: "Submitted work: Draft" }).textContent).toBe(ESSAY);

    // Run the automatic checks; their suggestion is labelled and is not the teacher's score.
    await user.click(screen.getByRole("button", { name: "Run checks" }));
    await screen.findByText("1 of 1 checks met.");
    const length = await screen.findByRole("group", { name: "Length" });
    expect(within(length).getByText("Automatic check")).toBeTruthy();
    expect(within(length).getByText(/Suggests 3 of 3 \(Secure\)\. Not your score until you save it\./)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("");

    // Adopt the suggestion as the teacher's own score.
    await user.click(within(length).getByRole("button", { name: "Use Secure" }));
    expect(within(length).getByRole("radio", { name: "Secure (3)" }).getAttribute("aria-checked")).toBe("true");
    expect(district.callsTo("teacher.scoreCriterion")).toHaveLength(0);
    await user.click(within(length).getByRole("button", { name: "Save score" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("3"));
    expect(district.callsTo("teacher.scoreCriterion")[0]!.input.body).toStrictEqual({ criterionId: "length", points: 3, maxPoints: 3 });

    // Comment on a passage of the work.
    await user.type(screen.getByRole("textbox", { name: /Passage you're commenting on/ }), "Teenagers need more sleep");
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Cite the study you mean here.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    await screen.findByText("Cite the study you mean here.");
    expect(district.callsTo("teacher.addComment")[0]!.input.body).toStrictEqual({
      body: "Cite the study you mean here.",
      anchor: { artifactId: "art_essay", revisionId: "rev_essay-2", region: { kind: "text-range", start: 27, end: 52 } },
    });
    expect(screen.getByText("“Teenagers need more sleep”")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("textbox", { name: "Comment" }).textContent).toBe("");

    // Share the feedback with the student.
    await user.click(screen.getByRole("button", { name: "Share feedback with student" }));
    await screen.findByText("Shared with the student");
    expect(district.callsTo("teacher.releaseFeedback")[0]!.input.body).toStrictEqual({ state: "shared-with-student" });

    // Approve the official grade, which the dialog names as official.
    await user.click(screen.getByRole("button", { name: "Approve official grade" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve the official grade?" });
    expect(within(dialog).getByText(/This is the official grade: 3 out of 3 for Amara Okafor/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Yes, approve official grade" }));
    await screen.findByText("Official");
    expect(district.callsTo("teacher.recordGrade")[0]!.input.body).toStrictEqual({ score: { points: 3, maxPoints: 3 } });
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Official grade recorded: 3 out of 3.");

    // Nothing in the journey reached into a student's own space.
    expect(district.calls.map((c) => c.name).filter((name) => name.includes("Workspace"))).toStrictEqual([]);
  });
});
