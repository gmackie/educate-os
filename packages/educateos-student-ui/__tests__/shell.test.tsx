// The Learning Home in the district shell (SCHO-260): each role's navigation, the pages every role
// shares, "Ask AI about this" only where the district has AI, and the one-time phone banner.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { DistrictApiClient, RouteName, RouteResponse } from "@educateos/api-client";
import { PHONE_BANNER_DISMISSED_KEY } from "../src/devices/PhoneBanner.tsx";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { fakeFamily } from "./fakeFamily.ts";
import { openAccountMenu, renderApp, schoolWith } from "./render.tsx";

type Me = RouteResponse<"me.get">;

/** `district`, answering `me.get` as `me` does. */
const signedInAs = (district: DistrictApiClient, me: Partial<Me>): DistrictApiClient => ({
  call: ((name: RouteName, ...args: never[]) =>
    name === "me.get"
      ? district.call("me.get").then((base) => ({ ...base, ...me }))
      : (district.call as (name: RouteName, ...rest: never[]) => Promise<unknown>)(name, ...args)) as DistrictApiClient["call"],
});

const TEACHER: Partial<Me> = { principalId: "prn_nf-teacher-rivera" as Me["principalId"], kind: "staff", displayName: "Sam Rivera", roles: [], enrollments: [] };
const ADMIN: Partial<Me> = { ...TEACHER, displayName: "Avery Admin", roles: [{ role: "district-admin", scope: { level: "district", districtId: "dst_northfield" } }] as Me["roles"] };

const navLinks = () => within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link");
const navTo = () => navLinks().map((link) => [link.textContent, link.getAttribute("href")]);

describe("the navigation for each role", () => {
  it("gives a student their places, with the AI workspace only where the district has AI", async () => {
    await renderApp(fakeDistrict());
    await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" });
    expect(navTo()).toStrictEqual([
      ["Home", "/"], ["Classes", "/#my-courses"], ["Calendar", "/calendar"], ["Inbox", "/notifications"], ["Grades", "/grades"], ["My Space", "/my-space"],
    ]);
    expect(screen.getByRole("button", { name: /Amara Okafor.*Student.*account menu/ })).toBeTruthy();
  });

  it("links the AI workspace as another app on the origin, not a route of this one", async () => {
    await renderApp(fakeDistrict(), "/", undefined, undefined, { school: schoolWith({ ai: true }) });
    await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" });
    expect(navLinks().map((link) => link.textContent)).toContain("AI workspace");
    const ai = within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "AI workspace" });
    expect(ai.getAttribute("href")).toBe("/ai/");
  });

  it("gives a teacher who opens Your devices their own role's places, in Teacher Studio", async () => {
    await renderApp(signedInAs(fakeDistrict(), TEACHER), "/devices");
    await screen.findByRole("heading", { level: 1, name: "Your devices" });
    expect(navTo()).toStrictEqual([
      ["Today", "/teach/"], ["Classes", "/teach/#/classes"], ["Gradebook", "/teach/#/classes"], ["Calendar", "/calendar"], ["Inbox", "/notifications"], ["Content studio", "/teach/#/classes"],
    ]);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Northfield" }).getAttribute("href")).toBe("/teach/");
    expect(screen.getByRole("button", { name: /Sam Rivera.*Teacher.*account menu/ })).toBeTruthy();
  });

  it("adds the admin console for a school admin", async () => {
    await renderApp(signedInAs(fakeDistrict(), ADMIN), "/devices");
    await screen.findByRole("heading", { level: 1, name: "Your devices" });
    const admin = within(screen.getByRole("navigation", { name: "Main" })).getByRole("list", { name: "Admin" });
    expect(within(admin).getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/admin/#/dashboard");
    expect(screen.getByRole("button", { name: /Avery Admin.*School admin.*account menu/ })).toBeTruthy();
  });

  it("lets a guardian reach Your devices, with the family's places only", async () => {
    await renderApp(fakeFamily(), "/devices");
    expect(await screen.findByRole("heading", { level: 1, name: "Your devices" })).toBeTruthy();
    expect(navTo()).toStrictEqual([["Family", "/family"]]);
    // Anywhere else still takes a guardian to the family view.
    await renderApp(fakeFamily(), "/grades");
    expect(await screen.findByRole("heading", { level: 1, name: "Amara Okafor's classes" })).toBeTruthy();
  });

  it("offers Connect phone and Your devices in the account menu where the district has the app, and opens them in place", async () => {
    const user = userEvent.setup();
    await renderApp(fakeDistrict(), "/", undefined, undefined, { school: schoolWith({ mobile: true }) });
    await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" });
    const menu = await openAccountMenu();
    expect(within(menu).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toStrictEqual([
      ["Connect phone", "/devices/connect"], ["Your devices", "/devices"],
    ]);
    await user.click(within(menu).getByRole("link", { name: "Your devices" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Your devices" })).toBeTruthy();
  });
});

describe("Ask AI about this", () => {
  const activity = `/courses/${ENGLISH}/activities/${ESSAY}`;

  it("is not offered where the district has no AI", async () => {
    await renderApp(fakeDistrict(), activity);
    await screen.findByRole("heading", { level: 1, name: "Should the school day start later?" });
    expect(screen.queryByRole("link", { name: /Ask AI/ })).toBeNull();
  });

  it("is not offered by a host that embeds the app, which has no manifest", async () => {
    await renderApp(fakeDistrict(), activity, undefined, undefined, { school: false });
    await screen.findByRole("heading", { level: 1, name: "Should the school day start later?" });
    expect(screen.queryByRole("link", { name: /Ask AI/ })).toBeNull();
  });

  it("opens the AI workspace with the assignment as its context where the district has AI", async () => {
    await renderApp(fakeDistrict(), activity, undefined, undefined, { school: schoolWith({ ai: true }) });
    await screen.findByRole("heading", { level: 1, name: "Should the school day start later?" });
    const ask = screen.getByRole("link", { name: "Ask AI about this" });
    expect(ask.getAttribute("href")).toBe(`/ai/?context=assignment:${ESSAY}`);
  });
});

describe("the phone banner on Home", () => {
  it("is not shown where the district has no phone app", async () => {
    await renderApp(fakeDistrict());
    await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" });
    expect(screen.queryByRole("region", { name: "Get Northfield on your phone" })).toBeNull();
  });

  it("offers the code, and once dismissed stays dismissed in this browser", async () => {
    const user = userEvent.setup();
    const school = schoolWith({ mobile: true });
    const first = await renderApp(fakeDistrict(), "/", undefined, undefined, { school });
    const banner = await screen.findByRole("region", { name: "Get Northfield on your phone" });
    expect(within(banner).getByRole("link", { name: "Show code" }).getAttribute("href")).toBe("/devices/connect");

    await user.click(within(banner).getByRole("button", { name: "Dismiss: Get Northfield on your phone" }));
    expect(screen.queryByRole("region", { name: "Get Northfield on your phone" })).toBeNull();
    expect(localStorage.getItem(PHONE_BANNER_DISMISSED_KEY)).toBe("true");

    first.unmount();
    await renderApp(fakeDistrict(), "/", undefined, undefined, { school });
    await screen.findByRole("heading", { level: 1, name: "Hi, Amara Okafor" });
    expect(screen.queryByRole("region", { name: "Get Northfield on your phone" })).toBeNull();
  });
});
