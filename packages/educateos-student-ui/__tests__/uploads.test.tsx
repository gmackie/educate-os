import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { MAX_UPLOAD_BYTES } from "@educateos/api-client";
import { LAB_REPORT, SCIENCE, fakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const LABEL = "Upload a file (PDF, text or Markdown)";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const pdf = (bytes: Uint8Array<ArrayBuffer> = PDF_BYTES, name = "Lab report.pdf") => new File([bytes], name, { type: "application/pdf" });

async function openLabReport() {
  const district = fakeDistrict();
  await renderApp(district, `/courses/${SCIENCE}/activities/${LAB_REPORT}`);
  const input = await screen.findByLabelText(LABEL);
  return { district, input: input as HTMLInputElement };
}

describe("uploading a file as work", () => {
  it("saves a PDF as the file itself as soon as it is chosen, and shows it", async () => {
    const { district, input } = await openLabReport();
    const user = userEvent.setup();
    // The picker is a native file input, so it is in the tab order under its label.
    expect(input.getAttribute("accept")).toBe(".pdf,application/pdf,.txt,text/plain,.md,text/markdown");
    await user.upload(input, pdf());

    expect(await screen.findByRole("link", { name: "Open Osmosis lab report: Upload your lab report (PDF)" })).toBeTruthy();
    const created = district.calls.find((call) => call.name === "student.createArtifact");
    expect(created?.input).toMatchObject({
      body: { type: "document", title: "Osmosis lab report: Upload your lab report", content: { kind: "bytes", mediaType: "application/pdf", base64: btoa("%PDF-1.7\n%%EOF\n") } },
    });
    expect(announcement()).toMatch(/Lab report.pdf saved for Upload your lab report/);
    // The saved version can be submitted straight away: there is nothing unsaved.
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty("disabled", false);

    // Choosing another file saves it as the next version of the same work.
    await user.upload(input, new File(["Mass fell in salt water."], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText("Mass fell in salt water.")).toBeTruthy();
    expect(district.calls.find((call) => call.name === "student.saveRevision")?.input).toMatchObject({
      body: { content: { kind: "text", mediaType: "text/plain", text: "Mass fell in salt water." } },
    });
  });

  it("refuses a file of another type, or one that is too big, before sending anything", async () => {
    const { district, input } = await openLabReport();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["GIF89a"], "diagram.gif", { type: "image/gif" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose a PDF, text or Markdown file.");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);

    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PDF_BYTES);
    await user.upload(input, pdf(big));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That file is too big. Choose one under 5 MB."));
    expect(district.calls.some((call) => call.name === "student.createArtifact")).toBe(false);
  });

  it("keeps a file whose save failed, and saves it on Try again", async () => {
    const { district, input } = await openLabReport();
    const user = userEvent.setup();
    district.failNext("student.createArtifact", "network");
    await user.upload(input, pdf());

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("Lab report.pdf was not saved")).toBeTruthy();
    expect(announcement()).toBe("Lab report.pdf was not saved.");
    await user.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /\(PDF\)$/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(district.calls.filter((call) => call.name === "student.createArtifact")).toHaveLength(2);
  });
});
