// The home-learning service over the real policy engine and the Willow Creek community directory:
// families stay isolated from each other, a child session reaches only its own child's practice,
// saves are idempotent, the PIN locks, and progress reads only what was saved.
import { describe, expect, it } from "vitest";
import { InMemoryAcademicStore } from "@educateos/academics";
import { DistrictId, EducateOsError, PrincipalId, type PolicySettings, type VerifiedPrincipal } from "@educateos/contracts";
import { WILLOWCREEK } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import {
  HomeLearningService,
  InMemoryHomeLearningStore,
  familyAdults,
  type Answer,
  type Item,
  type PracticeView,
} from "../src/index.ts";

const D = DistrictId.parse("dst_willowcreek");
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};
const who = (id: string): VerifiedPrincipal => ({ principalId: PrincipalId.parse(id), districtId: D });
const RIVERS = who("prn_wc-parent-rivers");
const NAIR = who("prn_wc-parent-nair");
const ORGANIZER = who("prn_wc-organizer");

function setup() {
  const store = new InMemoryHomeLearningStore();
  const audit = new InMemoryPolicyAuditSink();
  const clock = { at: Date.parse("2026-11-16T15:00:00.000Z") };
  const now = () => new Date(clock.at);
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(InMemoryAcademicStore.seeded(WILLOWCREEK), { effectivePolicy: async () => FLOOR }, { relationships: [familyAdults(store)], now }),
    audit,
    now,
  });
  const service = new HomeLearningService({ store, authorizer: engine, districtId: D, now });
  return { store, audit, service, clock };
}

async function riversFamily(service: HomeLearningService) {
  await service.createFamily(RIVERS, { name: "The Rivers family", pin: "2468" });
  const maya = await service.addLearner(RIVERS, { displayName: "Maya", avatar: "🦊", gradeBand: "K" });
  const leo = await service.addLearner(RIVERS, { displayName: "Leo", avatar: "🐢", gradeBand: "1" });
  return { maya, leo };
}

const rightAnswer = (item: Item): Answer => {
  switch (item.type) {
    case "count-sounds": case "count-objects": case "one-more-less": case "place-on-line": case "number-line-jump":
      return { kind: "number", value: item.answer };
    case "build-word": return { kind: "letters", letters: item.answer.split("") };
    case "read-aloud": return { kind: "observed", result: "independent" };
    default: return { kind: "choice", choice: item.answer };
  }
};

async function practiceAll(service: HomeLearningService, adult: VerifiedPrincipal, child: Parameters<HomeLearningService["practiceHome"]>[1], view: PracticeView) {
  let completed = false;
  for (const item of view.items) {
    ({ completed } = await service.saveResponse(adult, child, view.sessionId, { requestId: crypto.randomUUID(), item: item.key, answers: [rightAnswer(item)], hintUsed: false, adultHelped: false }));
  }
  return completed;
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof EducateOsError) return error.code;
    throw error;
  }
};

describe("families", () => {
  it("lets an adult start one family, add children with grade-based starting points, and see it", async () => {
    const { service, audit } = setup();
    expect(await service.home(RIVERS)).toEqual({ family: null });
    const { maya, leo } = await riversFamily(service);
    expect(maya.starts).toEqual({ reading: "count-sounds", math: "count-to-5" });
    expect(leo.starts).toEqual({ reading: "build-words-set-1", math: "place-on-line-10" });
    const home = await service.home(RIVERS);
    expect(home.family?.learners.map((l) => l.displayName)).toEqual(["Maya", "Leo"]);
    expect(JSON.stringify(home)).not.toContain("hash");
    expect(await code(service.createFamily(RIVERS, { name: "Again", pin: "1234" }))).toBe("conflict");
    // Every allowed decision is audited with the family as its grant.
    const allowed = audit.events.filter((e) => e.effect === "allow" && e.ruleId === "family.adult.manage");
    expect(allowed.length).toBeGreaterThan(0);
    expect(new Set(allowed.map((e) => e.grantId))).toEqual(new Set([home.family!.id]));
  });

  it("keeps each family's records from every other adult", async () => {
    const { service } = setup();
    const { maya } = await riversFamily(service);
    await service.createFamily(NAIR, { name: "Nair", pin: "1357" });
    expect((await service.home(NAIR)).family?.learners).toEqual([]);
    expect(await code(service.progress(NAIR, maya.id))).toBe("not-found");
    expect(await code(service.addToQueue(NAIR, maya.id, { pack: "number-sense", activity: "count-to-5" }))).toBe("not-found");
    expect(await code(service.startChildSession(NAIR, maya.id))).toBe("not-found");
    expect(await code(service.removeLearner(NAIR, maya.id))).toBe("not-found");
  });

  it("gives a community organizer no way into a family's home learning", async () => {
    const { service } = setup();
    const { maya } = await riversFamily(service);
    expect(await code(service.progress(ORGANIZER, maya.id))).toBe("not-found");
    expect(await code(service.createFamily(ORGANIZER, { name: "Staff", pin: "1111" }))).toBe("forbidden");
  });

  it("refuses a malformed PIN or name", async () => {
    const { service } = setup();
    // A Zod error here is answered `validation-failed` by the district app.
    await expect(service.createFamily(RIVERS, { name: "R", pin: "12" })).rejects.toThrow(/4 to 8 digits/);
    await expect(service.createFamily(RIVERS, { name: "<b>", pin: "1234" })).rejects.toThrow(/plain text/);
    expect(await service.home(RIVERS)).toEqual({ family: null });
  });

  it("removes a child with all their practice, and exports everything but the PIN", async () => {
    const { service } = setup();
    const { maya, leo } = await riversFamily(service);
    await service.addToQueue(RIVERS, maya.id, { pack: "number-sense", activity: "count-to-5" });
    const { token } = await service.startChildSession(RIVERS, maya.id);
    const child = (await service.childSession(RIVERS, token))!;
    const home = await service.practiceHome(RIVERS, child);
    await service.startPractice(RIVERS, child, home.queue[0]!.entryId);
    const exported = await service.exportFamily(RIVERS);
    expect(exported.sessions).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain("salt");
    await service.removeLearner(RIVERS, maya.id);
    expect((await service.home(RIVERS)).family?.learners.map((l) => l.id)).toEqual([leo.id]);
    expect((await service.exportFamily(RIVERS)).sessions).toEqual([]);
    expect(await service.childSession(RIVERS, token)).toBeUndefined();
  });
});

