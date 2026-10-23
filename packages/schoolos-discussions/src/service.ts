// An offering's discussions (SCHO-190). Every call is decided by the district's policy engine on a
// `discussion-topic` or `discussion-post` at the offering, classified by what the record is: a
// topic in an unpublished module is `teacher-only`, a post is `course` while visible,
// `teacher-only` while it waits for approval and `restricted` once hidden or removed.
//
// The owner's decision: a student's post is visible once Hall Monitor has screened it (or at once,
// in a district that screens nothing), and teachers moderate after. An offering may switch on
// pre-moderation, so each student post waits for a teacher's approval. Staff posts are never
// screened. There is no private messaging.
import { randomIdBody } from "@schoolos/content-studio";
import {
  OfferingId,
  SchoolOsError,
  type Action,
  type AuthorizationRequest,
  type Authorizer,
  type Classification,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type PrincipalId,
  type RequestChannel,
  type ResourceKind,
  type Scope,
  type VerifiedPrincipal,
} from "@schoolos/contracts";
import type { CourseContentStorage, CourseOutline } from "@schoolos/curriculum";
import { z } from "zod";
import {
  DiscussionSettings,
  DiscussionTopic,
  MAX_THREAD_DEPTH,
  ModerationDecision,
  NewPost,
  NewTopic,
  PostBody,
  PostReport,
  TopicPatch,
  type DiscussionBoard,
  type DiscussionPost,
  type ModerationAction,
  type ModerationEvent,
  type ModerationQueue,
  type PostFlag,
  type PostStatus,
  type StudentPostView,
  type TopicListing,
  type TopicSource,
  type TopicThread,
} from "./model.ts";
import { screenPost, type DiscussionScreening, type ScreeningVerdict } from "./screening.ts";
import { emptyBoard, type BoardWrite, type DiscussionStorage } from "./storage.ts";

type OfferingScope = Extract<Scope, { level: "offering" }>;

/** Everything a discussion service needs. Each district runs its own. */
export interface DiscussionServiceOptions {
  districtId: DistrictId;
  /** The district directory, for offerings, their terms and courses, and principals' kinds. */
  directory: DistrictDirectorySnapshot;
  /** Decides every call: the district's `PolicyEngine`, with its discussion rules. */
  authorizer: Authorizer;
  channel?: RequestChannel;
  storage: DiscussionStorage;
  /** The offering's course content, so a topic sits only in one of its modules and follows its publication. */
  courseContent: Pick<CourseContentStorage, "load">;
  /** The assignments of an offering, so a graded topic names only one of its own. */
  assignmentsIn: (offeringId: OfferingId) => Promise<readonly string[]>;
  /** Hall Monitor screening for student posts. Without it, student posts are not screened. */
  screening?: DiscussionScreening;
  /** The current time as an ISO 8601 timestamp. */
  now?: () => string;
}

/** Who is reading: the offering's staff, an administrator overseeing it, or one of its students. */
type Viewer = "staff" | "oversight" | "student";

/** A topic imported from elsewhere, such as a Common Cartridge discussion. */
export interface ImportedTopic {
  moduleId?: string;
  title: string;
  prompt: string;
  source: TopicSource;
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new SchoolOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

const NOT_FOUND = () => new SchoolOsError("not-found", "no such discussion");
const newId = <P extends string>(prefix: P) => `${prefix}_${randomIdBody()}` as const;

/** A post's classification: what its moderation status lets people read. */
const POST_CLASSIFICATION: Record<PostStatus, Classification> = {
  visible: "course",
  pending: "teacher-only",
  hidden: "restricted",
  removed: "restricted",
};

const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** A post as a student reads it. See {@link StudentPostView}. */
export function studentPostView(post: DiscussionPost, readerId: string): StudentPostView {
  const base = { id: post.id, topicId: post.topicId, ...(post.parentId === undefined ? {} : { parentId: post.parentId }), createdAt: post.createdAt };
  if (post.deletedAt !== undefined || (post.status !== "visible" && post.status !== "pending")) return { status: "withdrawn", ...base };
  return {
    ...base,
    status: post.status,
    authorId: post.authorId,
    authorRole: post.authorRole,
    body: post.body,
    ...(post.editedAt === undefined ? {} : { editedAt: post.editedAt }),
    mine: post.authorId === readerId,
  };
}

/**
 * One district's course discussions (SCHO-190): topics an offering's staff open, optionally in a
 * course module and optionally graded through an assignment, with threaded posts its students and
 * staff write. Staff lock, pin and moderate; students report posts to them. Every moderation step
 * and every post screening refused is kept in a content-free trail. A completed term's
 * discussions are read-only.
 */
export class DiscussionService {
  readonly #options: DiscussionServiceOptions;
  readonly #now: () => string;

