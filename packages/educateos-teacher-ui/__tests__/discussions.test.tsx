// SCHO-190: a teacher runs a class's discussions: opens topics, works the moderation queue, pins,
// closes and moderates, sets pre-moderation, and sees a student's graded posts while grading.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import type { DistrictApiClient, RouteName } from "@educateos/api-client";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";
import { formatDateTime } from "../src/dates.ts";

const AT = "2026-10-21T15:00:00.000Z";
const page = `#/classes/${IDS.offering}/discussions`;

type Body = Record<string, unknown>;
type Input = { params?: Record<string, string>; body?: Body };
type Post = Body & { id: string; topicId: string; status: string; flags: Body[]; authorId: string };

/** The base fake district, with a class discussion: a topic, a waiting post, a reported one and a hidden one. */
function withDiscussions() {
  const base = fakeDistrict();
  let counter = 0;
  let premoderation = false;
  const topics: Body[] = [{
    id: "dtp_debate", offeringId: IDS.offering, title: "Later start?", prompt: "Take a side.", locked: false, pinned: false,
    settings: { allowReplies: true }, createdBy: IDS.teacher, createdAt: AT, updatedAt: AT,
  }];
  const post = (id: string, authorId: string, body: string, status: string, flags: Body[] = [], parentId?: string): Post => ({
    id, offeringId: IDS.offering, topicId: "dtp_debate", ...(parentId === undefined ? {} : { parentId }), authorId, authorRole: "student",
    body, status, flags, createdAt: AT,
  });
  const posts: Post[] = [
    post("dps_waiting", IDS.amara, "Waiting for you.", "pending", [{ kind: "screening", decision: "hold", reasonCodes: ["moderation.hold"], at: AT }]),
    post("dps_reported", IDS.amara, "Sleep is for the weak.", "visible", [{ kind: "report", by: IDS.elena, reason: "unkind", at: AT }]),
    post("dps_hidden", IDS.elena, "Something hidden.", "hidden", [], "dps_reported"),
  ];
  const authors = [{ principalId: IDS.amara, displayName: "Amara Okafor" }, { principalId: IDS.elena, displayName: "Elena Petrova" }, { principalId: IDS.teacher, displayName: "Ms. Rivera" }];
  const live = () => posts.filter((p) => p.deletedAt === undefined);
  const handlers: Partial<Record<RouteName, (input: Input) => unknown>> = {
    "teacher.listDiscussions": () => ({
      view: "staff", canModerate: true, settings: { premoderation },
      topics: topics.map((topic) => ({
        topic,
        posts: live().filter((p) => p.topicId === topic.id).length,
        needsAttention: live().filter((p) => p.topicId === topic.id && (p.status === "pending" || p.flags.length > 0)).length,
      })),
    }),
    "teacher.moderationQueue": () => ({
      settings: { premoderation },
      pending: live().filter((p) => p.status === "pending"),
      flagged: live().filter((p) => p.flags.length > 0 && p.status !== "removed"),
      recent: [],
      authors,
    }),
    "teacher.discussionThread": ({ params }) => ({ topic: topics.find((t) => t.id === params!.topicId), posts: posts.filter((p) => p.topicId === params!.topicId), authors }),
    "teacher.createTopic": ({ body }) => {
      const topic = { id: `dtp_new${++counter}`, offeringId: IDS.offering, locked: false, pinned: false, createdBy: IDS.teacher, createdAt: AT, updatedAt: AT, ...body };
      topics.push(topic);
      return topic;
    },
    "teacher.updateTopic": ({ params, body }) => Object.assign(topics.find((t) => t.id === params!.topicId)!, body),
    "teacher.deleteTopic": ({ params }) => {
      topics.splice(topics.findIndex((t) => t.id === params!.topicId), 1);
      return { deleted: true };
    },
    "teacher.createPost": ({ params, body }) => {
      const created = { ...post(`dps_new${++counter}`, IDS.teacher, String(body!.body), "visible", [], body!.parentId as string | undefined), topicId: params!.topicId!, authorRole: "staff" };
      posts.push(created);
      return created;
    },
    "teacher.moderatePost": ({ params, body }) => {
      const target = posts.find((p) => p.id === params!.postId)!;
      const next = { approve: "visible", hide: "hidden", unhide: "visible", remove: "removed" }[body!.decision as string];
      if (next !== undefined) target.status = next;
      if (body!.decision === "dismiss-flags" || body!.decision === "approve") target.flags = [];
      return target;
    },
    "teacher.discussionSettings": ({ body }) => {
      premoderation = body!.premoderation === true;
      return { premoderation };
    },
    "teacher.discussionParticipation": ({ params }) => ({
      topics: topics.filter((t) => t.assignmentId === params!.assignmentId),
      posts: live().filter((p) => p.authorId === params!.principalId && topics.some((t) => t.id === p.topicId && t.assignmentId === params!.assignmentId)),
    }),
  };
  const client: DistrictApiClient = {
    call: (async (name: RouteName, input: Input = {}) => {
      const handler = handlers[name];
      if (handler === undefined) return base.client.call(name as never, input as never);
      base.calls.push({ name, input });
      return structuredClone(handler(input));
    }) as DistrictApiClient["call"],
  };
  return { ...base, client, topics, posts };
}

