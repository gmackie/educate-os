// The records of an offering's discussions (SCHO-190): its topics, the threaded posts in them, the
// offering's discussion settings and a content-free trail of moderation. One offering's records
// form a board, stored and changed as one unit over a revision.
import { z } from "zod";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import { AssignmentId } from "@educateos/assessment";
import { ContentTitle, CourseModuleId } from "@educateos/curriculum";

/** Identifies a discussion topic. */
export const DiscussionTopicId = z.string().regex(/^dtp_[a-z0-9]{1,64}$/, "expected a discussion topic ID");
/** A discussion topic identifier. */
export type DiscussionTopicId = z.infer<typeof DiscussionTopicId>;

/** Identifies a discussion post. */
export const DiscussionPostId = z.string().regex(/^dps_[a-z0-9]{1,64}$/, "expected a discussion post ID");
/** A discussion post identifier. */
export type DiscussionPostId = z.infer<typeof DiscussionPostId>;

/** Identifies one entry of the moderation trail. */
export const ModerationEventId = z.string().regex(/^dme_[a-z0-9]{1,64}$/, "expected a moderation event ID");
/** A moderation event identifier. */
export type ModerationEventId = z.infer<typeof ModerationEventId>;

/** The most characters a post's or a topic prompt's Markdown may hold. */
export const MAX_POST_LENGTH = 10_000;

/** How deep replies may nest: a post, a reply to it, and so on, this many levels in all. */
export const MAX_THREAD_DEPTH = 8;

// Markup that runs or loads code when rendered: the same rule as course pages. Posts are rendered
// as text with a small fixed set of formatting, never as HTML; refusing these as well means a
// renderer that slips cannot be turned into a script host.
const ACTIVE_CONTENT = /<\s*\/?\s*(script|iframe|object|embed|applet|style|link|meta|base|form|svg)\b|\b(javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

/**
 * A post's or a prompt's body: Markdown of at most {@link MAX_POST_LENGTH} characters, rendered as
 * text with headings, lists, emphasis and `https` links only. Markup that could run code is refused.
 */
export const DiscussionMarkdown = z.string().max(MAX_POST_LENGTH).refine((text) => !ACTIVE_CONTENT.test(text), "a post may not contain scripts or active markup");

/** A post body someone writes: {@link DiscussionMarkdown} with some text in it. */
export const PostBody = DiscussionMarkdown.refine((text) => text.trim().length > 0, "a post needs some text");

/** A timestamp, ISO 8601 with an offset. */
const Timestamp = z.iso.datetime({ offset: true });

/** An offering's discussion settings. */
export const DiscussionSettings = z.strictObject({
  /**
   * Whether each student post waits for a teacher's approval before the class sees it. Off by
   * default: a student post is visible as soon as it has been screened, and teachers moderate after.
   */
  premoderation: z.boolean(),
});
/** Discussion settings. */
export type DiscussionSettings = z.infer<typeof DiscussionSettings>;

/** The settings of an offering that has never changed them. */
export const DEFAULT_DISCUSSION_SETTINGS: DiscussionSettings = { premoderation: false };

/** A topic's own settings. */
export const TopicSettings = z.strictObject({
  /** Whether posts may be answered in threads, or only posted at the top level. */
  allowReplies: z.boolean(),
});
/** Topic settings. */
export type TopicSettings = z.infer<typeof TopicSettings>;

/** Where a topic came from, when it was not opened in EducateOS. */
export const TopicSource = z.strictObject({
  kind: z.literal("cartridge"),
  fileName: z.string().min(1).max(255),
  packageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The organization item that placed it in the cartridge. */
  identifier: z.string().min(1).max(200),
});
/** A topic source. */
export type TopicSource = z.infer<typeof TopicSource>;

/** A discussion topic: a prompt the class answers in threaded posts. */
export const DiscussionTopic = z.strictObject({
  id: DiscussionTopicId,
  offeringId: OfferingId,
  /** The course module it sits in. Students see it only while that module is published. */
  moduleId: CourseModuleId.optional(),
  title: ContentTitle,
  prompt: DiscussionMarkdown,
  /** A locked topic takes no new posts from students; staff still post and moderate. */
  locked: z.boolean(),
  /** Pinned topics are listed first. */
  pinned: z.boolean(),
  /**
   * The assignment its participation is graded under, when it is graded. The grade itself is
   * recorded through that assignment, like any other.
   */
  assignmentId: AssignmentId.optional(),
  settings: TopicSettings,
  source: TopicSource.optional(),
  createdBy: PrincipalId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
/** A discussion topic. */
export type DiscussionTopic = z.infer<typeof DiscussionTopic>;

/**
 * Where a post is in moderation. `visible` posts are read by the class; `pending` ones wait for a
 * teacher's approval and are read by their author and staff; `hidden` ones a teacher took down and
 * may restore; `removed` ones a teacher took down for good. Hidden and removed posts are read by
 * staff only.
 */
export const PostStatus = z.enum(["visible", "pending", "hidden", "removed"]);
/** A post status. */
export type PostStatus = z.infer<typeof PostStatus>;

/** Why a post is flagged for its teachers: Hall Monitor let it through with a concern, or a student reported it. */
export const PostFlag = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("screening"),
    /** Hall Monitor's decision: `coach` (shown, with a concern) or `hold` (kept back for a teacher). */
    decision: z.enum(["coach", "hold"]),
    /** Hall Monitor's machine reason codes. Labels only, never the text. */
    reasonCodes: z.array(z.string().max(96)).max(64),
    at: Timestamp,
  }),
  z.strictObject({
    kind: z.literal("report"),
    by: PrincipalId,
    reason: z.enum(["unkind", "unsafe", "off-topic", "other"]),
    at: Timestamp,
  }),
]);
/** A post flag. */
export type PostFlag = z.infer<typeof PostFlag>;

