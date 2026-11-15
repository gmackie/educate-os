// Home learning over HTTP (ADR-0016), in the Willow Creek community: signing up, a family's
// management routes, and the child session that locks a browser to one child's practice until an
// adult ends it with the family PIN.
import { describe, expect, it } from "vitest";
import { WILLOWCREEK, NORTHFIELD } from "@educateos/fixtures";
import type { Item } from "@educateos/home-learning";
import { CHILD_SESSION_COOKIE } from "../src/home-learning.ts";
import { bootDistrict, expectError, type TestDistrict } from "./support.ts";

const RIVERS = "prn_wc-parent-rivers";
const NAIR = "prn_wc-parent-nair";
const ORGANIZER = "prn_wc-organizer";

const rightAnswer = (item: Item) => {
  switch (item.type) {
    case "count-sounds": case "count-objects": case "one-more-less": case "place-on-line": case "number-line-jump":
      return { kind: "number" as const, value: item.answer };
    case "build-word": return { kind: "letters" as const, letters: item.answer.split("") };
    case "read-aloud": return { kind: "observed" as const, result: "independent" as const };
    default: return { kind: "choice" as const, choice: item.answer };
  }
};

/** The cookie header a browser would send back after this `Set-Cookie`. */
const cookieFrom = (setCookie: string | null | undefined) => {
  expect(setCookie).toMatch(new RegExp(`^${CHILD_SESSION_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=Strict`));
  return { cookie: setCookie!.split(";")[0]! };
};

async function riversWithChild(d: TestDistrict) {
  const rivers = d.tokenFor(RIVERS);
  await d.ok(rivers, "family.create", { body: { name: "The Rivers family", pin: "2468" } });
  const maya = await d.ok(rivers, "family.addLearner", { body: { displayName: "Maya", avatar: "🦊", gradeBand: "K" } });
  await d.ok(rivers, "family.queueAdd", { params: { learnerId: maya.id }, body: { pack: "number-sense", activity: "count-to-5" } });
  return { rivers, maya };
}

describe("home learning in a community installation", () => {
  it("answers not-found where the installation doesn't offer it", async () => {
    const d = await bootDistrict(NORTHFIELD);
    expectError(await d.call(d.tokenFor("prn_nf-guardian-rosa"), "family.home"), 404, "not-found");
    expect((await d.ok(d.tokenFor("prn_nf-guardian-rosa"), "me.get")).homeLearning).toBeUndefined();
    expect(await d.ok(d.idp.issue("nf-stranger"), "onboarding.community")).toEqual({ homeLearning: false, signup: null });
    expectError(await d.call(d.idp.issue("nf-stranger"), "onboarding.joinCommunity", { body: { displayName: "S" } }), 403, "forbidden");
  });

  it("keeps staff, including the community organizer, off the family surface", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    expectError(await d.call(d.tokenFor(ORGANIZER), "family.home"), 403, "forbidden");
  });

  it("lets a newcomer join an open community and start a family", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    const newcomer = d.idp.issue("wc-newcomer");
    expectError(await d.call(newcomer, "me.get"), 401, "unauthenticated");
    expect(await d.ok(newcomer, "onboarding.community")).toEqual({ homeLearning: true, signup: "open" });
    expect(await d.ok(newcomer, "onboarding.joinCommunity", { body: { displayName: "Alex Kim" } })).toEqual({ outcome: "joined" });
    expect(await d.ok(newcomer, "me.get")).toMatchObject({ kind: "guardian", displayName: "Alex Kim" });
    expect(await d.ok(newcomer, "family.home")).toEqual({ family: null });
    expect((await d.ok(newcomer, "me.get")).homeLearning).toEqual({ hasFamily: false, childSession: null });
    const family = await d.ok(newcomer, "family.create", { body: { name: "The Kims", pin: "1357" } });
    expect(family.name).toBe("The Kims");
    expectError(await d.call(newcomer, "onboarding.joinCommunity", { body: { displayName: "Again" } }), 409, "conflict");
  });

  it("queues a newcomer for an administrator in an approval community", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "approval" } });
    const newcomer = d.idp.issue("wc-waiting");
    expect(await d.ok(newcomer, "onboarding.joinCommunity", { body: { displayName: "Robin Lee" } })).toEqual({ outcome: "awaiting-approval" });
    expect(await d.ok(newcomer, "onboarding.joinCommunity", { body: { displayName: "Robin Lee" } })).toEqual({ outcome: "awaiting-approval" });
    expect(((await d.call(newcomer, "me.get")).body as { unlinkedSignIn?: { awaitingApproval?: boolean } }).unlinkedSignIn?.awaitingApproval).toBe(true);
    const organizer = d.tokenFor(ORGANIZER);
    const [signup, ...others] = await d.ok(organizer, "admin.familySignups");
    expect(others).toEqual([]);
    expect(signup).toMatchObject({ displayName: "Robin Lee", signIn: { subject: "wc-waiting" } });
    await d.ok(organizer, "admin.approveIdentityRequest", { params: { requestId: signup!.requestId } });
    expect(await d.ok(newcomer, "me.get")).toMatchObject({ kind: "guardian", displayName: "Robin Lee" });
    expectError(await d.call(d.tokenFor(RIVERS), "admin.familySignups"), 403, "forbidden");
  });

  it("refuses self sign-up in an invite-only community", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "invite-only" } });
    expectError(await d.call(d.idp.issue("wc-stranger"), "onboarding.joinCommunity", { body: { displayName: "S" } }), 403, "forbidden");
  });

  it("keeps one family's children from another family's adult", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    const { maya } = await riversWithChild(d);
    const nair = d.tokenFor(NAIR);
    await d.ok(nair, "family.create", { body: { name: "Nair", pin: "9753" } });
    expectError(await d.call(nair, "family.progress", { params: { learnerId: maya.id } }), 404, "not-found");
    expectError(await d.call(nair, "family.startChildSession", { params: { learnerId: maya.id } }), 404, "not-found");
    expect((await d.ok(nair, "family.today"))).toEqual([]);
  });
});

