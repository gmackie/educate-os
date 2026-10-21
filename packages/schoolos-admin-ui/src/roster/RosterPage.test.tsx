// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const csv = (name: string, text = "sourcedId\n1\n") => new File([text], name, { type: "text/csv" });

describe("roster import", () => {
  it("previews an export with its quarantine list, then applies it only after a confirmation that nothing is deleted", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "roster");

    await user.upload(await screen.findByLabelText("OneRoster CSV files"), [csv("users.csv", "sourcedId,username\nu-301,s301\n"), csv("enrollments.csv")]);
    await user.click(screen.getByRole("button", { name: "Preview import" }));

    // Changes per record type.
    const changes = await screen.findByRole("table", { name: "Records added, updated and deactivated by type" });
    const people = within(changes).getByRole("row", { name: /^People/ });
    expect(within(people).getAllByRole("cell").map((c) => c.textContent)).toStrictEqual(["People", "2", "0", "1", "0"]);

    // The quarantined user, with the reason and the next step.
    const held = screen.getByRole("region", { name: "Held for review (1)" });
    expect(within(held).getByText("Sign-in identity differs from the one this person already uses")).toBeTruthy();
    expect(within(held).getByText("users.csv row 7")).toBeTruthy();
    expect(within(held).getByText("2 class enrollments held unchanged.")).toBeTruthy();
    expect(within(held).getByText(/restore the previous sign-in in your student information system/)).toBeTruthy();

    // The files went to the district as name to text, and previewing applied nothing.
    const previewCall = district.calls.find((c) => c.name === "admin.previewRoster")!;
    expect(previewCall.input).toStrictEqual({ body: { files: { "users.csv": "sourcedId,username\nu-301,s301\n", "enrollments.csv": "sourcedId\n1\n" } } });
    expect(district.calls.some((c) => c.name === "admin.applyRoster")).toBe(false);

    // Applying asks first, and says nothing is deleted.
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Apply this roster import?" });
    expect(within(confirm).getByText(/^Nothing is deleted\./)).toBeTruthy();
    expect(within(confirm).getByText(/1 user held for review will be left as they are/)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Apply import" }));

    expect(await screen.findByText("Import applied")).toBeTruthy();
    expect(district.calls.filter((c) => c.name === "admin.applyRoster")).toHaveLength(1);
    const history = screen.getByRole("table", { name: "Roster imports applied in this session" });
    const run = within(history).getAllByRole("row")[1]!;
    // Two files; 7 added, 4 updated, 2 deactivated; 1 held; 1 grant removed.
    expect(within(run).getAllByRole("cell").slice(1).map((c) => c.textContent)).toStrictEqual(["2", "7", "4", "2", "1", "1"]);
  });

  it("cancelling the confirmation applies nothing", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "roster");
    await user.upload(await screen.findByLabelText("OneRoster CSV files"), [csv("users.csv")]);
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await user.click(await screen.findByRole("button", { name: "Apply import" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(district.calls.some((c) => c.name === "admin.applyRoster")).toBe(false);
  });

  it("refuses file names the district would not accept, before sending anything", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "roster");
    await user.upload(await screen.findByLabelText("OneRoster CSV files"), [csv("users (1).csv")]);
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    expect(await screen.findByText("These are not OneRoster CSV file names: users (1).csv.")).toBeTruthy();
    expect(district.calls.some((c) => c.name === "admin.previewRoster")).toBe(false);
  });
});
