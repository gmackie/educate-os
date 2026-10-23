// The records of an offering's quizzes (SCHO-191): each quiz's items and settings, its students'
// attempts and the score releases its teachers made. One offering's records form a quiz book,
// stored and changed as one unit over a revision.
//
// A quiz's answer keys live only in `QuizItem`. Everything a student is sent is built from the
// separate `Student…` schemas below, which have no field a key could travel in, and is parsed
// through them before it leaves the service.
import { z } from "zod";
import { OfferingId, PrincipalId } from "@schoolos/contracts";
import { AssignmentId } from "@schoolos/assessment";
import { ContentTitle, CourseModuleId } from "@schoolos/curriculum";

/** Identifies a quiz. */
export const QuizId = z.string().regex(/^qz_[a-z0-9]{1,64}$/, "expected a quiz ID");
/** A quiz identifier. */
export type QuizId = z.infer<typeof QuizId>;

/** Identifies one item of a quiz. */
export const QuizItemId = z.string().regex(/^qzi_[a-z0-9]{1,64}$/, "expected a quiz item ID");
/** A quiz item identifier. */
export type QuizItemId = z.infer<typeof QuizItemId>;

/** Identifies a student's attempt at a quiz. */
export const QuizAttemptId = z.string().regex(/^qza_[a-z0-9]{1,64}$/, "expected a quiz attempt ID");
/** A quiz attempt identifier. */
export type QuizAttemptId = z.infer<typeof QuizAttemptId>;

/** Identifies one score release. */
export const QuizReleaseId = z.string().regex(/^qzr_[a-z0-9]{1,64}$/, "expected a quiz release ID");
/** A quiz release identifier. */
export type QuizReleaseId = z.infer<typeof QuizReleaseId>;

/** Identifies one choice within its item. */
export const ChoiceId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "expected a choice ID");
/** A choice identifier. */
export type ChoiceId = z.infer<typeof ChoiceId>;

