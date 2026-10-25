import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import { ADMIN, AMARA, ASSIGNMENT, BIO, BIO_SPRING, CHIDI, code, DMITRI, ELENA, ENG9, fakeHallMonitor, KAI, message, MORGAN, RIVERA, setup } from "./helpers.ts";
import { SCREENING_MESSAGES, hallMonitorGradeBand, type DiscussionPost } from "../src/index.ts";

async function topicIn(service: ReturnType<typeof setup>["service"], extra: Record<string, unknown> = {}) {
  return service.createTopic(MORGAN, BIO, { title: "Is a virus alive?", prompt: "Argue **one** side.", ...extra });
}

describe("discussion topics (SCHO-190)", () => {
  it("lets the teacher open, pin and lock topics, which enrolled students then read", async () => {
    const { service, storage } = setup();
    const first = await topicIn(service);
    const second = await service.createTopic(MORGAN, BIO, { title: "Lab safety questions", prompt: "Ask here.", pinned: true });
    const listing = await service.listTopics(AMARA, BIO);
    expect(listing).toMatchObject({ view: "student", canModerate: false, settings: { premoderation: false } });
    expect(listing.topics.map((t) => t.topic.title)).toStrictEqual(["Lab safety questions", "Is a virus alive?"]);

    await service.updateTopic(MORGAN, BIO, first.id, { locked: true, pinned: true });
    await service.updateTopic(MORGAN, BIO, second.id, { pinned: false });
    expect((await service.listTopics(MORGAN, BIO))).toMatchObject({ view: "staff", canModerate: true });
    const board = await storage.load(OfferingId.parse(BIO));
    expect(board!.moderation.map((e) => e.action)).toStrictEqual(["lock", "pin", "unpin"]);
  });

  it("refuses topic management to students, other teachers and administrators", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    expect(await code(service.createTopic(AMARA, BIO, { title: "Mine", prompt: "x" }))).toBe("forbidden");
    expect(await code(service.updateTopic(AMARA, BIO, topic.id, { locked: false }))).toBe("forbidden");
    expect(await code(service.deleteTopic(ELENA, BIO, topic.id))).toBe("forbidden");
    expect(await code(service.updateSettings(AMARA, BIO, { premoderation: true }))).toBe("forbidden");
    expect(await code(service.createTopic(RIVERA, BIO, { title: "Not my class", prompt: "x" }))).toBe("not-found");
    expect(await code(service.createTopic(ADMIN, BIO, { title: "Oversight", prompt: "x" }))).toBe("forbidden");
    expect(await code(service.listTopics(CHIDI, BIO))).toBe("not-found");
    expect(await code(service.listTopics(KAI, BIO))).toBe("not-found");
    expect(await code(service.listTopics(DMITRI, ENG9))).toBe("not-found");
  });

  it("places topics only in the class's own modules and grades them only under its own assignments", async () => {
    const { service, courseContent } = setup();
    await courseContent.commit({
      offeringId: OfferingId.parse(BIO),
      revision: 1,
      modules: [{ id: "cmod_draft", title: "Unit 2", published: false, items: [] }, { id: "cmod_live", title: "Unit 1", published: true, items: [] }],
      pages: [],
    }, 0);
    expect(await code(topicIn(service, { moduleId: "cmod_other" }))).toBe("validation-failed");
    expect(await code(topicIn(service, { assignmentId: "asg_someone-elses" }))).toBe("validation-failed");
    const draft = await topicIn(service, { moduleId: "cmod_draft", assignmentId: ASSIGNMENT });
    const live = await service.createTopic(MORGAN, BIO, { title: "Cells", prompt: "Draw one.", moduleId: "cmod_live" });
    // A topic in an unpublished module is the teachers' until the module is published.
    expect((await service.listTopics(AMARA, BIO)).topics.map((t) => t.topic.id)).toStrictEqual([live.id]);
    expect(await code(service.thread(AMARA, BIO, draft.id))).toBe("not-found");
    expect(await code(service.createPost(AMARA, BIO, draft.id, { body: "Early!" }))).toBe("not-found");
    expect((await service.listTopics(MORGAN, BIO)).topics).toHaveLength(2);
    const moved = await service.updateTopic(MORGAN, BIO, draft.id, { moduleId: null, assignmentId: null });
    expect(moved.moduleId).toBeUndefined();
    expect(moved.assignmentId).toBeUndefined();
    expect((await service.listTopics(AMARA, BIO)).topics).toHaveLength(2);
  });

  it("deletes a topic with its posts", async () => {
    const { service, storage } = setup();
    const topic = await topicIn(service);
    await service.createPost(AMARA, BIO, topic.id, { body: "Yes." });
    await service.deleteTopic(MORGAN, BIO, topic.id);
    const board = await storage.load(OfferingId.parse(BIO));
    expect(board).toMatchObject({ topics: [], posts: [] });
  });
});

