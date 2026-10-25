// Every critical path works from the keyboard alone, and every screen exposes its landmarks,
// one main heading and a name for every control.
import { screen, waitFor, within, type ByRoleMatcher } from "@testing-library/dom";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

/** Presses Tab until the control with `role` and `name` has focus, as a keyboard user would. */
const tabTo = async (user: UserEvent, role: ByRoleMatcher, name: string | RegExp) => {
  for (let presses = 0; presses < 150; presses++) {
    await user.tab();
    const target = screen.queryAllByRole(role, { name }).find((element) => element === document.activeElement);
    if (target !== undefined) return target;
  }
  throw new Error(`no ${String(role)} named ${String(name)} is reachable with Tab`);
};

/** Every control on screen of `role` has an accessible name. */
const allNamed = (role: ByRoleMatcher) => {
  const all = screen.queryAllByRole(role);
  expect(screen.queryAllByRole(role, { name: /\S/ })).toHaveLength(all.length);
};

const expectWellFormed = () => {
  expect(screen.getByRole("banner")).toBeTruthy();
  expect(screen.getByRole("main")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  for (const role of ["button", "link", "textbox", "checkbox", "radio", "switch"] as const) allNamed(role);
};

describe("keyboard-only use", () => {
  it("imports and approves a resource, writes a teacher-only note, scores work and approves a grade without a pointer", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Sleep matters for learning.");
    district.suggest(submissionId, { criterionId: "argument", points: 4, maxPoints: 4, suggester: { kind: "ai", modelId: "synthetic-demo-model" } });
    const user = await renderApp(district.client);
    await onScreen("My classes");

    await tabTo(user, "link", /English 9 · Period 3/);
    await user.keyboard("{Enter}");
    await onScreen(/^Roster/);
    // The new screen's heading takes focus, so the next Tab starts from the top of the screen.
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));

    await tabTo(user, "link", "Resources");
    await user.keyboard("{Enter}");
    await onScreen(/^Resources/);
    await tabTo(user, "textbox", /Web address/);
    await user.keyboard("https://open-lessons.example/persuasive-writing{Enter}");
    await onScreen("Persuasive Writing Models");
    await tabTo(user, "button", "Approve for this class");
    await user.keyboard("{Enter}");
    await screen.findByText("You've decided on this resource.");

    await tabTo(user, "link", "Create activity");
    await user.keyboard("{Enter}");
    await onScreen(/^Create activity/);
    await tabTo(user, "button", "Add a note");
    await user.keyboard("{Enter}");
    await tabTo(user, "switch", "Teacher only");
    await user.keyboard(" ");
    expect(await screen.findByText("Teacher only: students never see this note.")).toBeTruthy();

    await tabTo(user, "link", "Submissions");
    await user.keyboard("{Enter}");
    await onScreen(/^Submissions/);
    await tabTo(user, "link", /Persuasive paragraph/);
    await user.keyboard("{Enter}");
    await tabTo(user, "link", "Review Amara Okafor’s work");
    await user.keyboard("{Enter}");
    await onScreen(/Amara Okafor’s work/);

    await tabTo(user, "textbox", "Your score for argument");
    await user.keyboard("3{Enter}");
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("3"));

    await tabTo(user, "button", "Approve official grade");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Approve the official grade?" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const confirm = within(dialog).getByRole("button", { name: "Yes, approve official grade" });
    for (let presses = 0; presses < 5 && document.activeElement !== confirm; presses++) await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{Enter}");
    await screen.findByText("Official");
    expect(district.callsTo("teacher.recordGrade").map((c) => c.input.body)).toStrictEqual([{ score: { points: 3, maxPoints: 4 } }]);
  });
});

describe("roles and labels", () => {
  it("give every screen its landmarks, one main heading, named controls and the current section", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Sleep matters for learning.");
    district.suggest(submissionId, { criterionId: "argument", points: 4, maxPoints: 4, suggester: { kind: "ai", modelId: "synthetic-demo-model" } });
    const user = await renderApp(district.client);
    await screen.findByText("1 student");
    expectWellFormed();

    const screens = [
      { section: "Roster", heading: /^Roster/ },
      { section: "Resources", heading: /^Resources/ },
      { section: "Create activity", heading: /^Create activity/ },
      { section: "Submissions", heading: /^Submissions/ },
    ];
    await user.click(screen.getByRole("link", { name: /English 9/ }));
    await onScreen(/^Roster/);
    for (const { section, heading } of screens) {
      await user.click(screen.getByRole("link", { name: section }));
      await onScreen(heading);
      await waitFor(() => expect(screen.queryAllByRole("status").filter((s) => s.textContent?.startsWith("Loading") || s.textContent?.startsWith("Getting"))).toHaveLength(0));
      expectWellFormed();
      const sections = screen.getByRole("navigation", { name: "Class sections" });
      expect(within(sections).getByRole("link", { name: section }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    }

    await user.click(screen.getByRole("link", { name: /Persuasive paragraph/ }));
    await user.click(await screen.findByRole("link", { name: "Review Amara Okafor’s work" }));
    await screen.findByRole("group", { name: "argument" });
    expectWellFormed();
    expect(screen.getByRole("region", { name: "Submitted work 1" }).getAttribute("tabindex")).toBe("0");
    // Assistive technology hears what each action changed.
    expect(screen.getAllByRole("status").some((s) => s.getAttribute("aria-live") === "polite")).toBe(true);
  });
});