// Markup that runs or loads code when rendered: the same rule as course pages and posts. Quiz text
// is rendered as text, never as HTML.
const ACTIVE_CONTENT = /<\s*\/?\s*(script|iframe|object|embed|applet|style|link|meta|base|form|svg)\b|\b(javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

/** The most characters a prompt, description or feedback may hold. */
export const MAX_QUIZ_TEXT_LENGTH = 5_000;

/** Quiz text: Markdown rendered as text, of at most {@link MAX_QUIZ_TEXT_LENGTH} characters. Markup that could run code is refused. */
export const QuizMarkdown = z.string().max(MAX_QUIZ_TEXT_LENGTH).refine((text) => !ACTIVE_CONTENT.test(text), "quiz text may not contain scripts or active markup");

/** A question's prompt: {@link QuizMarkdown} with some text in it. */
export const QuizPrompt = QuizMarkdown.refine((text) => text.trim().length > 0, "a question needs a prompt");

/** The most items a quiz may hold. */
export const MAX_QUIZ_ITEMS = 200;

/** The longest short answer a student may give, and so the longest text a pattern is ever run on. */
export const MAX_SHORT_ANSWER_LENGTH = 200;

/** The longest essay answer, in characters. */
export const MAX_ESSAY_LENGTH = 20_000;

/** The longest short-answer pattern, in characters. */
export const MAX_PATTERN_LENGTH = 200;

/** A timestamp, ISO 8601 with an offset. */
const Timestamp = z.iso.datetime({ offset: true });

/** One answer a choice item offers. */
export const QuizChoice = z.strictObject({
  id: ChoiceId,
  text: z.string().trim().min(1).max(1_000).refine((text) => !ACTIVE_CONTENT.test(text), "a choice may not contain active markup"),
});
/** A quiz choice. */
export type QuizChoice = z.infer<typeof QuizChoice>;

const Choices = z.array(QuizChoice).min(2).max(20).refine((choices) => new Set(choices.map((c) => c.id)).size === choices.length, "choice IDs must be unique");

/**
 * Whether a short-answer pattern is safe to run on a student's answer: it compiles, and it has none
 * of what makes a backtracking engine take exponential time (a quantified group that itself holds a
 * quantifier or an alternation, as in `(a+)+` or `(a|aa)*`) nor a backreference or lookaround. The
 * answer it runs on is also capped at {@link MAX_SHORT_ANSWER_LENGTH} characters.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  try {
    new RegExp(pattern, "iu");
  } catch {
    return false;
  }
  if (/\\[1-9]|\\k<|\(\?<?[=!]/.test(pattern)) return false;
  // Each open group: whether it (or a group nested in it) holds a quantifier or an alternation.
  const open: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") open.push(false);
    else if (char === "|" || char === "*" || char === "+" || char === "{" || (char === "?" && pattern[i - 1] !== "(")) {
      if (open.length > 0) open[open.length - 1] = true;
    } else if (char === ")") {
      const risky = open.pop() ?? false;
      const next = pattern[i + 1];
      if (risky && (next === "*" || next === "+" || next === "{")) return false;
      if (risky && open.length > 0) open[open.length - 1] = true;
    }
  }
  return true;
}

/** A short-answer pattern a teacher writes: a regular expression {@link isSafePattern} accepts, matched against the whole answer, case-insensitively. */
export const ShortAnswerPattern = z.string().refine(isSafePattern, `a pattern must compile, be at most ${MAX_PATTERN_LENGTH} characters, and have no nested quantifiers, backreferences or lookarounds`);

/** The item variants, over an ID schema: required in stored items, optional in what a teacher sends. */
function itemVariants<I extends z.ZodType>(id: I) {
  const base = {
    id,
    prompt: QuizPrompt,
    /** What the item is worth. */
    points: z.number().positive().max(1_000),
    /** Feedback shown with the correct answer, when the quiz shows answers. */
    feedback: QuizMarkdown.optional(),
  };
  return [
    z.strictObject({ ...base, type: z.literal("multiple-choice"), choices: Choices, correctChoiceId: ChoiceId }),
    z.strictObject({
      ...base,
      type: z.literal("multiple-select"),
      choices: Choices,
      correctChoiceIds: z.array(ChoiceId).min(1).max(20),
      scoring: z.enum(["all-or-nothing", "partial"]),
    }),
    z.strictObject({ ...base, type: z.literal("true-false"), correct: z.boolean() }),
    z.strictObject({ ...base, type: z.literal("numeric"), answer: z.number().finite(), tolerance: z.number().finite().nonnegative() }),
    z.strictObject({
      ...base,
      type: z.literal("short-answer"),
      acceptedAnswers: z.array(z.string().trim().min(1).max(MAX_SHORT_ANSWER_LENGTH)).max(20),
      pattern: ShortAnswerPattern.optional(),
    }),
    z.strictObject({ ...base, type: z.literal("essay"), maxLength: z.int().min(1).max(MAX_ESSAY_LENGTH).optional() }),
  ] as const;
}

/** The checks across an item's fields. */
function checkItem(
  item:
    | { type: "multiple-choice"; choices: QuizChoice[]; correctChoiceId: string }
    | { type: "multiple-select"; choices: QuizChoice[]; correctChoiceIds: string[] }
    | { type: "short-answer"; acceptedAnswers: string[]; pattern?: string | undefined }
    | { type: "true-false" | "numeric" | "essay" },
  ctx: z.RefinementCtx,
): void {
  if (item.type === "multiple-choice" && !item.choices.some((c) => c.id === item.correctChoiceId)) {
    ctx.addIssue({ code: "custom", path: ["correctChoiceId"], message: "the correct choice must be one of the item's choices" });
  }
  if (item.type === "multiple-select") {
    const ids = new Set(item.choices.map((c) => c.id));
    if (item.correctChoiceIds.some((id) => !ids.has(id)) || new Set(item.correctChoiceIds).size !== item.correctChoiceIds.length) {
      ctx.addIssue({ code: "custom", path: ["correctChoiceIds"], message: "the correct choices must be distinct choices of the item" });
    }
  }
  if (item.type === "short-answer" && item.acceptedAnswers.length === 0 && item.pattern === undefined) {
    ctx.addIssue({ code: "custom", path: ["acceptedAnswers"], message: "a short-answer item needs an accepted answer or a pattern" });
  }
}

/**
 * One item of a quiz, answer key included. Every type but `essay` is scored on the server, the
 * moment an attempt is submitted; an essay waits for a teacher. AI never scores an item.
 *
 * - `multiple-choice`: one choice is right.
 * - `multiple-select`: the right choices, all of them. `all-or-nothing` gives the points only for
 *   exactly those; `partial` gives each right choice chosen its share and takes a share away for
 *   each wrong one chosen, never below zero.
 * - `true-false`: the statement is true or false.
 * - `numeric`: a number within `tolerance` (absolute) of `answer`.
 * - `short-answer`: one of `acceptedAnswers`, compared case-insensitively after trimming and
 *   collapsing spaces, or text the whole of which `pattern` matches, case-insensitively.
 * - `essay`: written text a teacher grades.
 */
export const QuizItem = z.discriminatedUnion("type", itemVariants(QuizItemId)).superRefine(checkItem);
/** A quiz item. */
export type QuizItem = z.infer<typeof QuizItem>;
/** A quiz item type. */
export type QuizItemType = QuizItem["type"];

/** The item types SchoolOS scores itself. */
export const AUTO_SCORED_TYPES: readonly QuizItemType[] = ["multiple-choice", "multiple-select", "true-false", "numeric", "short-answer"];

/**
 * When a student sees the correct answers and feedback on an attempt: `never`, as soon as they
 * `after-submit` it, or `after-release`, once the teacher has released the quiz's scores to them.
 */
export const ShowAnswers = z.enum(["never", "after-submit", "after-release"]);
/** A show-answers setting. */
export type ShowAnswers = z.infer<typeof ShowAnswers>;

/** Which attempt's score becomes a student's grade: their `best`, or their `latest`. */
export const ScorePolicy = z.enum(["best", "latest"]);
/** A score policy. */
export type ScorePolicy = z.infer<typeof ScorePolicy>;

/** A quiz's settings. They may change at any time; items may not once anyone has started it. */
export const QuizSettings = z.strictObject({
  /** How many attempts each student may start. An attempt whose time ran out counts. */
  attemptsAllowed: z.int().min(1).max(20),
  /** Minutes each attempt has from its start. Without one, an attempt lasts until the quiz closes. */
  timeLimitMinutes: z.int().min(1).max(600).optional(),
  /** When students may start attempts. */
  availableFrom: Timestamp.optional(),
  /** When the quiz closes: no attempt is started, saved or submitted after it. */
  availableUntil: Timestamp.optional(),
  /** Whether each attempt shows the items in its own order. */
  shuffleQuestions: z.boolean(),
  /** Whether each attempt shows each item's choices in its own order. */
  shuffleChoices: z.boolean(),
  showAnswers: ShowAnswers,
  scorePolicy: ScorePolicy,
}).refine((s) => s.availableFrom === undefined || s.availableUntil === undefined || Date.parse(s.availableFrom) < Date.parse(s.availableUntil), "a quiz closes after it opens");
/** Quiz settings. */
export type QuizSettings = z.infer<typeof QuizSettings>;

/** The settings of a quiz that sets none. */
export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
  attemptsAllowed: 1,
  shuffleQuestions: false,
  shuffleChoices: false,
  showAnswers: "after-release",
  scorePolicy: "best",
};

