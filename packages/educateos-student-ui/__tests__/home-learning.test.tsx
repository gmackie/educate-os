// Home learning in the Learning Home (ADR-0016): a newcomer joins a community and sets up their
// family, a parent plans and hands the device to a child, the child practices with nothing else in
// reach, and the parent finishes with the PIN and reviews what happened.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { DistrictApiError } from "@educateos/api-client";
import { fakeCommunity, type FakeCommunity } from "./fakeHomeLearning.ts";
import { renderApp } from "./render.tsx";

/** Answers every count-objects item on screen by counting what it shows. */
async function countEverything(user: UserEvent, wrongFirst = false) {
  let first = wrongFirst;
  for (;;) {
    const next = screen.queryByRole("button", { name: /^(Next|Finish)$/ });
    if (next !== null) {
      await user.click(next);
      continue;
    }
    if (screen.queryByRole("heading", { name: "All done!" }) !== null) return;
    const list = screen.queryByRole("list", { name: / to count$/ });
    const count = list === null ? 0 : within(list).getAllByRole("img").length;
    const numbers = within(await screen.findByRole("list", { name: "Numbers" }));
    if (first) {
      first = false;
      const wrong = numbers.getAllByRole("button").find((b) => b.textContent !== String(count))!;
      await user.click(wrong);
      expect(await screen.findByText("Not quite. Have another try.")).toBeTruthy();
      continue;
    }
    await user.click(numbers.getByRole("button", { name: String(count) }));
    await screen.findByRole("button", { name: /^(Next|Finish)$/ });
  }
}

async function handOverMaya(user: UserEvent, community: FakeCommunity) {
  await renderApp(community, "/family");
  expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
  const maya = await screen.findByRole("region", { name: /Maya/ });
  await user.click(within(maya).getByRole("button", { name: "Add Count the sounds" }));
  await user.click(await within(maya).findByRole("button", { name: "Hand over to Maya" }));
  expect(await screen.findByRole("heading", { level: 1, name: "My practice" })).toBeTruthy();
}