  constructor(options: DiscussionServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * The offering's topics the subject may see, pinned first and then newest, with the offering's
   * settings.
   *
   * @throws SchoolOsError `not-found` if the subject may see none of its discussions.
   */
  async listTopics(subject: VerifiedPrincipal, offeringId: unknown): Promise<TopicListing> {
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    const board = await this.#load(scope.offeringId);
    const outline = await this.#options.courseContent.load(scope.offeringId);
    const ownPending = viewer === "student" && (await this.#allowed(subject, "read", scope, "discussion-post", "teacher-only", subject.principalId));
    const topics = board.topics
      .filter((topic) => viewer === "staff" || this.#topicClassification(topic, outline) === "course")
      .toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((topic) => {
        const posts = board.posts.filter((p) => p.topicId === topic.id && p.deletedAt === undefined);
        const readable = posts.filter((p) => viewer === "staff" || p.status === "visible" || (ownPending && p.status === "pending" && p.authorId === subject.principalId));
        const needsAttention = viewer === "staff" ? posts.filter((p) => p.status === "pending" || p.flags.length > 0).length : 0;
        return { topic, posts: readable.length, needsAttention };
      });
    return { view: viewer === "student" ? "student" : "staff", canModerate: viewer === "staff", settings: board.settings, topics };
  }

  /**
   * One topic and the posts in it the subject may read: everything for staff; visible posts for
   * administrators; for students, visible posts, their own waiting ones, and placeholders keeping
   * the place of withdrawn posts that have replies they may read.
   *
   * @throws SchoolOsError `not-found` if the subject may not see the topic.
   */
  async thread(subject: VerifiedPrincipal, offeringId: unknown, topicId: unknown): Promise<TopicThread> {
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    const board = await this.#load(scope.offeringId);
    const topic = await this.#visibleTopic(board, topicId, viewer);
    const posts = board.posts.filter((p) => p.topicId === topic.id).toSorted(byCreation);
    if (viewer === "staff") return { view: "staff", topic, posts };
    if (viewer === "oversight") return { view: "staff", topic, posts: posts.filter((p) => p.status === "visible" && p.deletedAt === undefined) };
    const ownPending = await this.#allowed(subject, "read", scope, "discussion-post", "teacher-only", subject.principalId);
    const readable = new Set(posts.filter((p) => p.deletedAt === undefined && (p.status === "visible" || (ownPending && p.status === "pending" && p.authorId === subject.principalId))).map((p) => p.id));
    // A withdrawn post is kept, as a placeholder, only when something readable sits beneath it.
    const parents = new Map(posts.map((p) => [p.id, p.parentId]));
    const kept = new Set(readable);
    for (const id of readable) {
      for (let parent = parents.get(id); parent !== undefined && !kept.has(parent); parent = parents.get(parent)) kept.add(parent);
    }
    return { view: "student", topic, posts: posts.filter((p) => kept.has(p.id)).map((p) => studentPostView(p, subject.principalId)) };
  }

  /** Opens a topic. A graded topic names one of the offering's assignments; a placed one, one of its modules. */
  async createTopic(subject: VerifiedPrincipal, offeringId: unknown, input: unknown): Promise<DiscussionTopic> {
    const parsed = parseInput(NewTopic, input);
    const scope = this.#scope(offeringId);
    const at = this.#now();
    const topic = DiscussionTopic.parse({ id: newId("dtp"), offeringId: scope.offeringId, ...parsed, createdBy: subject.principalId, createdAt: at, updatedAt: at });
    const [created] = await this.#addTopics(subject, scope, [topic]);
    return created!;
  }

  /**
   * Imports topics, such as a Common Cartridge's discussions, into the offering. Each is checked as
   * if a teacher had opened it; one that fails refuses the whole import and nothing is stored.
   */
  async importTopics(subject: VerifiedPrincipal, offeringId: unknown, topics: readonly ImportedTopic[]): Promise<DiscussionTopic[]> {
    const scope = this.#scope(offeringId);
    const at = this.#now();
    const parsed = topics.map((imported) => parseInput(DiscussionTopic, {
      id: newId("dtp"),
      offeringId: scope.offeringId,
      ...(imported.moduleId === undefined ? {} : { moduleId: imported.moduleId }),
      title: imported.title,
      prompt: imported.prompt,
      locked: false,
      pinned: false,
      settings: { allowReplies: true },
      source: imported.source,
      createdBy: subject.principalId,
      createdAt: at,
      updatedAt: at,
    }));
    return parsed.length === 0 ? [] : this.#addTopics(subject, scope, parsed);
  }

  /** Changes a topic: its text, module or assignment, and whether it is locked or pinned. Locking and pinning are trailed. */
  async updateTopic(subject: VerifiedPrincipal, offeringId: unknown, topicId: unknown, input: unknown): Promise<DiscussionTopic> {
    const patch = parseInput(TopicPatch, input);
    const scope = this.#scope(offeringId);
    let updated: DiscussionTopic | undefined;
    await this.#change(scope, async (board, outline) => {
      const topic = board.topics.find((t) => t.id === topicId);
      if (topic === undefined) throw NOT_FOUND();
      await this.#requireTopic(subject, scope, "update", topic, outline);
      const { moduleId, assignmentId, ...rest } = patch;
      const next = DiscussionTopic.parse({
        ...topic,
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
        ...(moduleId === undefined ? {} : { moduleId: moduleId ?? undefined }),
        ...(assignmentId === undefined ? {} : { assignmentId: assignmentId ?? undefined }),
        updatedAt: this.#now(),
      });
      if (moduleId === null) delete next.moduleId;
      if (assignmentId === null) delete next.assignmentId;
      await this.#checkPlacement(scope, next, outline);
      if (this.#topicClassification(next, outline) !== this.#topicClassification(topic, outline)) await this.#requireTopic(subject, scope, "update", next, outline);
      const trail: ModerationAction[] = [];
      if (next.locked !== topic.locked) trail.push(next.locked ? "lock" : "unlock");
      if (next.pinned !== topic.pinned) trail.push(next.pinned ? "pin" : "unpin");
      updated = next;
      return { topics: [next], moderation: trail.map((action) => this.#event(subject, action, { topicId: next.id })) };
    });
    return updated!;
  }

  /** Deletes a topic and every post in it. */
  async deleteTopic(subject: VerifiedPrincipal, offeringId: unknown, topicId: unknown): Promise<void> {
    const scope = this.#scope(offeringId);
    await this.#change(scope, async (board, outline) => {
      const topic = board.topics.find((t) => t.id === topicId);
      if (topic === undefined) throw NOT_FOUND();
      await this.#requireTopic(subject, scope, "delete", topic, outline);
      return { deletedTopicIds: [topic.id] };
    });
  }

  /** Sets the offering's discussion settings, such as pre-moderation. Trailed. */
  async updateSettings(subject: VerifiedPrincipal, offeringId: unknown, input: unknown): Promise<DiscussionSettings> {
    const settings = parseInput(DiscussionSettings, input);
    const scope = this.#scope(offeringId);
    await this.#require(subject, "configure", scope, "discussion-topic", "course", undefined, "Only the class's teachers can change its discussion settings.");
    await this.#change(scope, async (board) => ({
      settings,
      moderation: settings.premoderation === board.settings.premoderation ? [] : [this.#event(subject, settings.premoderation ? "premoderation-on" : "premoderation-off", {})],
    }));
    return settings;
  }