/** One post in a topic. A reply names the post it answers. */
export const DiscussionPost = z.strictObject({
  id: DiscussionPostId,
  offeringId: OfferingId,
  topicId: DiscussionTopicId,
  parentId: DiscussionPostId.optional(),
  authorId: PrincipalId,
  /** Whether its author wrote it as course staff or as a student, when they wrote it. */
  authorRole: z.enum(["student", "staff"]),
  /** Empty once its author deleted it; the post stays so replies to it keep their place. */
  body: DiscussionMarkdown,
  status: PostStatus,
  /** Open flags for the teachers. Cleared when a teacher dismisses them. */
  flags: z.array(PostFlag).max(100),
  createdAt: Timestamp,
  editedAt: Timestamp.optional(),
  deletedAt: Timestamp.optional(),
}).refine((post) => post.deletedAt !== undefined || post.body.trim().length > 0, "a post needs some text");
/** A discussion post. */
export type DiscussionPost = z.infer<typeof DiscussionPost>;

/** What a moderation trail entry records. */
export const ModerationAction = z.enum([
  "approve",
  "hide",
  "unhide",
  "remove",
  "dismiss-flags",
  "report",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "premoderation-on",
  "premoderation-off",
  /** Hall Monitor kept a student's post from being shared. Nothing of the post is stored. */
  "screening-refused",
]);
/** A moderation action. */
export type ModerationAction = z.infer<typeof ModerationAction>;

/** One entry of an offering's moderation trail: who did what to which topic or post, and when. Never content. */
export const ModerationEvent = z.strictObject({
  id: ModerationEventId,
  action: ModerationAction,
  by: PrincipalId,
  at: Timestamp,
  topicId: DiscussionTopicId.optional(),
  postId: DiscussionPostId.optional(),
  /** For a refused post, its author; for a post, who wrote it. */
  authorId: PrincipalId.optional(),
  /** Hall Monitor's reason codes, for screening entries. */
  reasonCodes: z.array(z.string().max(96)).max(64).optional(),
});
/** A moderation event. */
export type ModerationEvent = z.infer<typeof ModerationEvent>;

/** One offering's discussions as stored: settings, topics, posts and the moderation trail. */
export const DiscussionBoard = z.strictObject({
  offeringId: OfferingId,
  /** 0 before anything is stored; each commit adds one. */
  revision: z.int().nonnegative(),
  settings: DiscussionSettings,
  topics: z.array(DiscussionTopic).max(500),
  posts: z.array(DiscussionPost).max(50_000),
  moderation: z.array(ModerationEvent),
});
/** A discussion board. */
export type DiscussionBoard = z.infer<typeof DiscussionBoard>;