describe("child sessions", () => {
  it("locks the browser to one child's practice until an adult ends it with the PIN", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    const { rivers, maya } = await riversWithChild(d);
    expect(await d.ok(rivers, "learner.session")).toEqual({ active: false });
    expect((await d.ok(rivers, "me.get")).homeLearning).toEqual({ hasFamily: true, childSession: null });
    expectError(await d.call(rivers, "learner.home"), 403, "forbidden");

    const started = await d.call(rivers, "family.startChildSession", { params: { learnerId: maya.id } });
    expect(started.status).toBe(200);
    const child = cookieFrom(started.setCookie);

    // Every adult route refuses this browser now; me.get and practice still answer.
    expectError(await d.call(rivers, "family.home", {}, child), 403, "forbidden");
    expectError(await d.call(rivers, "family.progress", { params: { learnerId: maya.id } }, child), 403, "forbidden");
    expectError(await d.call(rivers, "me.preferences", {}, child), 403, "forbidden");
    expect(((await d.call(rivers, "me.get", {}, child)).body as { homeLearning?: unknown }).homeLearning).toEqual({ hasFamily: true, childSession: { learnerId: maya.id, displayName: "Maya", avatar: "🦊" } });
    expect((await d.call(rivers, "learner.session", {}, child)).body).toEqual({ active: true, learnerId: maya.id, displayName: "Maya", avatar: "🦊" });

    // The child practices the queued activity to the end.
    const home = (await d.call(rivers, "learner.home", {}, child)).body as { queue: { entryId: string; title: string }[] };
    expect(home.queue.map((q) => q.title)).toEqual(["Count to 5"]);
    const view = (await d.call(rivers, "learner.start", { params: { entryId: home.queue[0]!.entryId } }, child)).body as { sessionId: string; items: Item[] };
    let completed = false;
    for (const item of view.items) {
      const saved = await d.call(rivers, "learner.save", {
        params: { sessionId: view.sessionId },
        body: { requestId: crypto.randomUUID(), item: item.key, answers: [rightAnswer(item)], hintUsed: false, adultHelped: false },
      }, child);
      expect(saved.status).toBe(200);
      completed = (saved.body as { completed: boolean }).completed;
    }
    expect(completed).toBe(true);

    // A wrong PIN keeps the lock; the right one clears the cookie and the adult routes answer again.
    expectError(await d.call(rivers, "learner.exit", { body: { pin: "0000" } }, child), 403, "forbidden");
    const exited = await d.call(rivers, "learner.exit", { body: { pin: "2468" } }, child);
    expect(exited.status).toBe(200);
    expect(exited.setCookie).toMatch(new RegExp(`^${CHILD_SESSION_COOKIE}=; .*Max-Age=0`));
    expect((await d.call(rivers, "family.home", {}, child)).status).toBe(200);

    const progress = await d.ok(rivers, "family.progress", { params: { learnerId: maya.id } });
    expect(progress.sessions[0]!.note).toContain("Maya worked on \"Count to 5\": 5 of 5 right on the first try without help.");
  });

  it("ignores a child-session cookie on another adult's requests", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    const { rivers, maya } = await riversWithChild(d);
    const child = cookieFrom((await d.call(rivers, "family.startChildSession", { params: { learnerId: maya.id } })).setCookie);
    const nair = d.tokenFor(NAIR);
    expect((await d.call(nair, "family.home", {}, child)).status).toBe(200);
    expect((await d.call(nair, "learner.session", {}, child)).body).toEqual({ active: false });
  });

  it("lets an adult end every child session from another device", async () => {
    const d = await bootDistrict(WILLOWCREEK, { homeLearning: { signup: "open" } });
    const { rivers, maya } = await riversWithChild(d);
    const child = cookieFrom((await d.call(rivers, "family.startChildSession", { params: { learnerId: maya.id } })).setCookie);
    expect(await d.ok(rivers, "family.endChildSessions")).toEqual({ ended: 1 });
    expect((await d.call(rivers, "family.home", {}, child)).status).toBe(200);
  });
});