/** Where a quiz came from, when it was not built in SchoolOS. */
export const QuizSource = z.strictObject({
  kind: z.literal("cartridge"),
  fileName: z.string().min(1).max(255),
  packageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The organization item that placed it in the cartridge. */
  identifier: z.string().min(1).max(200),
});
/** A quiz source. */
export type QuizSource = z.infer<typeof QuizSource>;

const QuizItems = z.array(QuizItem).max(MAX_QUIZ_ITEMS).refine((items) => new Set(items.map((i) => i.id)).size === items.length, "item IDs must be unique");

/**
 * A quiz: ordered items, settings, and the assignment its released scores are official grades of.
 * A `draft` is its staff's alone; a `published` quiz is its class's once the module it sits in (if
 * any) is published too.
 */
export const Quiz = z.strictObject({
  id: QuizId,
  offeringId: OfferingId,
  title: ContentTitle,
  description: QuizMarkdown,
  /** The course module it sits in. Students see it only while that module is published. */
  moduleId: CourseModuleId.optional(),
  /** The assignment its scores are released as grades of. A quiz is published only once it has one. */
  assignmentId: AssignmentId.optional(),
  items: QuizItems,
  settings: QuizSettings,
  status: z.enum(["draft", "published"]),
  source: QuizSource.optional(),
  createdBy: PrincipalId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
/** A quiz. */
export type Quiz = z.infer<typeof Quiz>;

/** A student's response to one item, by the item's type. */
export const QuizResponse = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("multiple-choice"), choiceId: ChoiceId }),
  z.strictObject({ type: z.literal("multiple-select"), choiceIds: z.array(ChoiceId).max(20) }),
  z.strictObject({ type: z.literal("true-false"), value: z.boolean() }),
  z.strictObject({ type: z.literal("numeric"), value: z.number().finite() }),
  z.strictObject({ type: z.literal("short-answer"), text: z.string().max(MAX_SHORT_ANSWER_LENGTH) }),
  z.strictObject({ type: z.literal("essay"), text: z.string().max(MAX_ESSAY_LENGTH) }),
]);
/** A quiz response. */
export type QuizResponse = z.infer<typeof QuizResponse>;

