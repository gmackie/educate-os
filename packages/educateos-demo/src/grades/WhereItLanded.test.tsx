import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByRole, getByRole, getByText, queryByRole, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveredGrade, DemoGradebooks, GradeClass, GradeEvent, GradeRouteKind } from "./types.ts";
import { WhereItLanded } from "./WhereItLanded.tsx";

const EARTH_SCIENCE = "off_earth";
const ATTEMPT = { at: "2026-10-29T15:00:00.000Z", offeringId: EARTH_SCIENCE, className: "Earth Science 8", studentName: "An Nguyen", assignmentTitle: "Where does the rain go?", scoreMaximum: 5 } as const;
const IN_CLASSROOM: GradeEvent = {
  ...ATTEMPT, id: "grade-1", scoreGiven: 4, gradeVersion: 1, via: "google-classroom", outcome: "posted",
  landed: { via: "google-classroom", courseId: "271453407972", courseName: "Earth Science 8, Period 1", courseWorkId: "143522173197", courseWorkTitle: "Where does the rain go?", assignedGrade: 4, maxPoints: 5 },
};
const IN_CLEVER: GradeEvent = {
  ...ATTEMPT, id: "grade-2", scoreGiven: 5, gradeVersion: 2, via: "clever-lms-connect", outcome: "posted",
  landed: { via: "clever-lms-connect", sectionId: "dbfb4edc4327ef69dbfb4ddc", sectionName: "Earth Science 8 - Whitaker", assignmentId: "28be06b684db27fe28be07b6", assignmentTitle: "Where does the rain go?", gradePoints: 5, pointsPossible: 5 },
};
const REFUSED: GradeEvent = { ...ATTEMPT, id: "grade-3", scoreGiven: 5, gradeVersion: 3, via: "clever-lms-connect", outcome: "refused", code: "policy-violation", reason: "This grade has not been approved by the offering's teacher." };

/** Gradebooks the view can drive, holding `events` and one class on `route`. */
function stubGradebooks(events: GradeEvent[], route: GradeRouteKind = "google-classroom") {
  const listeners = new Set<(event?: GradeEvent) => void>();
  let current = [...events];
  let classes: GradeClass[] = [{ offeringId: EARTH_SCIENCE, title: "Earth Science 8", section: "Period 1", teachers: ["Dana Whitaker"], route }];
  const add = (event: GradeEvent) => {
    current = [...current, event];
    for (const l of listeners) l(event);
    return event;
  };
  const grades = {
    classes: vi.fn(async () => classes),
    setRoute: vi.fn((offeringId: string, next: GradeRouteKind) => {
      classes = classes.map((c) => (c.offeringId === offeringId ? { ...c, route: next } : c));
      for (const l of listeners) l();
    }),
    events: () => current,
    subscribe: (listener: (event?: GradeEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    resend: vi.fn(async (id: string) => {
      const delivered = current.find((e): e is DeliveredGrade => e.id === id && e.outcome !== "refused")!;
      return add({ ...delivered, id: `grade-${current.length + 1}`, outcome: "already-posted" });
    }),
    tryUnapproved: vi.fn(async () => add({ ...REFUSED, id: `grade-${current.length + 1}` })),
  } satisfies DemoGradebooks;
  return grades;
}

let root: Root;
let container: HTMLElement;

const mount = async (grades: DemoGradebooks) => {
  await act(async () => root.render(<WhereItLanded grades={grades} />));
  await userEvent.click(getByRole(container, "button", { name: /^Where grades land/ }));
};

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Where it landed", () => {
  it("lets the teacher choose each class's route", async () => {
    const grades = stubGradebooks([]);
    await mount(grades);
    const group = await findByRole(container, "group", { name: "Earth Science 8 (Dana Whitaker)" });
    expect(within(group).getByRole("radio", { name: "Post to Google Classroom directly" }).getAttribute("aria-checked")).toBe("true");
    expect(queryByRole(container, "status")?.textContent).toBe("");
    expect(getByText(container, /Nothing sent yet/)).toBeDefined();

    await userEvent.click(within(group).getByRole("radio", { name: "Post through Clever LMS Connect" }));
    expect(grades.setRoute).toHaveBeenCalledWith(EARTH_SCIENCE, "clever-lms-connect");
    await vi.waitFor(() => expect(within(group).getByRole("radio", { name: "Post through Clever LMS Connect" }).getAttribute("aria-checked")).toBe("true"));
    expect(within(group).getByText(/Built to Clever's published v3.1 API; not tested against Clever/)).toBeDefined();
  });

  it("shows where each grade landed, as the gradebook holds it, and labels LMS Connect", async () => {
    await mount(stubGradebooks([IN_CLASSROOM, IN_CLEVER], "clever-lms-connect"));
    const list = await findByRole(container, "list");
    const [clever, classroom] = within(list).getAllByRole("listitem");
    expect(classroom!.textContent).toContain("Google Classroom course Earth Science 8, Period 1 (271453407972), coursework “Where does the rain go?” (143522173197): assignedGrade 4 of 5");
    expect(clever!.textContent).toContain("Clever section Earth Science 8 - Whitaker (dbfb4edc4327ef69dbfb4ddc), assignment “Where does the rain go?” (28be06b684db27fe28be07b6): grade_points 5 of 5");
    expect(clever!.textContent).toContain("Built to Clever's published v3.1 API; not tested against Clever.");
    expect(classroom!.textContent).not.toContain("not tested against Clever");
    // A retry is offered only where the class sends its grades now.
    expect(within(clever!).queryByRole("button", { name: "Send again" })).not.toBeNull();
    expect(within(classroom!).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("shows that a retry sent nothing again", async () => {
    const grades = stubGradebooks([IN_CLASSROOM]);
    await mount(grades);
    await userEvent.click(await findByRole(container, "button", { name: "Send again" }));
    expect(grades.resend).toHaveBeenCalledWith("grade-1");
    const status = getByRole(container, "status");
    await vi.waitFor(() => expect(status.textContent).toBe("An Nguyen's grade was already sent, so nothing was sent again."));
    expect(getByText(container, /This version was already sent, so nothing was sent again/)).toBeDefined();
  });

  it("shows the gate's reason when it refuses an unapproved grade", async () => {
    const grades = stubGradebooks([]);
    await mount(grades);
    await userEvent.click(await findByRole(container, "button", { name: "Try sending an unapproved grade in Earth Science 8" }));
    expect(grades.tryUnapproved).toHaveBeenCalledWith(EARTH_SCIENCE);
    const item = await findByRole(container, "listitem");
    expect(item.textContent).toContain("Refused");
    expect(item.textContent).toContain("This grade has not been approved by the offering's teacher. Nothing was written to any gradebook. (policy-violation)");
    expect(getByRole(container, "status").textContent).toBe("Refused: This grade has not been approved by the offering's teacher.");
    expect(getByRole(container, "button", { name: /^Where grades land \(0 sent, 1 refused\)/ })).toBeDefined();
  });
});
