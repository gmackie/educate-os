import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const PERSONAL = "Only you can see this";
const COURSE = "Your teacher can see work you submit or share";

describe("the student journey", () => {
  it("goes Home → course → activity → save → submit → receipt → feedback", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district);

    // Home: this term's classes and my space, each saying who can see it, and the finished class apart.
    expect(await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" })).toBeTruthy();
    const courses = screen.getByRole("region", { name: "My courses" });
    expect(within(courses).getByText(COURSE)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "My space" })).getByText(PERSONAL)).toBeTruthy();
    const past = screen.getByRole("region", { name: "Past courses (read-only)" });
    expect(await within(past).findByRole("link", { name: "Art · Period 2" })).toBeTruthy();

    // Course: the activity with its due date and status.
    await user.click(await within(courses).findByRole("link", { name: "English 9 · Period 3" }));
    expect(await screen.findByRole("heading", { level: 1, name: "English 9 · Period 3" })).toBeTruthy();
    expect(screen.getByText(COURSE)).toBeTruthy();
    const row = (await screen.findByRole("link", { name: "Should the school day start later?" })).closest("li")!;
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-03T21:00:00.000Z");
    expect(await within(row).findByText("Not started")).toBeTruthy();

    // Activity: instructions, then resources, then my work.
    await user.click(within(row).getByRole("link", { name: "Should the school day start later?" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Should the school day start later?" })).toBeTruthy();
    const sections = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"));
    expect(sections.slice(0, 3)).toStrictEqual(["instructions", "resources", "my-work"]);
    expect(screen.getByText(COURSE)).toBeTruthy();

    const editor = await screen.findByRole("textbox", { name: "Your work for Draft your argument" });
    await user.type(editor, "School should start later.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved /)).toBeTruthy();
    expect(announcement()).toMatch(/Draft your argument saved/);
    const created = district.calls.find((call) => call.name === "student.createArtifact");
    expect(created?.input).toMatchObject({ body: { workspaceId: "wsp_amara-eng9", type: "document", title: "Should the school day start later?: Draft your argument", content: { kind: "text", mediaType: "text/plain", text: "School should start later." } } });

    // Submit: confirm, then the receipt with its code.
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const confirm = await screen.findByRole("dialog", { name: "Submit your work?" });
    expect(within(confirm).getByText("Draft your argument")).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Submit" }));
    const receipt = await screen.findByRole("dialog", { name: "Submitted" });
    const code = within(receipt).getByText(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/).textContent!;
    expect(within(receipt).getByText("Receipt code")).toBeTruthy();
    expect(district.calls.find((call) => call.name === "student.submit")?.input).toMatchObject({ params: { assignmentId: ESSAY }, body: { revisions: [{ artifactId: expect.any(String), revisionId: expect.any(String) }] } });
    await user.click(within(receipt).getByRole("button", { name: "Done" }));

    // Feedback: nothing until the teacher releases it, then their comments and criterion results.
    const feedback = screen.getByRole("region", { name: "Grade and feedback" });
    expect(await within(feedback).findByText(/No feedback yet/)).toBeTruthy();
    expect(within(feedback).getByText(code)).toBeTruthy();
    district.releaseFeedback(district.submissions[0]!.id, { comments: ["A clear claim. Add evidence."], scores: [{ criterionId: "use-of-evidence", points: 2, maxPoints: 4 }] });

    // Back to the class through the breadcrumbs (Kumo renders them once per breakpoint).
    await user.click(screen.getAllByRole("link", { name: "English 9 · Period 3" })[0]!);
    expect(await screen.findByText("Feedback ready")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Should the school day start later?" }));
    const released = await screen.findByRole("region", { name: "Grade and feedback" });
    expect(await within(released).findByText("A clear claim. Add evidence.")).toBeTruthy();
    const results = within(released).getByRole("table", { name: "Criterion results" });
    expect(within(results).getByRole("row", { name: "Use of evidence 2 of 4" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Your work for Draft your argument" })).toHaveProperty("value", "School should start later.");
  });
});