/** A response to one item. */
export const QuizAnswer = z.strictObject({ itemId: QuizItemId, response: QuizResponse });
/** A quiz answer. */
export type QuizAnswer = z.infer<typeof QuizAnswer>;

/** How one item of a submitted attempt scored: automatically, by a teacher, or not yet (an essay waiting). */
export const ItemScore = z.strictObject({
  itemId: QuizItemId,
  /** Null while the item waits for a teacher. */
  points: z.number().nonnegative().max(1_000).nullable(),
  maxPoints: z.number().positive().max(1_000),
  /** `auto` for the server's scoring, `teacher` once a teacher graded or rescored it. */
  source: z.enum(["auto", "teacher"]),
  gradedBy: PrincipalId.optional(),
  gradedAt: Timestamp.optional(),
  /** A teacher's comment to the student on this item. */
  comment: QuizMarkdown.optional(),
}).refine((s) => s.points === null || s.points <= s.maxPoints, "points cannot exceed the maximum");
/** An item score. */
export type ItemScore = z.infer<typeof ItemScore>;

/**
 * One student's attempt at a quiz. It is `in-progress` from its start until it is `submitted`;
 * past its deadline an unsubmitted attempt can no longer be saved or submitted, and it counts as
 * an attempt used.
 */
export const QuizAttempt = z.strictObject({
  id: QuizAttemptId,
  quizId: QuizId,
  offeringId: OfferingId,
  studentId: PrincipalId,
  /** 1 for the student's first attempt at the quiz. */
  number: z.int().positive(),
  /** Seeds the attempt's question and choice order, so it is the same every time it is shown. */
  seed: z.string().regex(/^[0-9a-f]{16,64}$/),
  startedAt: Timestamp,
  /** When it must be submitted by: its start plus the time limit, or the quiz's close, whichever is earlier. */
  deadline: Timestamp.optional(),
  answers: z.array(QuizAnswer).max(MAX_QUIZ_ITEMS),
  savedAt: Timestamp.optional(),
  status: z.enum(["in-progress", "submitted"]),
  submittedAt: Timestamp.optional(),
  /** The assessment submission its answer sheet became, which its released grade is for. */
  submissionId: z.string().min(1).max(200).optional(),
  /** Set when submitted: one per item, in the quiz's order. */
  itemScores: z.array(ItemScore).max(MAX_QUIZ_ITEMS).optional(),
});
/** A quiz attempt. */
export type QuizAttempt = z.infer<typeof QuizAttempt>;