describe("discussion posts (SCHO-190)", () => {
  it("shows a student's post to the class at once, threaded under the post it answers", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const root = await service.createPost(AMARA, BIO, topic.id, { body: "Viruses are not alive." });
    expect(root).toMatchObject({ status: "visible", authorRole: "student", flags: [] });
    const reply = await service.createPost(ELENA, BIO, topic.id, { body: "They evolve, though.", parentId: root.id });
    const teacher = await service.createPost(MORGAN, BIO, topic.id, { body: "Good point.", parentId: reply.id });
    expect(teacher.authorRole).toBe("staff");

    const thread = await service.thread(ELENA, BIO, topic.id);
    if (thread.view !== "student") throw new Error("expected the student view");
    expect(thread.posts.map((p) => [p.id, p.parentId, p.status === "withdrawn" ? undefined : p.mine])).toStrictEqual([
      [root.id, undefined, false],
      [reply.id, root.id, true],
      [teacher.id, reply.id, false],
    ]);
    // Flags and moderation never reach a student.
    expect(JSON.stringify(thread)).not.toContain("flags");
    expect((await service.listTopics(ELENA, BIO)).topics[0]).toMatchObject({ posts: 3, needsAttention: 0 });
  });

  it("lets authors edit and delete only their own posts, keeping a deleted post's place", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const root = await service.createPost(AMARA, BIO, topic.id, { body: "First draft." });
    await service.createPost(ELENA, BIO, topic.id, { body: "Reply.", parentId: root.id });
    expect(await code(service.editPost(ELENA, BIO, root.id, { body: "Hijacked" }))).toBe("forbidden");
    expect(await code(service.deletePost(ELENA, BIO, root.id))).toBe("forbidden");
    expect(await code(service.editPost(MORGAN, BIO, root.id, { body: "Teacher rewrite" }))).toBe("forbidden");
    const edited = await service.editPost(AMARA, BIO, root.id, { body: "Second draft." });
    expect(edited).toMatchObject({ body: "Second draft.", editedAt: expect.any(String) });

    await service.deletePost(AMARA, BIO, root.id);
    const thread = await service.thread(ELENA, BIO, topic.id);
    expect(thread.posts[0]).toStrictEqual({ status: "withdrawn", id: root.id, topicId: topic.id, createdAt: root.createdAt });
    expect(await code(service.editPost(AMARA, BIO, root.id, { body: "Back" }))).toBe("not-found");
    const staff = await service.thread(MORGAN, BIO, topic.id);
    expect(staff.posts[0]).toMatchObject({ body: "", deletedAt: expect.any(String) });
  });

  it("takes no student posts, edits or deletions in a locked topic, but still takes the teacher's", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const mine = await service.createPost(AMARA, BIO, topic.id, { body: "Before the lock." });
    await service.updateTopic(MORGAN, BIO, topic.id, { locked: true });
    expect(await message(service.createPost(ELENA, BIO, topic.id, { body: "Too late" }))).toBe("This discussion is locked.");
    expect(await code(service.editPost(AMARA, BIO, mine.id, { body: "Edit" }))).toBe("forbidden");
    expect(await code(service.deletePost(AMARA, BIO, mine.id))).toBe("forbidden");
    expect((await service.createPost(MORGAN, BIO, topic.id, { body: "Closing thoughts." })).status).toBe("visible");
  });

  it("refuses replies where a topic takes none, and replies nested too deep", async () => {
    const { service } = setup();
    const flat = await topicIn(service, { settings: { allowReplies: false } });
    const root = await service.createPost(AMARA, BIO, flat.id, { body: "Top level." });
    expect(await code(service.createPost(ELENA, BIO, flat.id, { body: "Reply", parentId: root.id }))).toBe("forbidden");
    const deep = await topicIn(service);
    let parent: DiscussionPost = await service.createPost(AMARA, BIO, deep.id, { body: "1" });
    for (let level = 2; level <= 8; level++) parent = await service.createPost(AMARA, BIO, deep.id, { body: String(level), parentId: parent.id });
    expect(await code(service.createPost(AMARA, BIO, deep.id, { body: "9", parentId: parent.id }))).toBe("validation-failed");
  });

  it("refuses scripts and empty posts, and anyone outside the class", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    expect(await code(service.createPost(AMARA, BIO, topic.id, { body: "<script>alert(1)</script>" }))).toBe("validation-failed");
    expect(await code(service.createPost(AMARA, BIO, topic.id, { body: "   " }))).toBe("validation-failed");
    expect(await code(service.createPost(AMARA, BIO, topic.id, { body: "x".repeat(10_001) }))).toBe("validation-failed");
    expect(await code(service.createPost(CHIDI, BIO, topic.id, { body: "Hi" }))).toBe("not-found");
    expect(await code(service.createPost(KAI, BIO, topic.id, { body: "Hi" }))).toBe("not-found");
    expect(await code(service.createPost(RIVERA, BIO, topic.id, { body: "Hi" }))).toBe("not-found");
    expect(await code(service.createPost(ADMIN, BIO, topic.id, { body: "Hi" }))).toBe("forbidden");
  });

  it("freezes a completed term's discussions", async () => {
    const { service } = setup();
    expect(await code(service.createTopic(MORGAN, BIO_SPRING, { title: "Late", prompt: "x" }))).toBe("forbidden");
  });
});