describe("class discussions", () => {
  it("opens a topic graded under an assignment, with replies allowed", async () => {
    const district = withDiscussions();
    const user = await renderApp(district.client, page);
    await onScreen("Discussions · English 9 · Period 3");
    const form = screen.getByRole("form", { name: "Open a discussion" });
    await user.type(within(form).getByRole("textbox", { name: "Topic" }), "Uniforms?");
    await user.type(within(form).getByRole("textbox", { name: /Prompt/ }), "Argue **one** side.");
    await user.click(within(form).getByRole("radio", { name: `Persuasive paragraph, due ${formatDateTime("2026-11-03T23:59:00.000Z")}` }));
    await user.click(within(form).getByRole("button", { name: "Open discussion" }));
    await screen.findByRole("region", { name: "Uniforms?" });
    expect(district.callsTo("teacher.createTopic")[0]!.input.body).toStrictEqual({
      title: "Uniforms?", prompt: "Argue **one** side.", settings: { allowReplies: true }, assignmentId: IDS.existingAssignment,
    });
    expect(within(screen.getByRole("region", { name: "Uniforms?" })).getByText("Graded: Persuasive paragraph")).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Opened Uniforms? for the class.");
  });

  it("lists what needs the teacher, with why, and approves and clears it", async () => {
    const district = withDiscussions();
    const user = await renderApp(district.client, page);
    const panel = await screen.findByRole("region", { name: "Needs your attention" });
    const waiting = within(within(panel).getByRole("list", { name: "Waiting for approval" })).getByRole("article", { name: "Amara Okafor" });
    expect(within(waiting).getByText("The safety check held this post for you to review.")).toBeTruthy();
    const reported = within(within(panel).getByRole("list", { name: "Flagged posts" })).getByRole("article", { name: "Amara Okafor" });
    expect(within(reported).getByText("Reported by Elena Petrova: unkind or hurtful.")).toBeTruthy();

    await user.click(within(waiting).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(within(panel).queryByRole("list", { name: "Waiting for approval" })).toBeNull());
    expect(district.callsTo("teacher.moderatePost")[0]!.input).toMatchObject({ params: { postId: "dps_waiting" }, body: { decision: "approve" } });

    await user.click(within(screen.getByRole("list", { name: "Flagged posts" })).getByRole("button", { name: "Clear flags" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs your attention" })).toBeNull());
  });

  it("pins and closes a topic, and switches pre-moderation on", async () => {
    const district = withDiscussions();
    const user = await renderApp(district.client, page);
    const topic = await screen.findByRole("region", { name: "Later start?" });
    expect(within(topic).getByText("2 need you")).toBeTruthy();
    await user.click(within(topic).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(within(topic).getByText("Pinned")).toBeTruthy());
    await user.click(within(topic).getByRole("button", { name: "Close to new posts" }));
    await waitFor(() => expect(within(topic).getByRole("button", { name: "Reopen" })).toBeTruthy());
    expect(district.callsTo("teacher.updateTopic").map((c) => c.input.body)).toStrictEqual([{ pinned: true }, { locked: true }]);

    const premoderation = screen.getByRole("switch", { name: "Approve each student post before the class sees it" });
    await user.click(premoderation);
    await waitFor(() => expect(screen.getByText(/waits in Needs your attention/)).toBeTruthy());
    expect(district.callsTo("teacher.discussionSettings")[0]!.input.body).toStrictEqual({ premoderation: true });
  });

  it("shows every post in the thread, hidden ones marked, and restores one and replies", async () => {
    const district = withDiscussions();
    const user = await renderApp(district.client, page);
    const topic = await screen.findByRole("region", { name: "Later start?" });
    const toggle = within(topic).getByRole("button", { name: "Later start?" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const thread = await within(topic).findByRole("list", { name: "Posts in Later start?" });
    const replies = within(thread).getByRole("list", { name: "Replies to Amara Okafor" });
    const hidden = within(replies).getByRole("article", { name: "Elena Petrova" });
    expect(within(hidden).getByText("Hidden")).toBeTruthy();
    expect(within(hidden).getByText("Something hidden.")).toBeTruthy();
    await user.click(within(hidden).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(within(hidden).queryByText("Hidden")).toBeNull());

    await user.click(within(thread).getByRole("button", { name: "Reply to Elena Petrova" }));
    await user.type(within(thread).getByRole("textbox", { name: "Reply to Elena Petrova" }), "Thanks for being kind.");
    await user.click(within(thread).getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(within(thread).getByText("Thanks for being kind.")).toBeTruthy());
    expect(district.callsTo("teacher.createPost")[0]!.input.body).toStrictEqual({ body: "Thanks for being kind.", parentId: "dps_hidden" });
    // The teacher's own post is theirs to reply to, not "Ms. Rivera"'s.
    const own = await within(thread).findByRole("article", { name: "Ms. Rivera" });
    await user.click(within(own).getByRole("button", { name: "Reply to your post" }));
    expect(within(own).getByRole("textbox", { name: "Reply to your post" })).toBeTruthy();
  });

  it("deletes a topic only after the teacher confirms", async () => {
    const district = withDiscussions();
    const user = await renderApp(district.client, page);
    const topic = await screen.findByRole("region", { name: "Later start?" });
    await user.click(within(topic).getByRole("button", { name: "Delete" }));
    expect(district.callsTo("teacher.deleteTopic")).toHaveLength(0);
    await user.click(within(topic).getByRole("button", { name: "Delete topic" }));
    await screen.findByText("No discussions yet");
  });

  it("lists a student's posts in a graded topic while the teacher grades their work", async () => {
    const district = withDiscussions();
    Object.assign(district.topics[0]!, { assignmentId: IDS.existingAssignment });
    const submissionId = district.studentSubmits(IDS.existingAssignment, "Sleep matters for learning.");
    await renderApp(district.client, `#/classes/${IDS.offering}/assignments/${IDS.existingAssignment}/submissions/${submissionId}`);
    const section = await screen.findByRole("region", { name: "Discussion participation" });
    expect(within(section).getByRole("link", { name: "Later start?" }).getAttribute("href")).toBe(page);
    const list = within(section).getByRole("list", { name: "Amara Okafor's posts in Later start?" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toStrictEqual([
      expect.stringContaining("Waiting for you."),
      expect.stringContaining("Sleep is for the weak."),
    ]);
  });
});