/** One student's grade in a release, and what recording it did. */
export const ReleasedGrade = z.strictObject({
  studentId: PrincipalId,
  attemptId: QuizAttemptId,
  submissionId: z.string().min(1).max(200),
  points: z.number().nonnegative(),
  maxPoints: z.number().positive(),
  /** `official` at once (the class's teacher released it), or `pending-approval` for a teacher to approve. */
  outcome: z.enum(["official", "pending-approval"]),
  /** The official grade version it became, when official. */
  version: z.int().positive().optional(),
});
/** A released grade. */
export type ReleasedGrade = z.infer<typeof ReleasedGrade>;

/** One score release: a teacher's single action making a quiz's scores official grades. */
export const QuizRelease = z.strictObject({
  id: QuizReleaseId,
  quizId: QuizId,
  by: PrincipalId,
  at: Timestamp,
  grades: z.array(ReleasedGrade).max(10_000),
});
/** A quiz release. */
export type QuizRelease = z.infer<typeof QuizRelease>;

/** One offering's quizzes as stored: its quizzes, attempts and releases. */
export const QuizBook = z.strictObject({
  offeringId: OfferingId,
  /** 0 before anything is stored; each commit adds one. */
  revision: z.int().nonnegative(),
  quizzes: z.array(Quiz).max(500),
  attempts: z.array(QuizAttempt).max(100_000),
  releases: z.array(QuizRelease),
});
/** A quiz book. */
export type QuizBook = z.infer<typeof QuizBook>;

/** An item as a teacher writes it: a {@link QuizItem} whose ID the service assigns when it has none. */
export const QuizItemDraft = z.discriminatedUnion("type", itemVariants(QuizItemId.optional())).superRefine(checkItem);
/** A quiz item draft. */
export type QuizItemDraft = z.input<typeof QuizItemDraft>;

/** A new quiz. Items without an ID are given one. */
export const NewQuiz = z.strictObject({
  title: ContentTitle,
  description: QuizMarkdown.default(""),
  moduleId: CourseModuleId.optional(),
  assignmentId: AssignmentId.optional(),
  items: z.array(QuizItemDraft).max(MAX_QUIZ_ITEMS).default([]),
  settings: QuizSettings.default(DEFAULT_QUIZ_SETTINGS),
});
/** A new quiz. */
export type NewQuiz = z.input<typeof NewQuiz>;

/** A change to a quiz. An omitted field is unchanged; `null` clears its module or assignment. Items are replaced whole. */
export const QuizPatch = z.strictObject({
  title: ContentTitle.optional(),
  description: QuizMarkdown.optional(),
  moduleId: CourseModuleId.nullable().optional(),
  assignmentId: AssignmentId.nullable().optional(),
  items: z.array(QuizItemDraft).max(MAX_QUIZ_ITEMS).optional(),
  settings: QuizSettings.optional(),
});
/** A quiz change. */
export type QuizPatch = z.input<typeof QuizPatch>;

/** A teacher's grade for one item of a submitted attempt. */
export const ItemGradeInput = z.strictObject({
  points: z.number().nonnegative().max(1_000),
  comment: QuizMarkdown.optional(),
});
/** An item grade. */
export type ItemGradeInput = z.infer<typeof ItemGradeInput>;

// What students are sent. None of these has a field an answer key could travel in.

/** A choice as a student sees it. */
export const StudentChoice = z.strictObject({ id: ChoiceId, text: z.string() });

/** One question as a student taking the quiz sees it: no key, no feedback. */
export const StudentQuestion = z.strictObject({
  id: QuizItemId,
  type: z.enum(["multiple-choice", "multiple-select", "true-false", "numeric", "short-answer", "essay"]),
  prompt: z.string(),
  points: z.number(),
  /** The choices, in this attempt's order, for choice items. */
  choices: z.array(StudentChoice).optional(),
  /** The longest answer accepted, for text items. */
  maxLength: z.int().positive().optional(),
});
/** A student question. */
export type StudentQuestion = z.infer<typeof StudentQuestion>;

/** Where a quiz is for a student: not yet open, open, or closed. */
export const QuizAvailability = z.enum(["upcoming", "open", "closed"]);
/** A quiz availability. */
export type QuizAvailability = z.infer<typeof QuizAvailability>;

