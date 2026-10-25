// @vitest-environment jsdom
// SCHO-220: an administrator approves the built-in standards teachers choose learning goals from.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

describe("the Learning standards page", () => {
  it("lists the built-in standards and approves one", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "learning-standards");
    const table = await screen.findByRole("table", { name: "Learning standards built into EducateOS" });
    const ela = within(table).getByRole("row", { name: /English Language Arts/ });
    expect(within(ela).getAllByRole("cell").slice(1, 4).map((cell) => cell.textContent)).toStrictEqual(["English language arts", "K-2, 3-5, 6-8, 9-12", "Not approved"]);
    expect(screen.getByText(/Next Generation Science Standards, are not built in/)).toBeTruthy();

    await user.click(within(ela).getByRole("button", { name: /^Approve Common Core/ }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: /English Language Arts/ })).getByText("Approved")).toBeTruthy());
    expect(district.calls.find((c) => c.name === "admin.approveStandards")?.input).toStrictEqual({ params: { frameworkKey: "ccss-ela" } });
    expect(screen.getByTestId("announcer").textContent).toContain("Teachers can now choose its learning goals.");
  });

  it("asks before withdrawing approved standards, and withdraws only on confirmation", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "learning-standards");
    await user.click(await screen.findByRole("button", { name: /^Approve College, Career/ }));
    const withdraw = await screen.findByRole("button", { name: /^Withdraw College, Career/ });

    await user.click(withdraw);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(district.calls.some((c) => c.name === "admin.withdrawStandards")).toBe(false);

    await user.click(screen.getByRole("button", { name: /^Withdraw College, Career/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw standards" }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: /College, Career/ })).getByText("Not approved")).toBeTruthy());
    expect(district.calls.filter((c) => c.name === "admin.withdrawStandards")).toHaveLength(1);
  });
});
