import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { DistrictApiError } from "@schoolos/api-client";
import { fakeDistrict } from "./fakeDistrict.ts";
import { AMARA, ENGLISH, fakeFamily } from "./fakeFamily.ts";
import { announcement, renderApp } from "./render.tsx";

/** Presses Tab until `target` has focus, failing if it is not in the Tab order. */
async function tabTo(user: UserEvent, target: HTMLElement): Promise<void> {
  for (let presses = 0; presses < 80; presses++) {
    if (document.activeElement === target) return;
    await user.tab();
  }
  throw new Error(`could not reach ${target.outerHTML.slice(0, 120)} with Tab`);
}

describe("the family view (ADR-0012)", () => {
  it("takes a guardian from anywhere to their first child's classes, this term's and finished ones", async () => {
    const family = fakeFamily();
    await renderApp(family, "/my-space");
    expect(await screen.findByRole("heading", { level: 1, name: "Amara Okafor's classes" })).toBeTruthy();
    expect(screen.getByText("You see what Amara Okafor's teachers have shared with Amara Okafor. You never see Amara Okafor's own work or personal space.")).toBeTruthy();
    const current = screen.getByRole("region", { name: "This term" });
    expect(within(current).getByRole("link", { name: "English 9 · Period 3" })).toBeTruthy();
    const past = screen.getByRole("region", { name: "Finished classes" });
    expect(within(past).getByRole("link", { name: "Art · Period 2" })).toBeTruthy();
    expect(within(past).getByText("Finished")).toBeTruthy();

    // A family's navigation, never a student's places.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toStrictEqual(["My children"]);
    // Only the routes a guardian may call.
    expect(new Set(family.calls.map((c) => c.name))).toStrictEqual(new Set(["me.get", "guardian.listChildren", "guardian.childOfferings"]));
  });

  it("switches between children with the keyboard and says whose classes are showing", async () => {
    const user = userEvent.setup();
    await renderApp(fakeFamily());
    const switcher = await screen.findByRole("navigation", { name: "Your children" });
    expect(within(switcher).getByRole("link", { name: "Amara Okafor" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(announcement()).toBe("Showing Amara Okafor's classes"));

    await tabTo(user, within(switcher).getByRole("link", { name: "Sam Okafor" }));
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Sam Okafor's classes" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Your children" })).getByRole("link", { name: "Sam Okafor" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(announcement()).toBe("Showing Sam Okafor's classes"));
    expect(within(screen.getByRole("region", { name: "This term" })).getByRole("link", { name: "Math 7 · Period 1" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Finished classes" })).toBeNull();
  });

  it("shows a class's assignments with due dates, the feedback shared with the child, and official grades", async () => {
    const user = userEvent.setup();
    const family = fakeFamily();
    await renderApp(family);
    await user.click(await screen.findByRole("link", { name: "English 9 · Period 3" }));
    expect(await screen.findByRole("heading", { level: 1, name: "English 9 · Period 3" })).toBeTruthy();

    const assignments = screen.getByRole("list", { name: "Assignments" });
    const essay = within(assignments).getByRole("region", { name: "Should the school day start later?" });
    expect(essay.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-03T21:00:00.000Z");
    expect(within(essay).getByText("Graded: 8 of 10 points")).toBeTruthy();
    expect(within(essay).getByText("Official grade: 8 of 10 points")).toBeTruthy();
    expect(within(essay).getByText("Strong claim; add a counterclaim.")).toBeTruthy();
    expect(within(essay).getByText("Shared by the teacher")).toBeTruthy();
    expect(within(essay).getByRole("table", { name: "Criterion results" })).toBeTruthy();

    const poem = within(assignments).getByRole("region", { name: "Analyse a poem" });
    expect(within(poem).getByText("No feedback yet. It shows here once the teacher shares it with Amara Okafor.")).toBeTruthy();
    // Nothing to do, and nothing of the child's own work: the view is read-only.
    expect(within(assignments).queryAllByRole("button")).toStrictEqual([]);
    expect(screen.queryByText(/Receipt code|Your work|Submit/)).toBeNull();
    expect(family.calls.find((c) => c.name === "guardian.childCourse")?.input).toStrictEqual({ params: { studentId: AMARA, offeringId: ENGLISH } });
  });

  it("answers a child or class that is not the guardian's as not there", async () => {
    await renderApp(fakeFamily({ children: [AMARA] }), "/family/children/prn_nf-student-elena");
    expect(await screen.findByText("This child isn't connected to you")).toBeTruthy();
  });

  it("tells a guardian the school has not confirmed them yet", async () => {
    await renderApp(fakeFamily({ children: [] }));
    expect(await screen.findByText("No children connected yet")).toBeTruthy();
  });

  it("never offers a student the family view", async () => {
    await renderApp(fakeDistrict(), "/family/children/prn_nf-student-amara");
    expect(await screen.findByText("There's nothing here")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((l) => l.textContent)).toStrictEqual(["Home", "My space"]);
  });
});

describe("accepting an invitation", () => {
  it("redeems the link without an account, says what happens next, and takes the token out of the address", async () => {
    const user = userEvent.setup();
    const family = fakeFamily();
    await renderApp(family, "/family/invitation#invitation=tok_valid");
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/Your school will check your sign-in and confirm you as a guardian/)).toBeTruthy();
    await waitFor(() => expect(announcement()).toBe("Invitation accepted"));
    expect(family.calls.map((c) => c.name)).toStrictEqual(["onboarding.redeemGuardianInvitation"]);
    expect(family.calls[0]!.input).toStrictEqual({ body: { token: "tok_valid" } });
    expect(window.location.hash).toBe("");
  });

  it("explains a link that cannot be used, and lets a failed connection be tried again", async () => {
    const user = userEvent.setup();
    const family = fakeFamily();
    await renderApp(family, "/family/invitation#invitation=tok_spent");
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("This invitation link can't be used. Ask the school for a new one.")).toBeTruthy();

    const retry = fakeFamily();
    retry.failNext("onboarding.redeemGuardianInvitation", new DistrictApiError(503, { code: "unavailable", message: "internal detail" }));
    await renderApp(retry, "/family/invitation#invitation=tok_valid");
    const accept = (await screen.findAllByRole("button", { name: "Accept invitation" })).at(-1)!;
    await user.click(accept);
    expect(await screen.findByText("Something went wrong at your school's end. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("internal detail")).toBeNull();
    await user.click(accept);
    expect(await screen.findByText(/Your school will check your sign-in/)).toBeTruthy();
  });

  it("asks for the link when there is none", async () => {
    await renderApp(fakeFamily(), "/family/invitation");
    expect(await screen.findByText("Open the invitation link your school gave you. It works once.")).toBeTruthy();
  });
});