/** A new topic. */
export const NewTopic = z.strictObject({
  title: ContentTitle,
  prompt: DiscussionMarkdown,
  moduleId: CourseModuleId.optional(),
  assignmentId: AssignmentId.optional(),
  locked: z.boolean().default(false),
  pinned: z.boolean().default(false),
  settings: TopicSettings.default({ allowReplies: true }),
});
/** A new topic. */
export type NewTopic = z.input<typeof NewTopic>;

/** A change to a topic. An omitted field is unchanged; `null` clears its module or assignment. */
export const TopicPatch = z.strictObject({
  title: ContentTitle.optional(),
  prompt: DiscussionMarkdown.optional(),
  moduleId: CourseModuleId.nullable().optional(),
  assignmentId: AssignmentId.nullable().optional(),
  locked: z.boolean().optional(),
  pinned: z.boolean().optional(),
  settings: TopicSettings.optional(),
});
/** A topic change. */
export type TopicPatch = z.input<typeof TopicPatch>;

/** A new post, or a reply when it names its parent. */
export const NewPost = z.strictObject({ body: PostBody, parentId: DiscussionPostId.optional() });
/** A new post. */
export type NewPost = z.input<typeof NewPost>;

/** What a teacher may do to a post. */
export const ModerationDecision = z.enum(["approve", "hide", "unhide", "remove", "dismiss-flags"]);
/** A moderation decision. */
export type ModerationDecision = z.infer<typeof ModerationDecision>;

/** A student's report of a post. */
export const PostReport = z.strictObject({ reason: z.enum(["unkind", "unsafe", "off-topic", "other"]) });
/** A post report. */
export type PostReport = z.infer<typeof PostReport>;

/**
 * A post as a student reads it. Others' visible posts and their own visible or waiting posts come
 * with their text; a post that is deleted, hidden or removed but has replies the student may read
 * is a `withdrawn` placeholder with no author or text, so the thread keeps its shape. Flags and
 * moderation never reach a student.
 */
export const StudentPostView = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["visible", "pending"]),
    id: DiscussionPostId,
    topicId: DiscussionTopicId,
    parentId: DiscussionPostId.optional(),
    authorId: PrincipalId,
    authorRole: z.enum(["student", "staff"]),
    body: DiscussionMarkdown,
    createdAt: Timestamp,
    editedAt: Timestamp.optional(),
    /** Whether the reader wrote it. */
    mine: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("withdrawn"),
    id: DiscussionPostId,
    topicId: DiscussionTopicId,
    parentId: DiscussionPostId.optional(),
    createdAt: Timestamp,
  }),
]);
/** A student's view of a post. */
export type StudentPostView = z.infer<typeof StudentPostView>;

/**
 * A topic and its posts as one reader may see them: staff (and administrators, who see visible
 * posts only) in full, students as {@link StudentPostView}s. Posts are in the order they were written.
 */
export const TopicThread = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("staff"), topic: DiscussionTopic, posts: z.array(DiscussionPost) }),
  z.strictObject({ view: z.literal("student"), topic: DiscussionTopic, posts: z.array(StudentPostView) }),
]);
/** A topic thread. */
export type TopicThread = z.infer<typeof TopicThread>;

/** One topic in a listing, with how many posts the reader may see and, for staff, how many need attention. */
export const TopicSummary = z.strictObject({
  topic: DiscussionTopic,
  posts: z.int().nonnegative(),
  /** For staff: posts waiting for approval or carrying a flag. Always 0 for students. */
  needsAttention: z.int().nonnegative(),
});
/** A topic summary. */
export type TopicSummary = z.infer<typeof TopicSummary>;

/** An offering's topics as one reader may see them, pinned first, then newest first. */
export const TopicListing = z.strictObject({
  view: z.enum(["staff", "student"]),
  /** Whether the reader may open, edit and moderate topics. */
  canModerate: z.boolean(),
  settings: DiscussionSettings,
  topics: z.array(TopicSummary),
});
/** A topic listing. */
export type TopicListing = z.infer<typeof TopicListing>;

/** What a teacher's moderation queue shows: posts waiting or flagged, and the trail. */
export const ModerationQueue = z.strictObject({
  settings: DiscussionSettings,
  /** Posts waiting for approval, oldest first. */
  pending: z.array(DiscussionPost),
  /** Posts carrying open flags, oldest first. */
  flagged: z.array(DiscussionPost),
  /** The most recent moderation entries, newest first. */
  recent: z.array(ModerationEvent),
});
/** A moderation queue. */
export type ModerationQueue = z.infer<typeof ModerationQueue>;
