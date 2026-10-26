import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ENGLISH, ESSAY, fakeDistrict, type FakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

describe("my grades", () => {
  it("lists each class's activities with the latest official grade, reached from the main navigation", async () => {
    const district = fakeDistrict();
    district.recordGrade(ESSAY, { points: 7, maxPoints: 10 });
    district.recordGrade(ESSAY, { points: 9, maxPoints: 10 });
    const user = userEvent.setup();
    await renderApp(district);

    await user.click(await screen.findByRole("link", { name: "Grades" }));
    expect(await screen.findByRole("heading", { level: 1, name: "My grades" })).toBeTruthy();

    const english = await screen.findByRole("table", { name: "Grades for English 9 · Period 3" });
    const essay = within(english).getByRole("row", { name: /Should the school day start later\?/ });
    // The latest version, marked as changed since it was first recorded.
    expect(within(essay).getByText("9 out of 10")).toBeTruthy();
    expect(within(essay).getByText("Updated")).toBeTruthy();
    expect(within(essay).queryByText("7 out of 10")).toBeNull();

    const science = screen.getByRole("table", { name: "Grades for Biology · Period 1" });
    expect(within(within(science).getByRole("row", { name: /Osmosis in potato cores/ })).getByText("Not graded yet")).toBeTruthy();
    // A finished class keeps its grades, marked as finished.
    const art = screen.getByRole("region", { name: /Art · Period 2/ });
    expect(within(art).getByText("Finished")).toBeTruthy();
    expect(district.calls.filter((call) => call.name === "student.officialGrades").map((call) => (call.input as { params: { assignmentId: string } }).params.assignmentId)).toContain(ESSAY);
  });

  it("shows each class's running total and letter, and what the teacher marked (SCHO-187)", async () => {
    const district = fakeDistrict();
    district.recordGrade(ESSAY, { points: 17, maxPoints: 20 });
    district.markAssignment(ESSAY, "late");
    await renderApp(district, "/grades");

    const english = await screen.findByRole("region", { name: /English 9/ });
    expect(within(english).getByText("Course grade: 85.0%")).toBeTruthy();
    expect(within(english).getByText("· B")).toBeTruthy();
    const essay = within(english).getByRole("row", { name: /Should the school day start later\?/ });
    expect(within(essay).getByText("Late")).toBeTruthy();
    // A class with nothing graded has no total yet.
    expect(within(screen.getByRole("region", { name: /Biology/ })).getByText("No course grade yet.")).toBeTruthy();
    expect(district.calls.filter((call) => call.name === "student.gradeSummary")).not.toHaveLength(0);
  });

  it("lists every graded piece of work, quizzes too, so the rows add up to the course total (SCHO-222)", async () => {
    const base = fakeDistrict();
    base.recordGrade(ESSAY, { points: 5, maxPoints: 6 });
    const QUIZ_ASSIGNMENT = "asg_poetry-quiz";
    const quiz = { id: "qz_poetry", offeringId: ENGLISH, courseTitle: "English 9", title: "Poetry terms", assignmentId: QUIZ_ASSIGNMENT };
    const quizGrade = {
      format: "educateos.official-grade.v1", districtId: "dst_northfield", offeringId: ENGLISH, assignmentId: QUIZ_ASSIGNMENT, studentPrincipalId: "prn_nf-student-amara",
      submissionId: "sub_quiz", submissionDigest: `sha256:${"e".repeat(64)}`, version: 1, score: { points: 3, maxPoints: 3 },
      approval: { approvedBy: "prn_nf-teacher-rivera", approvedAt: "2026-10-21T15:00:00.000Z", channel: "http" },
    };
    const district: FakeDistrict = {
      ...base,
      async call(name, ...args) {
        const input = args[0] as { params?: { offeringId?: string; assignmentId?: string } } | undefined;
        if (name === "student.listQuizzes") return (input?.params?.offeringId === ENGLISH ? [quiz] : []) as never;
        if (name === "student.officialGrades" && input?.params?.assignmentId === QUIZ_ASSIGNMENT) return [quizGrade] as never;
        if (name === "student.gradeSummary" && input?.params?.offeringId === ENGLISH) {
          const summary = await base.call("student.gradeSummary", { params: { offeringId: ENGLISH } });
          return {
            ...summary,
            columns: [...summary.columns, { offeringId: ENGLISH, assignmentId: QUIZ_ASSIGNMENT, title: "Poetry terms", dueAt: "2026-11-06T20:00:00.000Z", pointsPossible: 3 }],
            row: {
              ...summary.row,
              cells: [...summary.row.cells, { assignmentId: QUIZ_ASSIGNMENT, score: { points: 3, maxPoints: 3 }, version: 1, percent: 100, counted: true, dropped: false }],
              totals: { ...summary.row.totals, points: { earned: 8, possible: 9 }, final: 88.89, unweighted: 88.89 },
            },
          } as never;
        }
        return base.call(name, ...args);
      },
    };
    await renderApp(district, "/grades");

    const english = await screen.findByRole("table", { name: "Grades for English 9 · Period 3" });
    expect(within(screen.getByRole("region", { name: /English 9/ })).getByText("Course grade: 88.9%")).toBeTruthy();
    const quizRow = within(english).getByRole("row", { name: /Poetry terms/ });
    expect(within(quizRow).getByText("3 out of 3")).toBeTruthy();
    expect(within(quizRow).getByRole("link", { name: "Poetry terms" }).getAttribute("href")).toBe(`/courses/${ENGLISH}/quizzes/qz_poetry`);
    expect(within(within(english).getByRole("row", { name: /Should the school day start later\?/ })).getByText("5 out of 6")).toBeTruthy();
  });

  it("says when grades could not load, and loads them again on Try again", async () => {
    const district = fakeDistrict();
    district.failNext("student.officialGrades", "network");
    const user = userEvent.setup();
    await renderApp(district, "/grades");

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("We couldn't load your grades")).toBeTruthy();
    await user.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Grades for English 9 · Period 3" })).toBeTruthy();
  });
});
