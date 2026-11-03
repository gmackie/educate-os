// The shapes of the showcase content (SCHO-322): plain data, keyed by fixture offering and principal
// IDs, which `seedShowcase` in `@educateos/harness` turns into district API calls. Nothing here
// depends on the district application; its template, quiz and rubric fields mirror the district
// API's inputs, and the seeder's type check is what holds them to it.

/** The four grade bands the showcase covers, as the catalog's vocabulary names them. */
export type ShowcaseBand = "K-2" | "3-5" | "6-8" | "9-12";

/** Every showcase band, youngest first. */
export const SHOWCASE_BANDS: readonly ShowcaseBand[] = ["K-2", "3-5", "6-8", "9-12"];

/** The built-in standards frameworks the showcase aligns to. NGSS is not built in, so science is unaligned. */
export type ShowcaseFramework = "ccss-math" | "ccss-ela" | "c3";

/** A learning goal by its publisher code, such as `K.CC.B.5`, in a framework the seeder approves. */
export interface ShowcaseStandard {
  framework: ShowcaseFramework;
  code: string;
}

/**
 * A short synthetic reading a teacher imports into their class through Content Studio. `path` is
 * where a host serves it; the seeder imports it only when given a URL for it.
 */
export interface ShowcaseResource {
  key: string;
  title: string;
  path: string;
  /** The reading's text, as paragraphs of plain text. */
  paragraphs: readonly string[];
}

/** One rubric level, lowest first. */
export interface ShowcaseRubricLevel {
  id: string;
  label: string;
  points: number;
}

/** A rubric the teacher signs for one activity. Its ID is unique across the showcase. */
export interface ShowcaseRubric {
  rubricId: string;
  title: string;
  criteria: readonly { id: string; title: string; levels: readonly ShowcaseRubricLevel[] }[];
}

/**
 * Where one student is on one activity:
 * - `not-started`: nothing yet.
 * - `draft`: work saved in their class workspace, not submitted.
 * - `submitted`: submitted, waiting for the teacher.
 * - `graded`: the teacher has scored it against the rubric and commented, but not released it.
 * - `released`: scored, commented, graded officially and released to the student (and family).
 */
export type ShowcaseWork =
  | { stage: "not-started" }
  | { stage: "draft" | "submitted"; text: string }
  | { stage: "graded" | "released"; text: string; scores: Readonly<Record<string, number>>; comment: string };

/** The stages of {@link ShowcaseWork}, in the order work moves through them. */
export const SHOWCASE_STAGES = ["not-started", "draft", "submitted", "graded", "released"] as const;

interface ActivityBase {
  /** Unique within its course; module items refer to it. */
  key: string;
  title: string;
  overview: string;
  standards: readonly ShowcaseStandard[];
  aiHelp: "none" | "hints-only" | "full";
  /** Due this many days after the seeder installs it. */
  dueInDays: number;
  rubric: ShowcaseRubric;
  /** Keys of {@link ShowcaseResource}s the activity uses. */
  resources?: readonly string[];
  /** Each enrolled student's work, by principal ID. A student left out has not started. */
  work: Readonly<Record<string, ShowcaseWork>>;
}

/** An activity, in the inputs of one of the district's activity templates. */
export type ShowcaseActivity = ActivityBase & (
  | { template: "writing-task"; prompt: string; genre: "argument" | "informative" | "narrative" | "literary-analysis"; minWords?: number; minimumCitations: number }
  | { template: "science-investigation"; question: string; methodPrompt: string; dataColumns: readonly { name: string; unit?: string }[]; analysisPrompt: string }
  | { template: "primary-source-analysis"; sourcingQuestions: readonly string[]; contextualizationQuestions: readonly string[]; claimPrompt: string; minimumEvidence: number }
  | { template: "problem-set"; problems: readonly { prompt: string; answer?: string }[]; showWork: boolean }
);

/** A quiz item, as the district's quiz API takes one (without an ID). */
export type ShowcaseQuizItem =
  | { type: "multiple-choice"; prompt: string; points: number; choices: readonly { id: string; text: string }[]; correctChoiceId: string; feedback?: string }
  | { type: "multiple-select"; prompt: string; points: number; choices: readonly { id: string; text: string }[]; correctChoiceIds: readonly string[]; scoring: "all-or-nothing" | "partial"; feedback?: string }
  | { type: "true-false"; prompt: string; points: number; correct: boolean; feedback?: string }
  | { type: "numeric"; prompt: string; points: number; answer: number; tolerance: number; feedback?: string }
  | { type: "short-answer"; prompt: string; points: number; acceptedAnswers: readonly string[]; feedback?: string }
  | { type: "essay"; prompt: string; points: number; feedback?: string };

/** A student's answer to one quiz item, by the item's type. */
export type ShowcaseQuizAnswer =
  | { type: "multiple-choice"; choiceId: string }
  | { type: "multiple-select"; choiceIds: readonly string[] }
  | { type: "true-false"; value: boolean }
  | { type: "numeric"; value: number }
  | { type: "short-answer"; text: string }
  | { type: "essay"; text: string; /** The teacher's grade for it. */ points: number };

/** A quiz, placed in one of its course's modules. */
export interface ShowcaseQuiz {
  key: string;
  title: string;
  description: string;
  items: readonly ShowcaseQuizItem[];
  /** Each student who took it: their answers in item order. A student left out has not taken it. */
  attempts: Readonly<Record<string, readonly ShowcaseQuizAnswer[]>>;
  /** Whether the teacher has released its scores, which makes them official grades. */
  releaseScores: boolean;
}

/** A discussion topic and its posts, in order. A post may reply to an earlier one. */
export interface ShowcaseDiscussion {
  key: string;
  title: string;
  prompt: string;
  posts: readonly { author: string; body: string; replyTo?: number }[];
}

/** A course module: an intro page, then items of the course by key, in order. */
export interface ShowcaseModule {
  title: string;
  page: { title: string; body: string };
  items: readonly { kind: "activity" | "quiz" | "discussion"; key: string }[];
}

/** One class's showcase content. */
export interface ShowcaseCourse {
  offeringId: string;
  band: ShowcaseBand;
  /** The class's teacher, who authors everything in it. */
  teacherId: string;
  modules: readonly [ShowcaseModule, ShowcaseModule];
  activities: readonly ShowcaseActivity[];
  quizzes: readonly ShowcaseQuiz[];
  discussions: readonly ShowcaseDiscussion[];
  announcements: readonly { title: string; body: string }[];
  /** This week's note to families. */
  weeklyNote: string;
}

/** A district's showcase: its classes' content and the readings they import. */
export interface Showcase {
  districtId: string;
  courses: readonly ShowcaseCourse[];
  resources: readonly ShowcaseResource[];
}
