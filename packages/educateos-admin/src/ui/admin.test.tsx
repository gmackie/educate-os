// @vitest-environment jsdom
// The admin SPA's journeys against a fake admin API: workspaces with live health, enrollment, a
// workspace's analytics labelled as estimates, people and devices with confirmed actions, and the
// theme kept under the shared EducateOS key.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { THEME_KEY } from "./theme.ts";
import { fakeAdminApi, NORTHFIELD } from "./testing/fakeApi.ts";
import { renderAdmin } from "./testing/render.tsx";

describe("workspaces", () => {
  it("lists each workspace with its live health, version and origin", async () => {
    renderAdmin(fakeAdminApi());
    const row = (await screen.findByRole("link", { name: "Northfield" })).closest("tr")!;
    expect(row.textContent).toContain("northfield.educateos.io");
    await waitFor(() => expect(within(row).getByText("Healthy")).toBeTruthy());
    expect(row.textContent).toContain("r000042");
  });

  it("enrolls a district and shows what its administrator registers", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api);
    await screen.findByRole("heading", { name: "Enroll a district" });
    await user.type(screen.getByLabelText("Name"), "Riverbend");
    await user.type(screen.getByLabelText(/^Slug/), "riverbend");
    await user.type(screen.getByLabelText(/^Origin/), "https://riverbend.educateos.io");
    await user.click(screen.getByRole("button", { name: "Enroll" }));
    expect(await screen.findByText("Sign in to https://riverbend.educateos.io/admin as a district administrator.")).toBeTruthy();
    expect(api.posts()).toEqual([{ method: "POST", path: "/api/workspaces", body: { slug: "riverbend", displayName: "Riverbend", origin: "https://riverbend.educateos.io" } }]);
  });

  it("hides enrollment from a viewer", async () => {
    renderAdmin(fakeAdminApi({ me: { operator: { email: "v@educateos.io", role: "viewer" } } }));
    await screen.findByRole("link", { name: "Northfield" });
    expect(screen.queryByRole("heading", { name: "Enroll a district" })).toBeNull();
  });

  it("says why someone who isn't an operator can't get in", async () => {
    const api = fakeAdminApi();
    const fetch = api.fetch;
    api.fetch = async (input, init) => (input === "/api/me"
      ? Response.json({ code: "forbidden", message: "You are signed in, but you are not an operator of this admin." }, { status: 403 })
      : fetch(input, init));
    renderAdmin(api);
    expect(await screen.findByText("You are signed in, but you are not an operator of this admin.")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Admin sections" })).toBeNull();
  });
});

describe("a workspace", () => {
  it("shows KPI tiles with sparklines, labels sampled figures as estimates, and AI spend against budget", async () => {
    renderAdmin(fakeAdminApi(), `#/workspaces/${NORTHFIELD.id}/overview`);
    const requests = (await screen.findByRole("heading", { name: "Requests · 24h" })).parentElement!;
    expect(requests.textContent).toContain("≈ 20,000");
    expect(within(requests).getByTestId("sparkline-requests")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Error rate" }).parentElement!.textContent).toContain("0.25%");
    expect(screen.getByRole("heading", { name: "p95 latency" }).parentElement!.textContent).toContain("140 ms");
    expect(screen.getByRole("heading", { name: "AI spend · month" }).parentElement!.textContent).toContain("$12.50 of $50.00");
    expect(screen.getByText(/Figures marked ≈ are estimates/)).toBeTruthy();
  });

  it("asks for another window, and for a refresh", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api, `#/workspaces/${NORTHFIELD.id}/traffic`);
    await screen.findByText("northfield-district");
    await user.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(api.requests.some((r) => r.path === `/api/workspaces/${NORTHFIELD.id}/analytics?range=7d`)).toBe(true));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.requests.some((r) => r.path === `/api/workspaces/${NORTHFIELD.id}/analytics?range=7d&refresh=1`)).toBe(true));
  });

  it("has every tab, and shows releases, domains and the audit", async () => {
    const { user } = renderAdmin(fakeAdminApi(), `#/workspaces/${NORTHFIELD.id}/releases`);
    const tabs = await screen.findByRole("navigation", { name: "Northfield sections" });
    expect(within(tabs).getAllByRole("link").map((l) => l.textContent)).toEqual(["Overview", "Traffic", "AI", "Storage", "Sign-ins", "Domains", "Releases", "Settings", "Audit"]);
    expect(await screen.findByText("r000043")).toBeTruthy();
    await user.click(within(tabs).getByRole("link", { name: "Domains" }));
    expect(await screen.findByText(/later release/)).toBeTruthy();
    await user.click(within(tabs).getByRole("link", { name: "Audit" }));
    expect(await screen.findByText("workspace.enroll")).toBeTruthy();
  });
});

describe("users", () => {
  it("searches, opens a person, and suspends them only after confirming", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api, "#/users");
    await user.type(await screen.findByLabelText(/^Search/), "ada");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.requests.some((r) => r.path === `/api/workspaces/${NORTHFIELD.id}/directory?query=ada`)).toBe(true));
    await user.click(await screen.findByRole("button", { name: "Ada Quillfeather" }));
    expect(await screen.findByText(/Rostered from the student information system/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Suspend Ada Quillfeather?");
    expect(api.posts()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(api.posts()).toEqual([{ method: "POST", path: `/api/workspaces/${NORTHFIELD.id}/directory/prn_ada/suspend`, body: {} }]));
    await waitFor(() => expect(screen.getByTestId("announcer").textContent).toBe("Suspended."));
  });

  it("sends nothing when an action is cancelled", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api, "#/users");
    await user.click(await screen.findByRole("button", { name: "Ada Quillfeather" }));
    await user.click(await screen.findByRole("button", { name: "Turn AI off" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(api.posts()).toEqual([]);
  });
});

describe("devices", () => {
  it("revokes one device after confirming", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api, "#/devices");
    await user.click(await screen.findByRole("button", { name: "Revoke Ada's Pixel" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.posts()).toEqual([{ method: "POST", path: `/api/workspaces/${NORTHFIELD.id}/devices/dev_1/revoke`, body: {} }]));
  });

  it("forces an update below a version, and refuses a version that isn't major.minor.patch", async () => {
    const api = fakeAdminApi();
    const { user } = renderAdmin(api, "#/devices");
    const input = await screen.findByLabelText(/^Revoke every device below version/);
    await user.type(input, "latest");
    await user.click(screen.getByRole("button", { name: "Revoke below version" }));
    expect(await screen.findByText(/Enter a version as major.minor.patch/)).toBeTruthy();
    await user.clear(input);
    await user.type(input, "1.2.0");
    await user.click(screen.getByRole("button", { name: "Revoke below version" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.posts()).toEqual([{ method: "POST", path: `/api/workspaces/${NORTHFIELD.id}/devices/revoke-below-version`, body: { minimumVersion: "1.2.0" } }]));
    await waitFor(() => expect(screen.getByTestId("announcer").textContent).toBe("Revoked 3 devices below 1.2.0."));
  });
});

describe("theme", () => {
  it("switches between light and dark and remembers it under the shared EducateOS key", async () => {
    const { user } = renderAdmin(fakeAdminApi());
    const button = await screen.findByRole("button", { name: /^Theme:/ });
    await user.click(button);
    await user.click(button);
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(THEME_KEY).toBe("educateos:theme-mode");
  });
});
