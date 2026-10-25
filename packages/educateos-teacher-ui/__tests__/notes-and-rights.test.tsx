// Two rules teachers must not be able to break by accident: a teacher-only note stays with
// teachers, and a teacher can narrow a resource's rights but never widen them.
import { screen, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

describe("the teacher-only note toggle", () => {
  it("says in words who will read the note, and keeps a teacher-only note out of the student preview", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/create`);
    await onScreen(/^Create activity/);
    await user.click(await screen.findByRole("button", { name: "Add a note" }));
    const note = screen.getByRole("group", { name: "Note 1" });
    await user.type(within(note).getByRole("textbox", { name: "Note" }), "The answer is photosynthesis.");

    const toggle = within(note).getByRole("switch", { name: "Teacher only" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(within(note).getByText("Students will see this note.")).toBeTruthy();
    expect(within(note).queryByText(/students never see/)).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(within(note).getByText("Teacher only: students never see this note.")).toBeTruthy();
    expect(within(note).queryByText("Students will see this note.")).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "Title" }), "Leaves");
    await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "Why are leaves green?");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Explain.");
    await user.click(screen.getByRole("checkbox", { name: /^CCSS-ELA W\.9-10\.1 / }));
    await user.click(screen.getByRole("button", { name: "Preview as student" }));
    const preview = await screen.findByRole("region", { name: "Preview as a student" });
    expect(within(preview).queryByText(/photosynthesis/)).toBeNull();
    expect(district.callsTo("teacher.createActivity")[0]!.input.body!.activity).toMatchObject({
      codex: [{ kind: "note", body: "The answer is photosynthesis.", visibility: "teacher-only" }],
    });
  });

  it("lists what is still missing instead of sending an incomplete activity", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/create`);
    await user.click(await screen.findByRole("button", { name: "Preview as student" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Give the activity a title.")).toBeTruthy();
    // Learning goals are optional (SCHO-220), so they are not among what is missing.
    expect(within(alert).queryByText(/learning goal/)).toBeNull();
    expect(district.callsTo("teacher.createActivity")).toStrictEqual([]);
  });

  it("explains when the district allows less AI help than chosen", async () => {
    const district = fakeDistrict({ maxAiHelp: "hints-only" });
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/create`);
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Leaves");
    await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "Why are leaves green?");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Explain.");
    await user.click(screen.getByRole("checkbox", { name: /^CCSS-ELA W\.9-10\.1 / }));
    await user.click(screen.getByRole("radio", { name: /Full/ }));
    await user.click(screen.getByRole("button", { name: "Preview as student" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your district's policy doesn't allow that.");
    expect(screen.queryByRole("region", { name: "Preview as a student" })).toBeNull();
  });
});

describe("resource rights", () => {
  it("let a teacher choose narrower rights, and disable wider ones with who can grant them", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/resources`);
    await user.type(await screen.findByRole("textbox", { name: /Web address/ }), "https://open-lessons.example/persuasive-writing");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    const rights = await screen.findByRole("group", { name: "How this class may use it" });

    // The license allows excerpts: link and embed are narrower, a licensed copy would be wider.
    const option = (name: RegExp) => within(rights).getByRole("radio", { name });
    expect(option(/Excerpt/).getAttribute("aria-checked")).toBe("true");
    expect(option(/Link only/).getAttribute("aria-disabled")).not.toBe("true");
    expect(option(/Embed/).getAttribute("aria-disabled")).not.toBe("true");
    expect(option(/Licensed copy/).getAttribute("aria-disabled")).toBe("true");
    expect(within(rights).getByText(/Ask your curriculum admin to allow this\./)).toBeTruthy();
    expect(within(rights).getAllByText(/Ask your curriculum admin/)).toHaveLength(1);

    await user.click(option(/Licensed copy/));
    expect(option(/Licensed copy/).getAttribute("aria-checked")).toBe("false");
    await user.click(option(/Link only/));
    expect(option(/Link only/).getAttribute("aria-checked")).toBe("true");
  });
});