/** One of a student's attempts, summarized for them. Scores appear only once released. */
export const StudentAttemptSummary = z.strictObject({
  id: QuizAttemptId,
  number: z.int().positive(),
  status: z.enum(["in-progress", "submitted", "expired"]),
  startedAt: z.string(),
  deadline: z.string().optional(),
  submittedAt: z.string().optional(),
});
/** A student attempt summary. */
export type StudentAttemptSummary = z.infer<typeof StudentAttemptSummary>;

/** A quiz as a student sees it before and between attempts: its settings and their own attempts, never its items. */
export const StudentQuizView = z.strictObject({
  id: QuizId,
  offeringId: OfferingId,
  title: z.string(),
  description: z.string(),
  moduleId: z.string().optional(),
  assignmentId: z.string().optional(),
  questionCount: z.int().nonnegative(),
  totalPoints: z.number().nonnegative(),
  attemptsAllowed: z.int().positive(),
  timeLimitMinutes: z.int().positive().optional(),
  availableFrom: z.string().optional(),
  availableUntil: z.string().optional(),
  showAnswers: ShowAnswers,
  availability: QuizAvailability,
  attempts: z.array(StudentAttemptSummary),
  /** Whether they may start (or resume) an attempt now. */
  canStart: z.boolean(),
  /** Their released score, once the teacher has released one. */
  releasedScore: z.strictObject({ points: z.number(), maxPoints: z.number() }).optional(),
});
/** A student's quiz view. */
export type StudentQuizView = z.infer<typeof StudentQuizView>;

/** An attempt in progress, as the student taking it sees it: questions in its order, their saved answers, and the time. */
export const StudentAttemptView = z.strictObject({
  attemptId: QuizAttemptId,
  quizId: QuizId,
  title: z.string(),
  number: z.int().positive(),
  questions: z.array(StudentQuestion),
  answers: z.array(QuizAnswer),
  startedAt: z.string(),
  deadline: z.string().optional(),
  savedAt: z.string().optional(),
  /** The server's clock when this was built, so a timer counts from the server's time, not the device's. */
  serverNow: z.string(),
});
/** A student's attempt in progress. */
export type StudentAttemptView = z.infer<typeof StudentAttemptView>;

/** One question of a finished attempt as its student sees it. The key, points and feedback appear only when the quiz shows them. */
export const StudentItemResult = z.strictObject({
  question: StudentQuestion,
  response: QuizResponse.optional(),
  /** Shown with answers: the points it earned, or null while a teacher grades it. */
  points: z.number().nullable().optional(),
  /** Shown with answers: whether it earned full points. */
  correct: z.boolean().optional(),
  /** Shown with answers: the correct response, for items that have one. */
  correctResponse: QuizResponse.optional(),
  /** Shown with answers: what else counts, for short answers. */
  acceptedAnswers: z.array(z.string()).optional(),
  feedback: z.string().optional(),
  /** The teacher's comment, shown with answers. */
  comment: z.string().optional(),
});
/** A student item result. */
export type StudentItemResult = z.infer<typeof StudentItemResult>;

/** A finished attempt as its student sees it. */
export const StudentAttemptResult = z.strictObject({
  attemptId: QuizAttemptId,
  quizId: QuizId,
  title: z.string(),
  number: z.int().positive(),
  status: z.enum(["submitted", "expired"]),
  submittedAt: z.string().optional(),
  /** Whether answers and feedback are shown, by the quiz's setting and whether scores are released. */
  answersShown: z.boolean(),
  /** Whether the teacher has released this quiz's scores to the student. */
  released: z.boolean(),
  /** The student's released score for the quiz (by its score policy), once released. */
  releasedScore: z.strictObject({ points: z.number(), maxPoints: z.number() }).optional(),
  items: z.array(StudentItemResult),
});
/** A student attempt result. */
export type StudentAttemptResult = z.infer<typeof StudentAttemptResult>;

// What staff are sent.