describe("queue", () => {
  it("adds, reorders, pauses and removes one child's activities without touching another's", async () => {
    const { service } = setup();
    const { maya, leo } = await riversFamily(service);
    await service.addToQueue(RIVERS, maya.id, { pack: "number-sense", activity: "count-to-5" });
    await service.addToQueue(RIVERS, maya.id, { pack: "reading-foundations", activity: "count-sounds" });
    let queue = await service.addToQueue(RIVERS, maya.id, { pack: "number-sense", activity: "compare-groups" });
    expect(queue.map((e) => e.title)).toEqual(["Count to 5", "Count the sounds", "More or fewer?"]);
    queue = await service.changeQueueEntry(RIVERS, maya.id, queue[2]!.id, { moveTo: 0 });
    queue = await service.changeQueueEntry(RIVERS, maya.id, queue[1]!.id, { paused: true });
    expect(queue.map((e) => [e.title, e.paused])).toEqual([["More or fewer?", false], ["Count to 5", true], ["Count the sounds", false]]);
    queue = await service.removeQueueEntry(RIVERS, maya.id, queue[0]!.id);
    expect(queue.map((e) => e.title)).toEqual(["Count to 5", "Count the sounds"]);
    expect((await service.home(RIVERS)).family?.queues[leo.id]).toEqual([]);
    expect(queue[0]!.ref).toEqual({ pack: "number-sense", version: "1.0.0", activity: "count-to-5" });
  });

  it("suggests the next activity from each child's own starting point", async () => {
    const { service } = setup();
    await riversFamily(service);
    const today = await service.today(RIVERS);
    expect(today.map((t) => [t.learner.displayName, t.suggestions.map((s) => s.title)])).toEqual([
      ["Maya", ["Count the sounds", "Count to 5"]],
      ["Leo", ["Build words: s a t i p n", "Find numbers on the line"]],
    ]);
  });
});