describe("moderation (SCHO-190)", () => {
  it("lets the teacher hide, restore and remove posts, which the class then no longer sees", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const unkind = await service.createPost(AMARA, BIO, topic.id, { body: "Unkind words." });
    const reply = await service.createPost(ELENA, BIO, topic.id, { body: "Please stop.", parentId: unkind.id });
    await service.moderate(MORGAN, BIO, unkind.id, { decision: "hide" });
    // Elena still sees her reply, under a placeholder that names no author and holds no text.
    expect((await service.thread(ELENA, BIO, topic.id)).posts).toStrictEqual([
      { status: "withdrawn", id: unkind.id, topicId: topic.id, createdAt: unkind.createdAt },
      expect.objectContaining({ id: reply.id, status: "visible" }),
    ]);
    // The author no longer sees it either, and cannot edit it.
    expect((await service.thread(AMARA, BIO, topic.id)).posts[0]!.status).toBe("withdrawn");
    expect(await code(service.editPost(AMARA, BIO, unkind.id, { body: "Sorry" }))).toBe("not-found");
    expect((await service.thread(MORGAN, BIO, topic.id)).posts[0]).toMatchObject({ status: "hidden", body: "Unkind words." });

    await service.moderate(MORGAN, BIO, unkind.id, { decision: "unhide" });
    expect((await service.thread(ELENA, BIO, topic.id)).posts[0]!.status).toBe("visible");
    await service.moderate(MORGAN, BIO, unkind.id, { decision: "remove" });
    expect(await code(service.moderate(MORGAN, BIO, unkind.id, { decision: "unhide" }))).toBe("conflict");
    // An administrator sees only the visible reply.
    expect((await service.thread(ADMIN, BIO, topic.id)).posts.map((p) => p.id)).toStrictEqual([reply.id]);
  });

  it("refuses moderation to students, other teachers and administrators", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const post = await service.createPost(AMARA, BIO, topic.id, { body: "Hello." });
    expect(await code(service.moderate(ELENA, BIO, post.id, { decision: "hide" }))).toBe("forbidden");
    expect(await code(service.moderate(AMARA, BIO, post.id, { decision: "remove" }))).toBe("forbidden");
    expect(await code(service.moderate(RIVERA, BIO, post.id, { decision: "hide" }))).toBe("not-found");
    expect(await code(service.moderate(ADMIN, BIO, post.id, { decision: "hide" }))).toBe("forbidden");
    expect(await code(service.moderationQueue(AMARA, BIO))).toBe("forbidden");
  });

  it("holds every student post for approval under pre-moderation, and shows it to its author meanwhile", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    await service.updateSettings(MORGAN, BIO, { premoderation: true });
    const post = await service.createPost(AMARA, BIO, topic.id, { body: "Waiting." });
    expect(post.status).toBe("pending");
    expect((await service.thread(AMARA, BIO, topic.id)).posts).toMatchObject([{ id: post.id, status: "pending", mine: true }]);
    expect((await service.thread(ELENA, BIO, topic.id)).posts).toStrictEqual([]);
    expect(await code(service.createPost(ELENA, BIO, topic.id, { body: "Reply", parentId: post.id }))).toBe("not-found");
    expect(await code(service.report(ELENA, BIO, post.id, { reason: "unkind" }))).toBe("not-found");
    expect((await service.createPost(MORGAN, BIO, topic.id, { body: "Teachers skip the queue." })).status).toBe("visible");

    const queue = await service.moderationQueue(MORGAN, BIO);
    expect(queue.pending.map((p) => p.id)).toStrictEqual([post.id]);
    expect((await service.listTopics(MORGAN, BIO)).topics[0]!.needsAttention).toBe(1);
    await service.moderate(MORGAN, BIO, post.id, { decision: "approve" });
    expect((await service.thread(ELENA, BIO, topic.id)).posts.map((p) => p.id)).toContain(post.id);
    expect(await code(service.moderate(MORGAN, BIO, post.id, { decision: "approve" }))).toBe("conflict");

    // An approved post edited under pre-moderation waits again.
    expect((await service.editPost(AMARA, BIO, post.id, { body: "Changed." })).status).toBe("pending");
    expect((await service.moderationQueue(MORGAN, BIO)).recent.map((e) => e.action)).toStrictEqual(["approve", "premoderation-on"]);
  });

  it("flags a reported post for the teacher, once per reporter, never one's own", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    const post = await service.createPost(AMARA, BIO, topic.id, { body: "Off topic." });
    expect(await code(service.report(AMARA, BIO, post.id, { reason: "off-topic" }))).toBe("forbidden");
    await service.report(ELENA, BIO, post.id, { reason: "off-topic" });
    await service.report(ELENA, BIO, post.id, { reason: "unkind" });
    const queue = await service.moderationQueue(MORGAN, BIO);
    expect(queue.flagged).toHaveLength(1);
    expect(queue.flagged[0]!.flags).toMatchObject([{ kind: "report", by: ELENA.principalId, reason: "off-topic" }]);
    // The post stays visible: reporting tells the teacher, it does not take a post down.
    expect((await service.thread(DMITRI, BIO, topic.id)).posts[0]!.status).toBe("visible");
    await service.moderate(MORGAN, BIO, post.id, { decision: "dismiss-flags" });
    expect((await service.moderationQueue(MORGAN, BIO)).flagged).toStrictEqual([]);
    expect((await service.moderationQueue(MORGAN, BIO)).recent.map((e) => e.action)).toStrictEqual(["dismiss-flags", "report"]);
  });

  it("lists a student's posts in a graded topic for the teacher grading participation", async () => {
    const { service } = setup();
    const graded = await topicIn(service, { assignmentId: ASSIGNMENT });
    const other = await topicIn(service);
    const mine = await service.createPost(AMARA, BIO, graded.id, { body: "Graded post." });
    await service.createPost(AMARA, BIO, other.id, { body: "Ungraded post." });
    await service.createPost(ELENA, BIO, graded.id, { body: "Elena's." });
    const participation = await service.participation(MORGAN, BIO, ASSIGNMENT, AMARA.principalId);
    expect(participation.topics.map((t) => t.id)).toStrictEqual([graded.id]);
    expect(participation.posts.map((p) => p.id)).toStrictEqual([mine.id]);
    expect(await code(service.participation(ELENA, BIO, ASSIGNMENT, AMARA.principalId))).toBe("not-found");
  });
});