/** One quiz in a staff listing, with counts of what needs them. */
export const QuizSummary = z.strictObject({
  quiz: Quiz,
  /** Submitted attempts. */
  submitted: z.int().nonnegative(),
  /** Submitted attempts with an essay waiting for a teacher. */
  needsGrading: z.int().nonnegative(),
  /** When scores were last released. */
  lastReleasedAt: z.string().optional(),
});
/** A quiz summary. */
export type QuizSummary = z.infer<typeof QuizSummary>;

/** An offering's quizzes as one reader sees them. */
export const QuizListing = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("staff"), canManage: z.boolean(), quizzes: z.array(QuizSummary) }),
  z.strictObject({ view: z.literal("student"), quizzes: z.array(StudentQuizView) }),
]);
/** A quiz listing. */
export type QuizListing = z.infer<typeof QuizListing>;

/** One item's results across submitted attempts. */
export const ItemAnalysis = z.strictObject({
  itemId: QuizItemId,
  /** Submitted attempts that answered it, graded or not. */
  responses: z.int().nonnegative(),
  /** Graded attempts that earned its full points. */
  correct: z.int().nonnegative(),
  /** Graded attempts. */
  graded: z.int().nonnegative(),
  /** `correct / graded` as a percentage, or null before any is graded. */
  percentCorrect: z.number().min(0).max(100).nullable(),
  /** The mean points earned over graded attempts, or null before any is graded. */
  meanPoints: z.number().nullable(),
});
/** An item analysis. */
export type ItemAnalysis = z.infer<typeof ItemAnalysis>;

/** One student's row in a quiz's results. */
export const StudentResultRow = z.strictObject({
  studentId: PrincipalId,
  attempts: z.array(z.strictObject({
    id: QuizAttemptId,
    number: z.int().positive(),
    status: z.enum(["in-progress", "submitted", "expired"]),
    submittedAt: z.string().optional(),
    /** Null while an essay waits; absent before submission. */
    points: z.number().nullable().optional(),
    maxPoints: z.number().positive(),
  })),
  /** The attempt the score policy picks for the grade, once one is fully graded. */
  gradedAttemptId: QuizAttemptId.optional(),
  /** The score that release would make official. */
  score: z.strictObject({ points: z.number(), maxPoints: z.number() }).optional(),
  /** Whether a submitted attempt still waits for a teacher. */
  needsGrading: z.boolean(),
  /** The score last released for the student, and whether it still matches. */
  released: z.strictObject({ points: z.number(), maxPoints: z.number(), outcome: ReleasedGrade.shape.outcome, at: z.string(), current: z.boolean() }).optional(),
});
/** A student result row. */
export type StudentResultRow = z.infer<typeof StudentResultRow>;

/** A quiz's results for its staff: each student's attempts and score, item analysis, and its releases. */
export const QuizResults = z.strictObject({
  quiz: Quiz,
  students: z.array(StudentResultRow),
  items: z.array(ItemAnalysis),
  releases: z.array(QuizRelease),
  /** Students whose score a release would make official now, or change. */
  releasable: z.int().nonnegative(),
});
/** Quiz results. */
export type QuizResults = z.infer<typeof QuizResults>;

/** What one score release did. */
export const ReleaseOutcome = z.strictObject({
  /** The release recorded, or none when there was nothing to release. */
  release: QuizRelease.optional(),
  /** Grades made official now. */
  official: z.int().nonnegative(),
  /** Grades waiting for the class's teacher to approve. */
  pendingApproval: z.int().nonnegative(),
  /** Students whose released grade already matches. */
  unchanged: z.int().nonnegative(),
  /** Students left out because an essay still waits for grading. */
  waitingForGrading: z.int().nonnegative(),
});
/** A release outcome. */
export type ReleaseOutcome = z.infer<typeof ReleaseOutcome>;

/** A submitted attempt as staff grade it: the quiz with its keys, and the attempt whole. */
export const StaffAttemptView = z.strictObject({ quiz: Quiz, attempt: QuizAttempt });
/** A staff attempt view. */
export type StaffAttemptView = z.infer<typeof StaffAttemptView>;