  /**
   * Writes a post, or a reply when it names its parent. A student's post is screened first, where
   * the district screens posts, and is visible at once unless the offering pre-moderates or Hall
   * Monitor holds it; either way it then waits for a teacher's approval. A staff post is visible at
   * once and never screened.
   *
   * @throws SchoolOsError `forbidden` in a locked topic (for students) or a topic that takes no
   *   replies, and `policy-violation` or `unavailable`, with a message for the student, when
   *   screening refuses the post.
   */
  async createPost(subject: VerifiedPrincipal, offeringId: unknown, topicId: unknown, input: unknown): Promise<DiscussionPost> {
    const { body, parentId } = parseInput(NewPost, input);
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    const id = newId("dps");
    let created: DiscussionPost | undefined;
    let refused: Extract<ScreeningVerdict, { outcome: "refuse" }> | undefined;
    await this.#change(scope, async (board, outline) => {
      const topic = await this.#visibleTopic(board, topicId, viewer, outline);
      await this.#require(subject, "create", scope, "discussion-post", "course", subject.principalId, "You can't post in this class's discussions.");
      if (topic.locked && viewer !== "staff") throw new SchoolOsError("forbidden", "This discussion is locked.");
      if (parentId !== undefined) {
        if (!topic.settings.allowReplies) throw new SchoolOsError("forbidden", "This discussion takes no replies.");
        const parent = board.posts.find((p) => p.id === parentId && p.topicId === topic.id);
        if (parent === undefined || parent.deletedAt !== undefined || (viewer !== "staff" && parent.status !== "visible")) throw NOT_FOUND();
        if (this.#depth(board, parent) >= MAX_THREAD_DEPTH) throw new SchoolOsError("validation-failed", "This thread is as deep as replies go; reply further up.");
      }
      const at = this.#now();
      const post: DiscussionPost = {
        id,
        offeringId: scope.offeringId,
        topicId: topic.id,
        ...(parentId === undefined ? {} : { parentId }),
        authorId: subject.principalId,
        authorRole: viewer === "staff" ? "staff" : "student",
        body,
        status: "visible",
        flags: [],
        createdAt: at,
      };
      if (viewer === "staff") {
        created = post;
        return { posts: [post] };
      }
      const verdict = await this.#screen(scope, `${id}.${randomIdBody().slice(0, 12)}`, body);
      if (verdict.outcome === "refuse") {
        refused = verdict;
        return { moderation: [this.#event(subject, "screening-refused", { topicId: topic.id, authorId: subject.principalId, reasonCodes: verdict.reasonCodes })] };
      }
      created = this.#screened(post, verdict, board.settings.premoderation, at);
      return { posts: [created] };
    });
    if (refused !== undefined) throw new SchoolOsError(refused.decision === "unavailable" ? "unavailable" : "policy-violation", refused.message);
    return created!;
  }

  /**
   * Edits the subject's own post. A student's edit is screened again and, under pre-moderation,
   * waits for approval again.
   *
   * @throws SchoolOsError as {@link createPost}, and `not-found` for a post the author may no longer read.
   */
  async editPost(subject: VerifiedPrincipal, offeringId: unknown, postId: unknown, input: unknown): Promise<DiscussionPost> {
    const { body } = parseInput(z.strictObject({ body: PostBody }), input);
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    let updated: DiscussionPost | undefined;
    let refused: Extract<ScreeningVerdict, { outcome: "refuse" }> | undefined;
    await this.#change(scope, async (board, outline) => {
      const { post, topic } = await this.#ownPost(subject, scope, board, postId, viewer, "update", outline);
      const at = this.#now();
      const edited: DiscussionPost = { ...post, body, editedAt: at };
      if (post.authorRole === "staff") {
        updated = edited;
        return { posts: [edited] };
      }
      const verdict = await this.#screen(scope, `${post.id}.${randomIdBody().slice(0, 12)}`, body);
      if (verdict.outcome === "refuse") {
        refused = verdict;
        return { moderation: [this.#event(subject, "screening-refused", { topicId: topic.id, postId: post.id, authorId: subject.principalId, reasonCodes: verdict.reasonCodes })] };
      }
      const flags = post.flags.filter((flag) => flag.kind !== "screening");
      updated = this.#screened({ ...edited, status: "visible", flags }, verdict, board.settings.premoderation || post.status === "pending", at);
      return { posts: [updated] };
    });
    if (refused !== undefined) throw new SchoolOsError(refused.decision === "unavailable" ? "unavailable" : "policy-violation", refused.message);
    return updated!;
  }

  /** Deletes the subject's own post: its text goes, and it stays as a placeholder for any replies. */
  async deletePost(subject: VerifiedPrincipal, offeringId: unknown, postId: unknown): Promise<void> {
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    await this.#change(scope, async (board, outline) => {
      const { post } = await this.#ownPost(subject, scope, board, postId, viewer, "delete", outline);
      return { posts: [{ ...post, body: "", flags: [], deletedAt: this.#now() }] };
    });
  }

  /**
   * A teacher's decision on a post: approve one waiting (clearing the flags it waited with), hide
   * or restore it, remove it for good, or dismiss its flags. Trailed.
   *
   * @throws SchoolOsError `conflict` for a decision that does not apply to the post's status.
   */
  async moderate(subject: VerifiedPrincipal, offeringId: unknown, postId: unknown, input: unknown): Promise<DiscussionPost> {
    const { decision } = parseInput(z.strictObject({ decision: ModerationDecision }), input);
    const scope = this.#scope(offeringId);
    let updated: DiscussionPost | undefined;
    await this.#change(scope, async (board) => {
      const post = board.posts.find((p) => p.id === postId);
      if (post === undefined) throw NOT_FOUND();
      if (!(await this.#allowed(subject, "review", scope, "discussion-post", POST_CLASSIFICATION[post.status], post.authorId))) {
        if (await this.#allowed(subject, "read", scope, "discussion-post", POST_CLASSIFICATION[post.status], post.authorId)) throw new SchoolOsError("forbidden", "Only the class's teachers can moderate its discussions.");
        throw NOT_FOUND();
      }
      const status = nextStatus(post, decision);
      // Approving a post is the teacher's review of it, so it clears the flags it waited with.
      updated = { ...post, status, ...(decision === "dismiss-flags" || decision === "approve" ? { flags: [] } : {}) };
      return { posts: [updated], moderation: [this.#event(subject, decision, { topicId: post.topicId, postId: post.id, authorId: post.authorId })] };
    });
    return updated!;
  }

  /** A student reports another person's visible post to the class's teachers. Reporting it again changes nothing. */
  async report(subject: VerifiedPrincipal, offeringId: unknown, postId: unknown, input: unknown): Promise<void> {
    const { reason } = parseInput(PostReport, input);
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    await this.#change(scope, async (board, outline) => {
      const post = board.posts.find((p) => p.id === postId);
      if (post === undefined || post.deletedAt !== undefined || post.status !== "visible") throw NOT_FOUND();
      await this.#visibleTopic(board, post.topicId, viewer, outline);
      await this.#require(subject, "submit", scope, "discussion-post", "course", post.authorId, "You can't report this post.");
      if (post.flags.some((flag) => flag.kind === "report" && flag.by === subject.principalId)) return {};
      const flag: PostFlag = { kind: "report", by: subject.principalId, reason, at: this.#now() };
      return { posts: [{ ...post, flags: [...post.flags, flag] }], moderation: [this.#event(subject, "report", { topicId: post.topicId, postId: post.id, authorId: post.authorId })] };
    });
  }

  /** The posts waiting for approval, the flagged ones, and the latest moderation, for the offering's staff. */
  async moderationQueue(subject: VerifiedPrincipal, offeringId: unknown): Promise<ModerationQueue> {
    const scope = this.#scope(offeringId);
    if ((await this.#viewer(subject, scope)) !== "staff") throw new SchoolOsError("forbidden", "Only the class's teachers can moderate its discussions.");
    const board = await this.#load(scope.offeringId);
    const live = board.posts.filter((p) => p.deletedAt === undefined).toSorted(byCreation);
    return {
      settings: board.settings,
      pending: live.filter((p) => p.status === "pending"),
      flagged: live.filter((p) => p.flags.length > 0 && p.status !== "removed"),
      recent: board.moderation.toReversed().slice(0, 50),
    };
  }

  /**
   * One student's posts in the offering's topics graded under `assignmentId`, for the teacher
   * grading their participation. Deleted posts are left out.
   */
  async participation(subject: VerifiedPrincipal, offeringId: unknown, assignmentId: string, studentId: PrincipalId): Promise<{ topics: DiscussionTopic[]; posts: DiscussionPost[] }> {
    const scope = this.#scope(offeringId);
    if ((await this.#viewer(subject, scope)) !== "staff") throw NOT_FOUND();
    const board = await this.#load(scope.offeringId);
    const topics = board.topics.filter((t) => t.assignmentId === assignmentId);
    const ids = new Set(topics.map((t) => t.id));
    return { topics, posts: board.posts.filter((p) => ids.has(p.topicId) && p.authorId === studentId && p.deletedAt === undefined).toSorted(byCreation) };
  }

  /** A post after screening: flagged as Hall Monitor said, and waiting for approval when held or pre-moderated. */
  #screened(post: DiscussionPost, verdict: Exclude<ScreeningVerdict, { outcome: "refuse" }>, premoderated: boolean, at: string): DiscussionPost {
    const flags = verdict.outcome === "allow" ? post.flags : [...post.flags, { kind: "screening" as const, decision: verdict.decision, reasonCodes: verdict.reasonCodes, at }];
    return { ...post, flags, status: premoderated || verdict.outcome === "hold" ? "pending" : "visible" };
  }

  async #screen(scope: OfferingScope, checkId: string, text: string): Promise<ScreeningVerdict> {
    const { screening, directory } = this.#options;
    if (screening === undefined) return { outcome: "allow" };
    const offering = directory.offerings.find((o) => o.id === scope.offeringId);
    const gradeBand = directory.courses.find((c) => c.id === offering?.courseId)?.gradeBand;
    return screenPost(screening, { checkId, text, ...(gradeBand === undefined ? {} : { gradeBand }) });
  }

  async #addTopics(subject: VerifiedPrincipal, scope: OfferingScope, topics: DiscussionTopic[]): Promise<DiscussionTopic[]> {
    await this.#change(scope, async (_board, outline) => {
      for (const topic of topics) {
        await this.#requireTopic(subject, scope, "create", topic, outline);
        await this.#checkPlacement(scope, topic, outline);
      }
      return { topics };
    });
    return topics;
  }

  /** The topic's module must be one of the offering's, and its assignment one of the offering's. */
  async #checkPlacement(scope: OfferingScope, topic: DiscussionTopic, outline: CourseOutline | undefined): Promise<void> {
    if (topic.moduleId !== undefined && !(outline?.modules ?? []).some((m) => m.id === topic.moduleId)) {
      throw new SchoolOsError("validation-failed", "a topic can only be placed in one of this class's modules");
    }
    if (topic.assignmentId !== undefined && !(await this.#options.assignmentsIn(scope.offeringId)).includes(topic.assignmentId)) {
      throw new SchoolOsError("validation-failed", "a graded topic must name one of this class's assignments");
    }
  }

  /** A topic is class material unless the module it sits in is unpublished or gone. */
  #topicClassification(topic: DiscussionTopic, outline: CourseOutline | undefined): Classification {
    if (topic.moduleId === undefined) return "course";
    return outline?.modules.find((m) => m.id === topic.moduleId)?.published === true ? "course" : "teacher-only";
  }

  async #visibleTopic(board: DiscussionBoard, topicId: unknown, viewer: Viewer, outline?: CourseOutline): Promise<DiscussionTopic> {
    const topic = board.topics.find((t) => t.id === topicId);
    if (topic === undefined) throw NOT_FOUND();
    if (viewer === "staff") return topic;
    const content = outline ?? (await this.#options.courseContent.load(board.offeringId));
    if (this.#topicClassification(topic, content) !== "course") throw NOT_FOUND();
    return topic;
  }

  async #requireTopic(subject: VerifiedPrincipal, scope: OfferingScope, action: Action, topic: DiscussionTopic, outline: CourseOutline | undefined): Promise<void> {
    await this.#require(subject, action, scope, "discussion-topic", this.#topicClassification(topic, outline), undefined, "Only the class's teachers can manage its discussion topics.");
  }

  /** The subject's own live post, which they may `action` in a topic they may post in. */
  async #ownPost(subject: VerifiedPrincipal, scope: OfferingScope, board: DiscussionBoard, postId: unknown, viewer: Viewer, action: "update" | "delete", outline: CourseOutline | undefined) {
    const post = board.posts.find((p) => p.id === postId);
    if (post === undefined || post.deletedAt !== undefined) throw NOT_FOUND();
    const classification = POST_CLASSIFICATION[post.status];
    if (!(await this.#allowed(subject, action, scope, "discussion-post", classification, post.authorId))) {
      if (await this.#allowed(subject, "read", scope, "discussion-post", classification, post.authorId)) throw new SchoolOsError("forbidden", "You can only change your own posts.");
      throw NOT_FOUND();
    }
    const topic = await this.#visibleTopic(board, post.topicId, viewer, outline);
    if (topic.locked && viewer !== "staff") throw new SchoolOsError("forbidden", "This discussion is locked.");
    return { post, topic };
  }

  #depth(board: DiscussionBoard, post: DiscussionPost): number {
    let depth = 1;
    for (let parent = post.parentId; parent !== undefined; parent = board.posts.find((p) => p.id === parent)?.parentId) depth++;
    return depth;
  }

  #event(subject: VerifiedPrincipal, action: ModerationAction, about: Omit<ModerationEvent, "id" | "action" | "by" | "at">): ModerationEvent {
    return { id: newId("dme"), action, by: subject.principalId, at: this.#now(), ...about };
  }

  /** Applies `change` to the stored board and commits it over the revision it read. */
  async #change(scope: OfferingScope, change: (board: DiscussionBoard, outline: CourseOutline | undefined) => Promise<Partial<Omit<BoardWrite, "revision">>>): Promise<void> {
    const board = await this.#load(scope.offeringId);
    const outline = await this.#options.courseContent.load(scope.offeringId);
    const write = await change(board, outline);
    if (Object.keys(write).length === 0) return;
    await this.#options.storage.commit(scope.offeringId, {
      revision: board.revision + 1,
      settings: write.settings ?? board.settings,
      topics: write.topics ?? [],
      deletedTopicIds: write.deletedTopicIds ?? [],
      posts: write.posts ?? [],
      moderation: write.moderation ?? [],
    }, board.revision);
  }

