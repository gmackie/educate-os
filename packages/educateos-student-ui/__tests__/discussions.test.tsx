// SCHO-190: a class's discussions on its page: topics, a threaded view, posting, replying, editing,
// deleting and reporting, with the district's refusals shown to the student as it wrote them.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { DistrictApiError, type RouteInput, type RouteName } from "@educateos/api-client";
import { ENGLISH, fakeDistrict, type FakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const ME = "prn_nf-student-amara";
const AT = "2026-10-21T15:00:00.000Z";

const topic = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, offeringId: ENGLISH, title, prompt: `About **${title}**.`, locked: false, pinned: false, settings: { allowReplies: true },
  createdBy: "prn_nf-teacher-rivera", createdAt: AT, updatedAt: AT, ...extra,
});

type Post = Record<string, unknown> & { id: string; topicId: string; status: string; parentId?: string };

/** The fake district with discussions: a debate with a thread in it, and a closed topic. */
function withDiscussions(options: { premoderation?: boolean } = {}) {
  const base = fakeDistrict();
  const topics = [topic("dtp_debate", "Later start?", { pinned: true }), topic("dtp_closed", "Week 1 check-in", { locked: true })];
  let counter = 0;
  const posts: Post[] = [
    { status: "visible", id: "dps_1", topicId: "dtp_debate", authorId: "prn_nf-student-elena", authorRole: "student", body: "Yes, *sleep* matters.", createdAt: AT, mine: false },
    { status: "withdrawn", id: "dps_2", topicId: "dtp_debate", parentId: "dps_1", createdAt: AT },
    { status: "visible", id: "dps_3", topicId: "dtp_debate", parentId: "dps_2", authorId: "prn_nf-teacher-rivera", authorRole: "staff", body: "Let's keep it kind.", createdAt: AT, mine: false },
    { status: "visible", id: "dps_4", topicId: "dtp_debate", authorId: ME, authorRole: "student", body: "My first take.", createdAt: AT, mine: true },
  ];
  const reports: { postId: string; reason: string }[] = [];
  const authors = [
    { principalId: "prn_nf-student-elena", displayName: "Elena Petrova" },
    { principalId: "prn_nf-teacher-rivera", displayName: "Ms. Rivera" },
    { principalId: ME, displayName: "Amara Okafor" },
  ];
  const refuse = (code: "policy-violation" | "unavailable", message: string) => new DistrictApiError(code === "unavailable" ? 503 : 403, { code, message });
  const handlers: Partial<Record<RouteName, (input: never) => unknown>> = {
    "student.listDiscussions": () => ({
      view: "student", canModerate: false, settings: { premoderation: options.premoderation ?? false },
      topics: topics.map((t) => ({ topic: t, posts: posts.filter((p) => p.topicId === t.id && p.status !== "withdrawn").length, needsAttention: 0 })),
    }),
    "student.discussionThread": ({ params }: RouteInput<"student.discussionThread">) => ({
      topic: topics.find((t) => t.id === params.topicId), posts: posts.filter((p) => p.topicId === params.topicId), authors,
    }),
    "student.createPost": ({ params, body }: RouteInput<"student.createPost">) => {
      if (body.body.includes("#block")) throw refuse("policy-violation", "Your post wasn't shared because it may not follow your class's discussion guidelines.");
      if (body.body.includes("#down")) throw refuse("unavailable", "Posting isn't available right now. Try again in a little while.");
      const post: Post = {
        status: options.premoderation === true ? "pending" : "visible", id: `dps_new${++counter}`, topicId: params.topicId,
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }), authorId: ME, authorRole: "student", body: body.body, createdAt: AT, mine: true,
      };
      posts.push(post);
      return post;
    },
    "student.editPost": ({ params, body }: RouteInput<"student.editPost">) => {
      const post = posts.find((p) => p.id === params.postId)!;
      Object.assign(post, { body: body.body, editedAt: AT });
      return post;
    },
    "student.deletePost": ({ params }: RouteInput<"student.deletePost">) => {
      const post = posts.find((p) => p.id === params.postId)!;
      for (const key of ["authorId", "authorRole", "body", "mine", "editedAt"]) delete post[key];
      post.status = "withdrawn";
      return { deleted: true };
    },
    "student.reportPost": ({ params, body }: RouteInput<"student.reportPost">) => {
      reports.push({ postId: params.postId, reason: body.reason });
      return { reported: true };
    },
  };
  const district: FakeDistrict = {
    ...base,
    async call(name, ...args) {
      const handler = handlers[name];
      if (handler === undefined) return base.call(name, ...args);
      base.calls.push({ name, input: args[0] });
      await Promise.resolve();
      return structuredClone(handler((args[0] ?? {}) as never)) as never;
    },
  };
  return { district, posts, reports };
}

async function openDebate() {
  const user = userEvent.setup();
  const toggle = await screen.findByRole("button", { name: "Later start?" });
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const posts = await screen.findByRole("list", { name: "Posts in Later start?" });
  return { user, posts };
}

