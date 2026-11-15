// SCHO-403: a class page shows the student's own grades returned in Google Classroom, read-only,
// and nothing at all where the class has no Classroom connection.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { RouteResponse } from "@educateos/api-client";
import { ENGLISH, fakeDistrict, type FakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

type Answer = RouteResponse<"student.classroomGrades">;

const READY = {
  status: "ready",
  offeringId: ENGLISH as Extract<Answer, { status: "ready" }>["offeringId"],
  courseLink: "https://classroom.google.com/c/ODgw",
  grades: [
    { courseWorkId: "501", title: "Tide quiz", maxPoints: 10, link: "https://classroom.google.com/c/ODgw/a/NTAx/details", assignedGrade: 8 },
    { courseWorkId: "502", title: "Reflection" },
  ],
  truncated: false,
} satisfies Answer;

/** The fake district, answering the Classroom grades route with each of `answers` in turn. */
function withClassroom(answers: Answer[]): FakeDistrict & { asked: () => number } {
  const base = fakeDistrict();
  let asked = 0;
  return {
    ...base,
    asked: () => asked,
    async call(name, ...args) {
      if (name === "student.classroomGrades") return structuredClone(answers[Math.min(asked++, answers.length - 1)]) as never;
      return base.call(name, ...args);
    },
  };
}

const panel = () => screen.findByRole("region", { name: "From Google Classroom" });

describe("grades from Google Classroom on a class page", () => {
  it("lists the work returned to the student, with its grade out of its points and a link to Classroom", async () => {
    await renderApp(withClassroom([READY]), `/courses/${ENGLISH}`);
    const section = await panel();
    const table = within(section).getByRole("table", { name: "Grades returned in Google Classroom" });
    const quiz = within(table).getByRole("row", { name: /Tide quiz/ });
    expect(within(quiz).getByText("8 out of 10")).toBeTruthy();
    expect(within(quiz).getByText("Returned")).toBeTruthy();
    const link = within(quiz).getByRole("link", { name: /Tide quiz/ });
    expect(link.getAttribute("href")).toBe("https://classroom.google.com/c/ODgw/a/NTAx/details");
    expect(link.getAttribute("target")).toBe("_blank");
    // Returned without a grade, and not a link where Classroom gave none.
    const reflection = within(table).getByRole("row", { name: /Reflection/ });
    expect(within(reflection).getByText("No grade")).toBeTruthy();
    expect(within(reflection).queryByRole("link")).toBeNull();
    expect(within(section).getByRole("link", { name: /Open the class in Google Classroom/ })).toBeTruthy();
  });

  it("says when nothing has been returned yet", async () => {
    await renderApp(withClassroom([{ ...READY, grades: [] }]), `/courses/${ENGLISH}`);
    expect(within(await panel()).getByText("Nothing has been returned to you in Google Classroom yet.")).toBeTruthy();
  });

  it("says Classroom can't be reached without holding up the class page, and tries again", async () => {
    const district = withClassroom([{ status: "unavailable" }, READY]);
    const user = userEvent.setup();
    await renderApp(district, `/courses/${ENGLISH}`);
    const section = await panel();
    expect(within(section).getByText("Google Classroom can't be reached right now")).toBeTruthy();
    // The rest of the class page is there.
    expect(screen.getByRole("heading", { level: 2, name: "Activities" })).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "Try again" }));
    expect(await within(await panel()).findByRole("table", { name: "Grades returned in Google Classroom" })).toBeTruthy();
    expect(district.asked()).toBe(2);
  });

  it("shows nothing for a class with no Classroom connection", async () => {
    const district = withClassroom([{ status: "not-connected" }]);
    await renderApp(district, `/courses/${ENGLISH}`);
    expect(await screen.findByRole("heading", { level: 2, name: "Activities" })).toBeTruthy();
    expect(district.asked()).toBe(1);
    expect(screen.queryByText("From Google Classroom")).toBeNull();
  });

  it("shows nothing for a class the district refuses", async () => {
    // The default fake answers not-found, as for a class the student cannot read.
    await renderApp(fakeDistrict(), `/courses/${ENGLISH}`);
    expect(await screen.findByRole("heading", { level: 2, name: "Activities" })).toBeTruthy();
    expect(screen.queryByText("From Google Classroom")).toBeNull();
  });
});