describe("screening student posts with Hall Monitor (SCHO-190)", () => {
  it("shows an allowed post at once, sending Hall Monitor the post as student input with labels only", async () => {
    const { screening, requests } = fakeHallMonitor();
    const { service } = setup({ screening });
    const topic = await topicIn(service);
    const post = await service.createPost(AMARA, BIO, topic.id, { body: "A thoughtful answer." });
    expect(post).toMatchObject({ status: "visible", flags: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      source: { product: "schoolos", tenantId: "tenant-nf", surface: "discussion.post" },
      policy: { profileId: "student-9-12", revision: "rev-1" },
      context: { audience: "student", gradeBand: "9-12", costCenterId: "cc-safety" },
      evaluationKind: "interaction.input",
      content: { type: "text", text: "A thoughtful answer." },
    });
    expect(JSON.stringify(requests[0])).not.toContain(AMARA.principalId);
  });

  it("refuses a blocked post with a student-safe message, keeping only a content-free trail entry", async () => {
    const { screening } = fakeHallMonitor();
    const { service, storage } = setup({ screening });
    const topic = await topicIn(service);
    expect(await message(service.createPost(AMARA, BIO, topic.id, { body: "Something cruel [[block]]" }))).toBe(SCREENING_MESSAGES.block);
    expect(await code(service.createPost(AMARA, BIO, topic.id, { body: "I feel unsafe [[support]]" }))).toBe("policy-violation");
    const board = await storage.load(OfferingId.parse(BIO));
    expect(board!.posts).toStrictEqual([]);
    expect(board!.moderation.map((e) => [e.action, e.authorId, e.reasonCodes])).toStrictEqual([
      ["screening-refused", AMARA.principalId, ["moderation.block"]],
      ["screening-refused", AMARA.principalId, ["moderation.support"]],
    ]);
    expect(JSON.stringify(board)).not.toContain("cruel");
  });

  it("shows a coached post flagged for the teacher, and holds a held one for approval", async () => {
    const { screening } = fakeHallMonitor();
    const { service } = setup({ screening });
    const topic = await topicIn(service);
    const coached = await service.createPost(AMARA, BIO, topic.id, { body: "Borderline [[coach]]" });
    expect(coached).toMatchObject({ status: "visible", flags: [{ kind: "screening", decision: "coach", reasonCodes: ["moderation.coach"] }] });
    const held = await service.createPost(AMARA, BIO, topic.id, { body: "Worrying [[hold]]" });
    expect(held).toMatchObject({ status: "pending", flags: [{ kind: "screening", decision: "hold" }] });
    expect((await service.thread(ELENA, BIO, topic.id)).posts.map((p) => p.id)).toStrictEqual([coached.id]);
    const queue = await service.moderationQueue(MORGAN, BIO);
    expect(queue.pending.map((p) => p.id)).toStrictEqual([held.id]);
    expect(queue.flagged.map((p) => p.id)).toStrictEqual([coached.id, held.id]);
    // Approving the held post is the teacher's review of it, so its flag goes with it.
    expect((await service.moderate(MORGAN, BIO, held.id, { decision: "approve" })).flags).toStrictEqual([]);
  });

  it("screens a student's edit, and refuses it when Hall Monitor does, keeping the post as it was", async () => {
    const { screening, requests } = fakeHallMonitor();
    const { service } = setup({ screening });
    const topic = await topicIn(service);
    const post = await service.createPost(AMARA, BIO, topic.id, { body: "Fine." });
    expect(await code(service.editPost(AMARA, BIO, post.id, { body: "Now cruel [[block]]" }))).toBe("policy-violation");
    expect((await service.thread(ELENA, BIO, topic.id)).posts[0]).toMatchObject({ body: "Fine." });
    expect(new Set(requests.map((r) => r.idempotencyKey)).size).toBe(2);
  });

  it("refuses student posts when Hall Monitor cannot answer, and never screens staff", async () => {
    const { screening, requests } = fakeHallMonitor();
    const { service } = setup({ screening });
    const topic = await topicIn(service);
    expect(await code(service.createPost(AMARA, BIO, topic.id, { body: "Hello [[down]]" }))).toBe("unavailable");
    expect(await message(service.createPost(AMARA, BIO, topic.id, { body: "Hello [[down]]" }))).toBe(SCREENING_MESSAGES.unavailable);
    const count = requests.length;
    expect((await service.createPost(MORGAN, BIO, topic.id, { body: "Teacher note [[block]]" })).status).toBe("visible");
    expect(requests).toHaveLength(count);
  });

  it("publishes student posts unscreened in a district that has not configured Hall Monitor", async () => {
    const { service } = setup();
    const topic = await topicIn(service);
    expect((await service.createPost(AMARA, BIO, topic.id, { body: "No screening here [[block]]" })).status).toBe("visible");
  });

  it("maps course grade bands to Hall Monitor's, assuming the youngest when unknown", () => {
    expect([undefined, "K", "K-2", "4", "6-8", "9", "9-12"].map(hallMonitorGradeBand)).toStrictEqual(["K-2", "K-2", "K-2", "3-5", "6-8", "9-12", "9-12"]);
  });
});
