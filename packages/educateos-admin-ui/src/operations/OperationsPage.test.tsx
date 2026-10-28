// @vitest-environment jsdom
// SCHO-263: a district administrator enrolls an EducateOS admin's ops key by pasting its
// registration and granting scopes, removes it, and reads the district's own ops log.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

/** The registration an admin edition shows, as `@educateos/admin` prints it. */
const REGISTRATION = {
  adminOrigin: "https://admin.educateos.io",
  keyId: `ed25519-${"A".repeat(43)}`,
  publicKey: "B".repeat(43),
  scopes: ["health", "analytics", "directory:read", "directory:write", "devices", "releases"],
};

describe("the Operations page", () => {
  it("is in the console's navigation", async () => {
    renderConsole(fakeDistrict().client, "operations");
    const nav = await screen.findByRole("list", { name: "Admin" });
    expect(within(nav).getByRole("link", { name: "Operations" }).getAttribute("aria-current")).toBe("page");
  });

  it("enrolls an admin with only the scopes the administrator ticks, and removes it on confirmation", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "operations");
    expect(await screen.findByText(/No admin is enrolled/)).toBeTruthy();
    const enroll = screen.getByRole("button", { name: "Enroll admin" });
    expect(enroll.hasAttribute("disabled")).toBe(true);

    const area = screen.getByRole("textbox", { name: "Registration" });
    await user.click(area);
    await user.paste("not json");
    expect(await screen.findByText(/It is JSON, starting with/)).toBeTruthy();
    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify(REGISTRATION, null, 2));

    const scopes = await screen.findByRole("group", { name: "Scopes to grant" });
    expect(within(scopes).getAllByRole("checkbox")).toHaveLength(6);
    // Nothing is granted until the administrator says so.
    expect(enroll.hasAttribute("disabled")).toBe(true);
    await user.click(within(scopes).getByRole("checkbox", { name: "Health and version" }));
    await user.click(within(scopes).getByRole("checkbox", { name: "Phones" }));
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Hosted admin");
    await user.click(screen.getByRole("button", { name: "Enroll admin" }));

    await waitFor(() => expect(district.calls.some((c) => c.name === "admin.enrollOpsKey")).toBe(true));
    expect(district.calls.find((c) => c.name === "admin.enrollOpsKey")?.input).toStrictEqual({
      body: { registration: REGISTRATION, scopes: ["health", "devices"], label: "Hosted admin" },
    });
    const table = await screen.findByRole("table", { name: "Enrolled admins" });
    const row = within(table).getByRole("row", { name: /Hosted admin/ });
    expect(within(row).getByText("Health and version")).toBeTruthy();
    expect(within(row).getByText("Phones")).toBeTruthy();
    expect(screen.getByTestId("announcer").textContent).toContain("Hosted admin can now operate this district, with 2 scopes.");

    await user.click(within(row).getByRole("button", { name: "Remove Hosted admin" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: /Hosted admin/ })).getByText("Removed")).toBeTruthy());
    expect(district.calls.find((c) => c.name === "admin.removeOpsKey")?.input).toStrictEqual({ params: { keyId: REGISTRATION.keyId } });
  });

  it("refuses a paste that is not a registration", async () => {
    const { user } = renderConsole(fakeDistrict().client, "operations");
    const area = await screen.findByRole("textbox", { name: "Registration" });
    await user.click(area);
    await user.paste(JSON.stringify({ keyId: "x" }));
    expect(await screen.findByText(/needs adminOrigin, keyId, publicKey and scopes/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Scopes to grant" })).toBeNull();
  });

  it("shows the district's own log of operations requests", async () => {
    renderConsole(fakeDistrict().client, "operations");
    const log = await screen.findByRole("table", { name: "Recent operations requests" });
    expect(within(log).getByRole("row", { name: /directory\.action · prn_fk-student-301\/suspend/ })).toBeTruthy();
    expect(within(log).getAllByText("ops@educateos.io")).toHaveLength(2);
  });
});
