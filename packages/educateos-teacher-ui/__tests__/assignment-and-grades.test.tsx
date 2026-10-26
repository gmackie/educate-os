// SCHO-185: moving a due date, declining a co-teacher's grade, and opening a file a student turned in.
import { screen, waitFor, within } from "@testing-library/dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";
import { formatDateTime } from "../src/dates.ts";

const forbidden = { status: 403, body: { code: "forbidden" as const, message: "no" } };
const submissionsOf = (assignmentId: string) => `#/classes/${IDS.offering}/assignments/${assignmentId}`;
const review = (submissionId: string) => `${submissionsOf(IDS.existingAssignment)}/submissions/${submissionId}`;

beforeAll(() => {
  URL.createObjectURL ??= vi.fn(() => "blob:https://teacher.northfield.example/file");
  URL.revokeObjectURL ??= vi.fn();
});

describe("an assignment's due date", () => {
  it("is moved from the activity's submissions, in the teacher's time zone, and shown in the list", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, submissionsOf(IDS.existingAssignment));
    const form = await screen.findByRole("form", { name: "Due date for Persuasive paragraph" });
    const field = within(form).getByLabelText("Due date and time") as HTMLInputElement;
    const save = within(form).getByRole("button", { name: "Save due date" });
    // Nothing to save until the date changes.
    expect(save).toHaveProperty("disabled", true);

    await user.clear(field);
    await user.type(field, "2026-11-10T08:30");
    await user.click(save);

    await waitFor(() => expect(district.callsTo("teacher.updateAssignment")).toHaveLength(1));
    expect(district.callsTo("teacher.updateAssignment")[0]!.input).toStrictEqual({
      params: { assignmentId: IDS.existingAssignment },
      body: { dueAt: new Date("2026-11-10T08:30").toISOString() },
    });
    const nav = screen.getByRole("navigation", { name: "Activities" });
    expect(await within(nav).findByText(`Due ${formatDateTime(new Date("2026-11-10T08:30").toISOString())}`)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/^Due date for Persuasive paragraph changed to /);
    // Focus stays with the form the teacher used; the list did not reload around it.
    expect(document.activeElement).toBe(save);
    expect(district.callsTo("teacher.listAssignments")).toHaveLength(1);
  });

  it("keeps the date the teacher entered when the change is refused", async () => {
    const district = fakeDistrict({ failures: { "teacher.updateAssignment": forbidden } });
    const user = await renderApp(district.client, submissionsOf(IDS.existingAssignment));
    const field = await screen.findByLabelText("Due date and time") as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "2026-12-01T09:00");
    await user.click(screen.getByRole("button", { name: "Save due date" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission to do that in this class.");
    expect(field.value).toBe("2026-12-01T09:00");
  });
});

describe("a co-teacher's proposed grade", () => {
  it("can be declined with a reason, which ends the proposal", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Uniforms limit expression.");
    const proposalId = district.propose(submissionId, { points: 6, maxPoints: 10 });
    const user = await renderApp(district.client, review(submissionId));

    expect(await screen.findByText("A co-teacher proposed 6 out of 10. It isn't official until you approve it.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Decline proposed grade" }));
    const dialog = await screen.findByRole("dialog", { name: "Decline the proposed grade?" });
    const confirm = within(dialog).getByRole("button", { name: "Decline grade" });
    // A reason is required.
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "The evidence criterion is scored too low.");
    await user.click(confirm);

    await waitFor(() => expect(district.callsTo("teacher.declineGradeProposal")).toHaveLength(1));
    expect(district.callsTo("teacher.declineGradeProposal")[0]!.input).toStrictEqual({ params: { proposalId }, body: { reason: "The evidence criterion is scored too low." } });
    expect(await screen.findByText("You declined the proposed grade. It won't become official.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/A co-teacher proposed/)).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Proposed grade declined. It won't become official.");
    expect(district.callsTo("teacher.approveGrade")).toHaveLength(0);
  });

  it("stays waiting when the district refuses the decline", async () => {
    const district = fakeDistrict({ failures: { "teacher.declineGradeProposal": forbidden } });
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Uniforms limit expression.");
    district.propose(submissionId, { points: 6, maxPoints: 10 });
    const user = await renderApp(district.client, review(submissionId));
    await user.click(await screen.findByRole("button", { name: "Decline proposed grade" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Not yet.");
    await user.click(within(dialog).getByRole("button", { name: "Decline grade" }));
    // The closing dialog still hides the page from the accessibility tree here, so look for the text.
    expect(await screen.findByText("You don't have permission to do that in this class.")).toBeTruthy();
    expect(screen.getByText(/A co-teacher proposed 6 out of 10/)).toBeTruthy();
  });
});

describe("a file a student turned in", () => {
  it("opens a PDF in place and offers it to download", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmitsFile(IDS.existingAssignment, { mediaType: "application/pdf", base64: btoa("%PDF-1.7\n%%EOF\n") });
    await renderApp(district.client, review(submissionId));
    const pdf = await screen.findByLabelText("Draft");
    expect(pdf.tagName).toBe("OBJECT");
    expect(pdf.getAttribute("type")).toBe("application/pdf");
    const download = screen.getByRole("link", { name: "Download Draft" });
    expect(download.getAttribute("download")).toBe("Draft.pdf");
    expect(download.getAttribute("href")).toMatch(/^blob:/);
  });

  it("shows a picture inline, described by which piece of work it is", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmitsFile(IDS.existingAssignment, { mediaType: "image/png", base64: btoa("\x89PNG\r\n\x1a\n") });
    await renderApp(district.client, review(submissionId));
    expect((await screen.findByRole("img", { name: "Draft" })).getAttribute("src")).toMatch(/^blob:/);
    expect(screen.getByRole("link", { name: "Download Draft" }).getAttribute("download")).toBe("Draft.png");
  });
});