describe("home learning (ADR-0016)", () => {
  it("lets a newcomer join an open community and set up their family and first child", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ joined: false });
    await renderApp(community, "/");
    expect(await screen.findByRole("heading", { level: 1, name: "Join this learning community" })).toBeTruthy();
    await user.type(screen.getByLabelText("Your name"), "Jordan Rivers");
    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Set up home learning" })).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start home learning" });
    await user.type(screen.getByLabelText("Family name"), "The Rivers family");
    await user.type(screen.getByLabelText("Family PIN"), "2468");
    await user.type(screen.getByLabelText("Type the PIN again"), "2469");
    await user.type(screen.getByLabelText("Child's first name or nickname"), "Maya");
    expect(screen.getByText("The PINs don't match.")).toBeTruthy();
    expect(start.hasAttribute("disabled")).toBe(true);
    await user.clear(screen.getByLabelText("Type the PIN again"));
    await user.type(screen.getByLabelText("Type the PIN again"), "2468");
    // The notice about the family's information must be accepted first.
    expect(screen.getByRole("heading", { name: "Your family's information" })).toBeTruthy();
    expect(screen.getByText("This installation is run by Willow Creek.")).toBeTruthy();
    expect(start.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "I've read this and agree" }));
    await user.click(start);

    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    const maya = await screen.findByRole("region", { name: /Maya/ });
    expect(within(maya).getByText("Count the sounds")).toBeTruthy();
    expect(within(maya).getByText("Count to 5")).toBeTruthy();
    // Nothing queued yet, so the device can't be handed over.
    expect(within(maya).getByRole("button", { name: "Hand over to Maya" }).hasAttribute("disabled")).toBe(true);
  });

  it("asks a newcomer to wait where an organizer approves each family", async () => {
    const user = userEvent.setup();
    await renderApp(await fakeCommunity({ joined: false, signup: "approval" }), "/");
    await user.type(await screen.findByLabelText("Your name"), "Robin Lee");
    await user.click(screen.getByRole("button", { name: "Ask to join" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for the community to welcome you" })).toBeTruthy();
  });

  it("hands the device to a child who practices with nothing else in reach until the PIN finishes it", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ children: ["Maya"] });
    await handOverMaya(user, community);

    // Only practice: no navigation, no account menu.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("Hi, Maya!")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Start: Count the sounds" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Count the sounds" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Let's go" }));

    // One counter per sound in each pictured word.
    for (let n = 0; n < 5; n++) {
      const heading = await screen.findByRole("heading", { name: `${n + 1} of 5` });
      expect(heading).toBeTruthy();
      const word = screen.getByRole("img", { name: /^a |^the |^an |lips|fog|ten/ }).getAttribute("aria-label")!;
      const sounds = ({ "a cat": 3, "the sun": 3, "a dog": 3, "a bee": 2, "a pig": 3, "a fish": 3, "a frog": 4, "an arrow pointing up": 2, "a bus": 3 } as Record<string, number>)[word]!;
      for (let i = 0; i < sounds; i++) await user.click(screen.getByRole("button", { name: "Add a counter" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await user.click(await screen.findByRole("button", { name: n === 4 ? "Finish" : "Next" }));
    }
    expect(await screen.findByRole("heading", { name: "All done!" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to my practice" }));
    expect(await screen.findByText("Nothing to practice right now")).toBeTruthy();

    // A wrong PIN is refused by the server; the right one returns the grown-up pages.
    await user.click(screen.getByRole("button", { name: "Grown-up: finish practice" }));
    await user.type(await screen.findByLabelText("Family PIN"), "0000");
    await user.click(screen.getByRole("button", { name: "Finish practice" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That PIN isn't right.");
    await user.type(screen.getByLabelText("Family PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "Finish practice" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();

    const maya = await screen.findByRole("region", { name: /Maya/ });
    expect(within(maya).getByText("Maya worked on \"Count the sounds\": 5 of 5 right on the first try without help. Next time: try \"Blend the sounds\".")).toBeTruthy();
    await user.click(within(maya).getByRole("link", { name: "Progress" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Maya's progress" })).toBeTruthy();
    const reading = screen.getByRole("region", { name: "Reading" });
    expect(within(reading).getByText("5 of 5 answers right on the first try without help, over 1 session", { exact: false })).toBeTruthy();
    expect(within(reading).getAllByText("Practicing with help").length).toBeGreaterThan(0);
  });

  it("keeps an unsaved answer on screen and saves it on retry", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ children: ["Maya"] });
    const adult = { principalId: "prn_g-jordan" as never, districtId: "dst_willowcreek" as never };
    const [maya] = (await community.service.home(adult)).family!.learners;
    await community.service.addToQueue(adult, maya!.id, { pack: "number-sense", activity: "count-to-5" });
    await renderApp(community, "/family");
    await user.click(await screen.findByRole("button", { name: "Hand over to Maya" }));
    await user.click(await screen.findByRole("button", { name: "Start: Count to 5" }));
    await user.click(await screen.findByRole("button", { name: "Let's go" }));

    community.failNext("learner.save", new DistrictApiError(503, { code: "unavailable", message: "Down." }));
    const list = await screen.findByRole("list", { name: / to count$/ });
    const count = within(list).getAllByRole("img").length;
    await user.click(within(screen.getByRole("list", { name: "Numbers" })).getByRole("button", { name: String(count) }));
    expect(await screen.findByText("This answer isn't saved yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try saving again" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await countEverything(user, true);
    expect(await screen.findByRole("heading", { name: "All done!" })).toBeTruthy();
    // The retry reused the first save's request, so one response per item was kept.
    const saves = community.calls.filter((c) => c.name === "learner.save").map((c) => (c.input as { body: { requestId: string } }).body.requestId);
    expect(saves[0]).toBe(saves[1]);
  });

  it("changes one child's plan: moving, pausing and removing activities", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ children: ["Maya", "Leo"] });
    const adult = { principalId: "prn_g-jordan" as never, districtId: "dst_willowcreek" as never };
    const [maya] = (await community.service.home(adult)).family!.learners;
    for (const activity of ["count-to-5", "count-to-10", "compare-groups"]) await community.service.addToQueue(adult, maya!.id, { pack: "number-sense", activity });
    await renderApp(community, `/family/learners/${maya!.id}/plan`);
    const plan = await screen.findByRole("list", { name: "Maya's activities, in order" });
    await user.click(within(plan).getByRole("button", { name: "Move More or fewer? up" }));
    await waitFor(() => expect(within(plan).getAllByRole("listitem").map((li) => li.textContent?.slice(0, 14))).toEqual(["Count to 5Math", "More or fewer?", "Count to 10Mat"]));
    await user.click(within(plan).getByRole("button", { name: "Pause Count to 5" }));
    expect(await within(plan).findByText("Paused")).toBeTruthy();
    await user.click(within(plan).getByRole("button", { name: "Remove Count to 10" }));
    await waitFor(() => expect(within(plan).queryByText("Count to 10")).toBeNull());
    // The switcher reaches Leo's plan; his is untouched.
    expect(screen.getByRole("navigation", { name: "Your children" })).toBeTruthy();
    const today = await community.service.today(adult);
    expect(today.find((t) => t.learner.displayName === "Leo")?.next).toEqual([]);
  });
});

describe("more grown-ups (ADR-0016)", () => {
  it("invites a second grown-up who joins from the link and sees the same children", async () => {
    const user = userEvent.setup();
    const jordan = await fakeCommunity({ children: ["Maya"], retentionDays: 730 });
    const { unmount } = await renderApp(jordan, "/family/home-settings");
    const adults = await screen.findByRole("region", { name: "Grown-ups" });
    expect(within(adults).getByText("You")).toBeTruthy();
    expect(screen.getByText(/Practice is deleted automatically 2 years after it happened/)).toBeTruthy();
    await user.click(within(adults).getByRole("button", { name: "Invite another grown-up" }));
    const copy = await within(adults).findByRole("button", { name: "Copy the invitation link" });
    expect(copy).toBeTruthy();
    const link = within(adults).getByText(/\/family\/join#invitation=/).textContent!;
    unmount();

    const sam = await fakeCommunity({ as: { service: jordan.service, principalId: "prn_g-sam", displayName: "Sam Safranek" } });
    await renderApp(sam, `/family/join#${new URL(link).hash.slice(1)}`);
    const join = await screen.findByRole("button", { name: "Join the family" });
    expect(join.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "I've read this and agree" }));
    await user.click(join);
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: /Maya/ })).toBeTruthy();
    const family = (await jordan.service.home({ principalId: "prn_g-jordan" as never, districtId: "dst_willowcreek" as never })).family!;
    expect(family.adults.map((a) => a.displayName)).toEqual(["Jordan Rivers", "Sam Safranek"]);
  });
});

describe("family controls (ADR-0016)", () => {
  it("asks a grown-up who accepted an older notice to accept the current one first", async () => {
    const user = userEvent.setup();
    await renderApp(await fakeCommunity({ children: ["Maya"], staleNotice: true }), "/family/library");
    expect(await screen.findByRole("heading", { level: 1, name: "Before you carry on" })).toBeTruthy();
    const carryOn = screen.getByRole("button", { name: "Continue" });
    expect(carryOn.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "I've read this and agree" }));
    await user.click(carryOn);
    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeTruthy();
  });

  it("turns reading aloud off, so practice shows the grown-up what to say instead", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ children: ["Maya"] });
    const { unmount } = await renderApp(community, "/family/home-settings");
    const toggle = await screen.findByRole("switch", { name: "Read practice aloud" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Read practice aloud" }).getAttribute("aria-checked")).toBe("false"));
    unmount();

    await handOverMaya(user, community);
    await user.click(await screen.findByRole("button", { name: "Start: Count the sounds" }));
    expect(screen.queryByRole("button", { name: "Hear the directions" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Let's go" }));
    expect(await screen.findByText("Grown-up: what to say")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hear the word" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear it again" })).toBeNull();
  });

  it("deletes a grown-up's account, after which the next visit starts over", async () => {
    const user = userEvent.setup();
    const community = await fakeCommunity({ children: ["Maya"] });
    await renderApp(community, "/family/home-settings");
    const account = await screen.findByRole("region", { name: "Your account" });
    expect(within(account).getByText(/also deletes your family/)).toBeTruthy();
    const remove = within(account).getByRole("button", { name: "Delete my account" });
    expect(remove.hasAttribute("disabled")).toBe(true);
    await user.type(within(account).getByLabelText('To delete your account, type "delete"'), "delete");
    await user.click(remove);
    expect(await screen.findByRole("heading", { level: 1, name: "Join this learning community" })).toBeTruthy();
    expect((await community.service.home({ principalId: "prn_g-jordan" as never, districtId: "dst_willowcreek" as never })).family).toBeNull();
  });
});