describe("class discussions", () => {
  it("lists topics, pinned first, and opens one as a reply tree with names and placeholders", async () => {
    await renderApp(withDiscussions().district, `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Discussions" });
    expect(within(section).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toStrictEqual(["Later start?", "Week 1 check-in"]);
    expect(within(section).getByText("Pinned")).toBeTruthy();
    expect(within(section).getByText("Closed")).toBeTruthy();

    const { posts } = await openDebate();
    const elena = within(posts).getByRole("article", { name: "Elena Petrova" });
    expect(within(elena).getByText("sleep").tagName).toBe("EM");
    // Elena's post holds the replies beneath it: a removed one, and the teacher's answer to it.
    const replies = within(posts).getByRole("list", { name: "Replies to Elena Petrova" });
    expect(within(replies).getByRole("article", { name: "This post was removed." })).toBeTruthy();
    const teacher = within(within(replies).getByRole("list", { name: "Replies to a removed post" })).getByRole("article", { name: "Ms. Rivera" });
    expect(within(teacher).getByText("Teacher")).toBeTruthy();
    expect(within(posts).getByRole("article", { name: "You" })).toBeTruthy();
  });

  it("posts and replies, announcing each", async () => {
    await renderApp(withDiscussions().district, `/courses/${ENGLISH}`);
    const { user, posts } = await openDebate();
    await user.type(screen.getByRole("textbox", { name: "Your post" }), "Buses would need to change.");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(within(posts).getByText("Buses would need to change.")).toBeTruthy());
    expect(announcement()).toBe("Your post was posted.");

    await user.click(within(posts).getByRole("button", { name: "Reply to Elena Petrova" }));
    await user.type(screen.getByRole("textbox", { name: "Reply to Elena Petrova" }), "Agreed!");
    await user.click(screen.getByRole("button", { name: "Post reply" }));
    const replies = await screen.findByRole("list", { name: "Replies to Elena Petrova" });
    await waitFor(() => expect(within(replies).getByText("Agreed!")).toBeTruthy());
    expect(announcement()).toBe("Your reply was posted.");
  });

  it("shows the district's refusal, keeping the text to change", async () => {
    await renderApp(withDiscussions().district, `/courses/${ENGLISH}`);
    const { user } = await openDebate();
    const box = screen.getByRole("textbox", { name: "Your post" });
    await user.type(box, "Something mean #block");
    await user.click(screen.getByRole("button", { name: "Post" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("discussion guidelines");
    expect((box as HTMLTextAreaElement).value).toBe("Something mean #block");
  });

  it("shows a post as waiting when the teacher approves posts first", async () => {
    await renderApp(withDiscussions({ premoderation: true }).district, `/courses/${ENGLISH}`);
    expect(await screen.findByText("Your teacher reads each post before the class sees it.")).toBeTruthy();
    const { user, posts } = await openDebate();
    await user.type(screen.getByRole("textbox", { name: "Your post" }), "Waiting post.");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(announcement()).toBe("Your post was sent to your teacher to approve."));
    const mine = within(posts).getAllByRole("article", { name: "You" }).find((a) => a.textContent?.includes("Waiting post."))!;
    expect(within(mine).getByText("Waiting for your teacher")).toBeTruthy();
  });

  it("edits and deletes the student's own post only, and reports someone else's", async () => {
    const { district, reports } = withDiscussions();
    await renderApp(district, `/courses/${ENGLISH}`);
    const { user, posts } = await openDebate();
    const elena = within(posts).getByRole("article", { name: "Elena Petrova" });
    expect(within(elena).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(elena).queryByRole("button", { name: "Delete" })).toBeNull();

    const mine = within(posts).getByRole("article", { name: "You" });
    expect(within(mine).queryByRole("button", { name: /Report/ })).toBeNull();
    await user.click(within(mine).getByRole("button", { name: "Edit" }));
    const editor = within(mine).getByRole("textbox", { name: "Edit your post" });
    await user.clear(editor);
    await user.type(editor, "My better take.");
    await user.click(within(mine).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(posts).getByText("My better take.")).toBeTruthy());
    expect(within(posts).getByText(/\(edited\)/)).toBeTruthy();

    const edited = within(posts).getByRole("article", { name: "You" });
    await user.click(within(edited).getByRole("button", { name: "Delete" }));
    await user.click(within(edited).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(posts).queryByRole("article", { name: "You" })).toBeNull());
    expect(announcement()).toBe("Your post was deleted.");

    await user.click(within(elena).getByRole("button", { name: "Report Elena Petrova's post" }));
    const send = within(elena).getByRole("button", { name: "Send to my teacher" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(elena).getByRole("radio", { name: "It's unkind or hurtful" }));
    await user.click(send);
    await waitFor(() => expect(reports).toStrictEqual([{ postId: "dps_1", reason: "unkind" }]));
    expect(announcement()).toBe("Thanks. Your teacher will look at this post.");
  });

  it("offers nothing but reading and reporting in a closed topic", async () => {
    await renderApp(withDiscussions().district, `/courses/${ENGLISH}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Week 1 check-in" }));
    expect(await screen.findByText("This discussion is closed")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Your post" })).toBeNull();
  });

  it("shows nothing for a class without discussions", async () => {
    await renderApp(fakeDistrict(), `/courses/${ENGLISH}`);
    await screen.findByRole("heading", { level: 2, name: "Activities" });
    expect(screen.queryByRole("heading", { level: 2, name: "Discussions" })).toBeNull();
  });
});