  async #load(offeringId: OfferingId): Promise<DiscussionBoard> {
    return (await this.#options.storage.load(offeringId)) ?? emptyBoard(offeringId);
  }

  /**
   * Who the subject is to the offering's discussions: its staff (they read restricted posts), an
   * administrator overseeing it (they read class posts but are not a student of it), or one of its
   * students.
   *
   * @throws SchoolOsError `not-found` if they may read none of it.
   */
  async #viewer(subject: VerifiedPrincipal, scope: OfferingScope): Promise<Viewer> {
    if (await this.#allowed(subject, "read", scope, "discussion-post", "restricted")) return "staff";
    if (!(await this.#allowed(subject, "read", scope, "discussion-post", "course"))) throw NOT_FOUND();
    const kind = this.#options.directory.principals.find((p) => p.id === subject.principalId)?.kind;
    return kind === "student" ? "student" : "oversight";
  }

  #scope(offeringId: unknown): OfferingScope {
    const id = OfferingId.safeParse(offeringId);
    const offering = id.success ? this.#options.directory.offerings.find((o) => o.id === id.data) : undefined;
    if (offering === undefined || offering.districtId !== this.#options.districtId) throw NOT_FOUND();
    return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
  }

  /** Requires `action`, answering `forbidden` if the subject may read the offering's discussions and `not-found` otherwise. */
  async #require(subject: VerifiedPrincipal, action: Action, scope: OfferingScope, kind: ResourceKind, classification: Classification, owner: PrincipalId | undefined, message: string): Promise<void> {
    if (await this.#allowed(subject, action, scope, kind, classification, owner)) return;
    if (await this.#allowed(subject, "read", scope, "discussion-topic", "course")) throw new SchoolOsError("forbidden", message);
    throw NOT_FOUND();
  }

  async #allowed(subject: VerifiedPrincipal, action: Action, scope: OfferingScope, kind: ResourceKind, classification: Classification, owner?: PrincipalId): Promise<boolean> {
    const offering = this.#options.directory.offerings.find((o) => o.id === scope.offeringId);
    const termState = this.#options.directory.terms.find((t) => t.id === offering?.termId)?.state;
    const decision = await this.#options.authorizer.authorize({
      subject,
      action,
      resource: { kind, scope, classification, ...(owner === undefined ? {} : { ownerPrincipalId: owner }) },
      context: { channel: this.#options.channel ?? "http", ...(termState === undefined ? {} : { termState }) },
    } satisfies AuthorizationRequest);
    return decision.effect === "allow";
  }
}

/** The status a moderation decision moves a post to. */
function nextStatus(post: DiscussionPost, decision: ModerationDecision): PostStatus {
  const refuse = (): never => {
    const done = { approve: "approved", hide: "hidden", unhide: "restored", remove: "removed", "dismiss-flags": "cleared" }[decision];
    throw new SchoolOsError("conflict", `This post is ${post.deletedAt === undefined ? post.status : "deleted"}, so it can't be ${done}.`);
  };
  if (post.deletedAt !== undefined && decision !== "dismiss-flags") refuse();
  switch (decision) {
    case "approve":
      return post.status === "pending" ? "visible" : refuse();
    case "hide":
      return post.status === "visible" || post.status === "pending" ? "hidden" : refuse();
    case "unhide":
      return post.status === "hidden" ? "visible" : refuse();
    case "remove":
      return post.status === "removed" ? refuse() : "removed";
    case "dismiss-flags":
      return post.status;
  }
}