describe("child sessions and practice", () => {
  async function startedSession() {
    const env = setup();
    const kids = await riversFamily(env.service);
    await env.service.addToQueue(RIVERS, kids.maya.id, { pack: "number-sense", activity: "jump-forward-10" });
    const { token } = await env.service.startChildSession(RIVERS, kids.maya.id);
    const child = (await env.service.childSession(RIVERS, token))!;
    const home = await env.service.practiceHome(RIVERS, child);
    const view = await env.service.startPractice(RIVERS, child, home.queue[0]!.entryId);
    return { ...env, ...kids, token, child, view };
  }

  it("binds a child session to the adult who started it", async () => {
    const { service, token } = await startedSession();
    expect(await service.childSession(NAIR, token)).toBeUndefined();
    expect(await service.childSession(RIVERS, "x".repeat(43))).toBeUndefined();
  });

  it("draws one session's items, resumes the open session, and saves each response once", async () => {
    const { service, child, view } = await startedSession();
    expect(view.items).toHaveLength(5);
    const first = view.items[0]!;
    const input = { requestId: crypto.randomUUID(), item: first.key, answers: [rightAnswer(first)], hintUsed: false, adultHelped: false };
    const saved = await service.saveResponse(RIVERS, child, view.sessionId, input);
    expect(saved.response.independent).toBe(true);
    // A retried save returns the stored response; a different one for the same item conflicts.
    expect(await service.saveResponse(RIVERS, child, view.sessionId, input)).toEqual(saved);
    expect(await code(service.saveResponse(RIVERS, child, view.sessionId, { ...input, requestId: crypto.randomUUID() }))).toBe("conflict");
    const home = await service.practiceHome(RIVERS, child);
    expect(home.queue[0]!.inProgress).toBe(true);
    const resumed = await service.startPractice(RIVERS, child, home.queue[0]!.entryId);
    expect(resumed.sessionId).toBe(view.sessionId);
    expect(resumed.saved).toEqual([first.key]);
  });

  it("scores on the server, names the counted-start mistake, and keeps help out of independence", async () => {
    const { service, child, view } = await startedSession();
    const [a, b, c] = view.items as Extract<Item, { type: "number-line-jump" }>[];
    const wrongThenRight = await service.saveResponse(RIVERS, child, view.sessionId, {
      requestId: crypto.randomUUID(), item: a!.key, answers: [{ kind: "number", value: a!.answer - 1 }, { kind: "number", value: a!.answer }], hintUsed: false, adultHelped: false,
    });
    expect(wrongThenRight.response).toMatchObject({ correct: true, firstTryCorrect: false, independent: false, pattern: "counted-start-mark" });
    const hinted = await service.saveResponse(RIVERS, child, view.sessionId, { requestId: crypto.randomUUID(), item: b!.key, answers: [rightAnswer(b!)], hintUsed: true, adultHelped: false });
    expect(hinted.response.independent).toBe(false);
    expect(await code(service.saveResponse(RIVERS, child, view.sessionId, { requestId: crypto.randomUUID(), item: c!.key, answers: [{ kind: "choice", choice: "left" }], hintUsed: false, adultHelped: false }))).toBe("validation-failed");
  });

  it("finishes the session on its last item, takes it off the queue, and writes a parent note", async () => {
    const { service, child, view, maya } = await startedSession();
    expect(await practiceAll(service, RIVERS, child, view)).toBe(true);
    expect((await service.practiceHome(RIVERS, child)).queue).toEqual([]);
    const progress = await service.progress(RIVERS, maya.id);
    expect(progress.sessions[0]!.note).toBe("Maya worked on \"Jump forward (add)\": 5 of 5 right on the first try without help. Next time: try \"Jump back (subtract)\".");
    const skill = progress.skills.find((s) => s.skillId === "line.add-10")!;
    expect(skill).toMatchObject({ state: "practicing-with-help", responses: 5, independent: 5, sessions: 1 });
  });

  it("calls a skill independent only across days, and ready to revisit after a long break", async () => {
    const { service, child, view, maya, clock } = await startedSession();
    await practiceAll(service, RIVERS, child, view);
    clock.at += 86_400_000;
    await service.addToQueue(RIVERS, maya.id, { pack: "number-sense", activity: "check-add-10" });
    const home = await service.practiceHome(RIVERS, child);
    const check = await service.startPractice(RIVERS, child, home.queue[0]!.entryId);
    expect(check.mode).toBe("check");
    expect(await code(service.saveResponse(RIVERS, child, check.sessionId, { requestId: crypto.randomUUID(), item: check.items[0]!.key, answers: [rightAnswer(check.items[0]!)], hintUsed: true, adultHelped: false }))).toBe("validation-failed");
    await practiceAll(service, RIVERS, child, check);
    const skill = () => service.progress(RIVERS, maya.id).then((p) => p.skills.find((s) => s.skillId === "line.add-10")!);
    expect(await skill()).toMatchObject({ state: "practicing-independently", fromChecks: 5 });
    clock.at += 22 * 86_400_000;
    expect((await skill()).state).toBe("ready-to-revisit");
  });

  it("lets an adult correct or exclude a response, keeping the original", async () => {
    const { service, child, view, maya } = await startedSession();
    await practiceAll(service, RIVERS, child, view);
    const item = view.items[0]!.key;
    await service.correct(RIVERS, maya.id, view.sessionId, { item, verdict: "with-help" });
    const detail = await service.correct(RIVERS, maya.id, view.sessionId, { item, verdict: "exclude" });
    expect(detail.items[0]!.response?.independent).toBe(true);
    expect(detail.items[0]!.correction?.verdict).toBe("exclude");
    const skill = (await service.progress(RIVERS, maya.id)).skills.find((s) => s.skillId === "line.add-10")!;
    expect(skill.responses).toBe(4);
  });

  it("ends a child session only with the family PIN, and locks after five wrong tries", async () => {
    const { service, child, token } = await startedSession();
    for (let i = 0; i < 4; i += 1) expect(await code(service.endChildSession(RIVERS, child, "0000"))).toBe("forbidden");
    expect(await code(service.endChildSession(RIVERS, child, "0000"))).toBe("forbidden");
    expect((await service.home(RIVERS)).family?.pinLocked).toBe(true);
    expect(await code(service.endChildSession(RIVERS, child, "2468"))).toBe("forbidden");
    // From another device, an adult can still end it.
    expect(await service.endAllChildSessions(RIVERS)).toBe(1);
    expect(await service.childSession(RIVERS, token)).toBeUndefined();
  });

  it("ends a child session with the right PIN", async () => {
    const { service, child, token } = await startedSession();
    await service.endChildSession(RIVERS, child, "2468");
    expect(await service.childSession(RIVERS, token)).toBeUndefined();
  });
});
