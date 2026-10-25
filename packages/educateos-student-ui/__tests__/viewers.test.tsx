import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { ArtifactRead } from "../src/model.ts";
import { ArtifactViewer } from "../src/viewers/ArtifactViewer.tsx";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

const read = (mediaType: string, content: ArtifactRead["content"], title = "My work"): ArtifactRead =>
  ({ artifact: { title }, revision: { mediaType }, content }) as unknown as ArtifactRead;

async function view(artifact: ArtifactRead): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(<ArtifactViewer read={artifact} />));
  return container;
}

describe("artifact viewers", () => {
  it("shows CSV as a table with its header row", async () => {
    const container = await view(read("text/csv", { kind: "text", text: 'Concentration (M),Note\n0.5,"salty, cloudy"\n' }, "Lab data"));
    const table = within(container).getByRole("table", { name: "Lab data" });
    expect(within(table).getByRole("columnheader", { name: "Concentration (M)" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "salty, cloudy" })).toBeTruthy();
  });

  it("shows an image with its title as the alternative text", async () => {
    const container = await view(read("image/png", { kind: "bytes", base64: btoa("png") }, "My sketch"));
    expect(within(container).getByRole("img", { name: "My sketch" }).getAttribute("src")).toMatch(/^blob:/);
  });

  it("shows a PDF in an object, with a link to open it as the fallback", async () => {
    const container = await view(read("application/pdf", { kind: "bytes", base64: btoa("%PDF") }, "Lab report"));
    const object = container.querySelector("object")!;
    expect(object.getAttribute("type")).toBe("application/pdf");
    expect(within(object).getByRole("link", { name: "Open Lab report (PDF)" })).toBeTruthy();
  });

  it("opens an external link in a new tab with no opener or referrer", async () => {
    const container = await view(read("application/vnd.educateos.external-ref+json", { kind: "external", url: "https://docs.northfield.example/d/123" }, "Shared slides"));
    const link = within(container).getByRole("link", { name: /Shared slides/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(container).getByText("docs.northfield.example")).toBeTruthy();
  });

  it("never turns a non-https link into an anchor", async () => {
    const container = await view(read("application/vnd.educateos.external-ref+json", { kind: "external", url: "javascript:alert(1)" }, "Suspicious"));
    expect(within(container).queryByRole("link")).toBeNull();
    expect(within(container).getByText("Suspicious")).toBeTruthy();
  });
});

describe("history", () => {
  it("lists saved versions newest first and opens an old one read-only", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, `/courses/${ENGLISH}/activities/${ESSAY}`);
    const editor = await screen.findByRole("textbox", { name: "Your work for Draft your argument" });
    expect(screen.getByRole("button", { name: "History" })).toHaveProperty("disabled", true);

    await user.type(editor, "Version one.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved /);
    await user.clear(editor);
    await user.type(editor, "Version two.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved /);

    const history = screen.getByRole("button", { name: "History" });
    await user.click(history);
    expect(history.getAttribute("aria-expanded")).toBe("true");
    const versions = await screen.findByRole("list", { name: "Saved versions" });
    expect(within(versions).getAllByRole("listitem").map((item) => item.textContent?.match(/^Version \d/)?.[0])).toStrictEqual(["Version 2", "Version 1"]);

    await user.click(within(versions).getByRole("button", { name: /^View Version 1,/ }));
    const old = await screen.findByRole("region", { name: /^Version 1, saved/ });
    expect(await within(old).findByText("Version one.")).toBeTruthy();
    expect(editor).toHaveProperty("value", "Version two.");
  });
});
