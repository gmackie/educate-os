// Teacher Studio in the district shell (SCHO-260): the role's navigation, the skip link that keeps
// the hash route, "Ask AI about this" on a submission only where the district has AI, and the
// unframed app a host embeds.
import { screen, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import type { DistrictApiClient, RouteName } from "@educateos/api-client";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp, schoolWith } from "./render.tsx";

const navTo = () =>
  within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]);

/** `client`, answering `me.get` with a district administrator's roles. */
const asAdmin = (client: DistrictApiClient): DistrictApiClient => ({
  call: ((name: RouteName, ...args: never[]) =>
    name === "me.get"
      ? client.call("me.get").then((me) => ({ ...me, roles: [{ role: "district-admin", scope: { level: "district", districtId: IDS.district } }] }))
      : (client.call as (name: RouteName, ...rest: never[]) => Promise<unknown>)(name, ...args)) as DistrictApiClient["call"],
});

describe("Teacher Studio in the district shell", () => {
  it("gives a teacher their role's places across the origin, and names them in the account menu", async () => {
    await renderApp(fakeDistrict().client);
    await onScreen("My classes");
    expect(navTo()).toStrictEqual([
      ["Today", "/teach/"], ["Classes", "/teach/#/classes"], ["Gradebook", "/teach/#/classes"], ["Calendar", "/calendar"], ["Inbox", "/notifications"], ["Content studio", "/teach/#/classes"],
    ]);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Northfield" }).getAttribute("href")).toBe("/teach/");
    expect(await screen.findByRole("button", { name: /Sam Rivera.*Teacher.*account menu/ })).toBeTruthy();
  });

  it("adds the AI workspace where the district has AI, and the admin console for a school admin", async () => {
    await renderApp(asAdmin(fakeDistrict().client), "#/", schoolWith({ ai: true }));
    await onScreen("My classes");
    await screen.findByRole("button", { name: /School admin.*account menu/ });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "AI workspace" }).getAttribute("href")).toBe("/ai/");
    expect(within(within(nav).getByRole("list", { name: "Admin" })).getByRole("link", { name: "AI budgets" }).getAttribute("href")).toBe("/admin/#/ai-budgets");
  });

  it("skips to the content without leaving the screen the hash names", async () => {
    const user = await renderApp(fakeDistrict().client, `#/classes/${IDS.offering}/roster`);
    await onScreen(/^Roster/);
    await user.click(screen.getByRole("link", { name: "Skip to content" }));
    expect(window.location.hash).toBe(`#/classes/${IDS.offering}/roster`);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("keeps its own header, with no shell, where a host embeds it", async () => {
    await renderApp(fakeDistrict().client, "#/", false);
    await onScreen("My classes");
    expect(within(screen.getByRole("banner")).getByText("Teacher Studio")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});

describe("Ask AI about this, on a submission", () => {
  const review = (submissionId: string) => `#/classes/${IDS.offering}/assignments/${IDS.existingAssignment}/submissions/${submissionId}`;

  it.each([
    ["where the district has no AI", undefined],
    ["by a host that embeds Teacher Studio", false],
  ] as const)("is not offered %s", async (_, school) => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Sleep matters for learning.");
    await renderApp(district.client, review(submissionId), school);
    await onScreen(/Amara Okafor’s work/);
    expect(screen.queryByRole("link", { name: /Ask AI/ })).toBeNull();
  });

  it("opens the AI workspace with the submission as its context where the district has AI", async () => {
    const district = fakeDistrict();
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Sleep matters for learning.");
    await renderApp(district.client, review(submissionId), schoolWith({ ai: true }));
    await onScreen(/Amara Okafor’s work/);
    expect(screen.getByRole("link", { name: "Ask AI about this" }).getAttribute("href")).toBe(`/ai/?context=submission:${encodeURIComponent(submissionId)}`);
  });
});
