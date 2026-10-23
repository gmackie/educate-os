// An offering's quizzes (SCHO-191). Every call is decided by the district's policy engine on a
// `quiz` or a `quiz-attempt` at the offering. A quiz's full definition is `teacher-only`; what a
// student reads of a published quiz in a published module is `course`, and is built only from the
// key-free `Student…` schemas. An attempt is a `course` record its student owns.
//
// The owner's decision: the server scores every item but essays the moment an attempt is
// submitted, and the score stays a proposal until a teacher releases the quiz's scores, as one
// action, through the official-grade gate (`QuizGrading.recordGrades`). Essays are graded by a
// teacher, item by item. AI never scores an item. Time is the server's: an attempt's deadline is
// fixed when it starts, and nothing is saved or submitted after it.
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
  ItemGradeInput,
  NewQuiz,
  Quiz,
  QuizAnswer,
  QuizPatch,
  StudentAttemptResult,
  StudentAttemptView,
  StudentQuizView,
  type ItemAnalysis,
  type QuizAttempt,
  type QuizAvailability,
  type QuizBook,
  type QuizItem,
  type QuizItemDraft,
  type QuizListing,
  type QuizRelease,
  type QuizResponse,
  type QuizResults,
  type QuizSource,
  type ReleasedGrade,
  type ReleaseOutcome,
  type StaffAttemptView,
  type StudentAttemptSummary,
  type StudentItemResult,
  type StudentQuestion,
  type StudentResultRow,
} from "./model.ts";
import { correctResponse, scoreAttempt, seededShuffle, totalOf } from "./scoring.ts";
import { emptyQuizBook, type QuizBookWrite, type QuizStorage } from "./storage.ts";

type OfferingScope = Extract<Scope, { level: "offering" }>;

/** An assignment a quiz may be bound to, as the quiz service needs it. */
export interface QuizAssignment {
  id: string;
  title: string;
  /** When the assignment stops accepting work, if it ever does. No attempt runs past it. */
  closesAt?: string;
}

/** A finished attempt's answers, written out to be submitted as the student's work. */
export interface AnswerSheet {
  offeringId: OfferingId;
  quizId: string;
  attemptId: string;
  /** A title naming the quiz and the attempt. */
  title: string;
  /** The questions and the student's answers, as Markdown. Never a key. */
  text: string;
}

/** One score to record as an official grade. */
export interface GradeToRecord {
  submissionId: string;
  points: number;
  maxPoints: number;
}

/** What recording one grade did. */
export type RecordedGrade = { status: "official"; version: number } | { status: "pending-approval" };

/**
 * The assessment records a quiz's attempts and scores become (`@schoolos/assessment`, through the
 * district app). A quiz never makes a grade official itself: it hands each submitted attempt over
 * as a submission and each released score to the official-grade gate, which decides it.
 */
export interface QuizGrading {
  /** The offering's assignment `assignmentId`, if it is one of the offering's. A fact about the class, not a decision for anyone. */
  assignment(offeringId: OfferingId, assignmentId: string): Promise<QuizAssignment | undefined>;
  /**
   * Readies the assignment to take a published quiz's attempts as submissions (at least
   * `attemptsAllowed` of them), acting as `subject`, the staff member publishing the quiz.
   */
  prepareAssignment(subject: VerifiedPrincipal, assignmentId: string, attemptsAllowed: number): Promise<void>;
  /**
   * Submits a finished attempt's answer sheet as `subject`'s own submission to the assignment, and
   * returns its ID. Submitting the same attempt's sheet again returns the same submission.
   */
  submitAnswerSheet(subject: VerifiedPrincipal, assignmentId: string, sheet: AnswerSheet): Promise<string>;
  /** Records `grades` as official grades, as one action decided for `subject`: all of them, or none. */
  recordGrades(subject: VerifiedPrincipal, grades: readonly GradeToRecord[]): Promise<readonly RecordedGrade[]>;
}

/** Everything a quiz service needs. Each district runs its own. */
export interface QuizServiceOptions {
  districtId: DistrictId;
  /** The district directory, for offerings, their terms, and principals' kinds. */
  directory: DistrictDirectorySnapshot;
  /** Decides every call: the district's `PolicyEngine`, with its quiz rules. */
  authorizer: Authorizer;
  channel?: RequestChannel;
  storage: QuizStorage;
  /** The offering's course content, so a quiz sits only in one of its modules and follows its publication. */
  courseContent: Pick<CourseContentStorage, "load">;
  grading: QuizGrading;
  /** The current time as an ISO 8601 timestamp. Every deadline is decided on it. */
  now?: () => string;
}

/** A quiz imported from elsewhere, such as a QTI assessment in a Common Cartridge. */
export interface ImportedQuiz {
  moduleId?: string;
  title: string;
  description?: string;
  items: readonly QuizItemDraft[];
  source: QuizSource;
}

/** Who is reading: the offering's staff, an administrator overseeing it, or one of its students. */
type Viewer = "staff" | "oversight" | "student";

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new SchoolOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

const NOT_FOUND = () => new SchoolOsError("not-found", "no such quiz");
const randomBody = () => crypto.randomUUID().replaceAll("-", "");
const newId = <P extends string>(prefix: P) => `${prefix}_${randomBody()}` as const;
/** Commit attempts before a change gives up on concurrent writes (autosaves) and reports the conflict. */
const COMMIT_ATTEMPTS = 6;

/** The answers to save or submit. */
const AnswersInput = z.strictObject({ answers: z.array(QuizAnswer).max(500) });

/**
 * One district's quizzes (SCHO-191): staff build them from items, bind each to an assignment, place
 * it in a module and publish it; students take timed, attempt-limited attempts during its window;
 * the server scores them and teachers grade essays, then release the scores as official grades in
 * one action. A completed term's quizzes are read-only.
 */
export class QuizService {
  readonly #options: QuizServiceOptions;
  readonly #now: () => string;

  constructor(options: QuizServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  // Listing and reading

  /**
   * The offering's quizzes the subject may see: every quiz with its counts for staff (and, without
   * managing them, administrators); published, placed quizzes as key-free views for students.
   *
   * @throws SchoolOsError `not-found` if the subject may see none of its quizzes.
   */
  async listQuizzes(subject: VerifiedPrincipal, offeringId: unknown): Promise<QuizListing> {
    const scope = this.#scope(offeringId);
    const viewer = await this.#viewer(subject, scope);
    const book = await this.#load(scope.offeringId);
    if (viewer !== "student") {
      const canManage = viewer === "staff" && (await this.#allowed(subject, "update", scope, "quiz", "teacher-only"));
      return {
        view: "staff",
        canManage,
        quizzes: book.quizzes.map((quiz) => {
          const submitted = book.attempts.filter((a) => a.quizId === quiz.id && a.status === "submitted");
          return {
            quiz,
            started: book.attempts.filter((a) => a.quizId === quiz.id).length,
            submitted: submitted.length,
            needsGrading: submitted.filter((a) => totalOf(a.itemScores ?? []).points === null).length,
            ...this.#lastRelease(book, quiz.id),
          };
        }),
      };
    }
    const outline = await this.#options.courseContent.load(scope.offeringId);
    const quizzes: StudentQuizView[] = [];
    for (const quiz of book.quizzes) {
      if (this.#classification(quiz, outline) === "course") quizzes.push(await this.#studentQuizView(subject, scope, book, quiz));
    }
    return { view: "student", quizzes };
  }

  /** A quiz whole, answer keys included, for its staff and administrators over it. */
  async getQuiz(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<Quiz> {
    const scope = this.#scope(offeringId);
    if ((await this.#viewer(subject, scope)) === "student") throw NOT_FOUND();
    return this.#quiz(await this.#load(scope.offeringId), quizId);
  }

  /** A published quiz as a student sees it before and between attempts. */
  async studentQuiz(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<StudentQuizView> {
    const scope = this.#scope(offeringId);
    const book = await this.#load(scope.offeringId);
    const quiz = await this.#studentReadable(subject, scope, book, quizId);
    return this.#studentQuizView(subject, scope, book, quiz);
  }

  // Building

  /** Builds a quiz. Its items are given IDs; a bound one names one of the offering's assignments, a placed one one of its modules. */
  async createQuiz(subject: VerifiedPrincipal, offeringId: unknown, input: unknown): Promise<Quiz> {
    const parsed = parseInput(NewQuiz, input);
    const scope = this.#scope(offeringId);
    const at = this.#now();
    const quiz = parseInput(Quiz, {
      id: newId("qz"),
      offeringId: scope.offeringId,
      title: parsed.title,
      description: parsed.description,
      ...(parsed.moduleId === undefined ? {} : { moduleId: parsed.moduleId }),
      ...(parsed.assignmentId === undefined ? {} : { assignmentId: parsed.assignmentId }),
      items: withItemIds(parsed.items),
      settings: parsed.settings,
      status: "draft",
      createdBy: subject.principalId,
      createdAt: at,
      updatedAt: at,
    });
    return (await this.#addQuizzes(subject, scope, [quiz]))[0]!;
  }

  /**
   * Imports quizzes, such as a cartridge's QTI assessments, into the offering as drafts. Each is
   * checked as if a teacher had built it; one that fails refuses the whole import.
   */
  async importQuizzes(subject: VerifiedPrincipal, offeringId: unknown, quizzes: readonly ImportedQuiz[]): Promise<Quiz[]> {
    const scope = this.#scope(offeringId);
    const at = this.#now();
    const parsed = quizzes.map((imported) => parseInput(Quiz, {
      id: newId("qz"),
      offeringId: scope.offeringId,
      title: imported.title,
      description: imported.description ?? "",
      ...(imported.moduleId === undefined ? {} : { moduleId: imported.moduleId }),
      items: withItemIds(imported.items),
      settings: { attemptsAllowed: 1, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" },
      status: "draft",
      source: imported.source,
      createdBy: subject.principalId,
      createdAt: at,
      updatedAt: at,
    }));
    return parsed.length === 0 ? [] : this.#addQuizzes(subject, scope, parsed);
  }

  /**
   * Changes a quiz: its text, module, assignment, settings or items. Items are replaced whole, and
   * only until a student has started the quiz; settings may change at any time.
   *
   * @throws SchoolOsError `conflict` for item changes once a student has started it, and
   *   `validation-failed` for unbinding a published quiz from its assignment.
   */
  async updateQuiz(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown, input: unknown): Promise<Quiz> {
    const patch = parseInput(QuizPatch, input);
    const scope = this.#scope(offeringId);
    await this.#requireManage(subject, scope, "update");
    const before = await this.#load(scope.offeringId);
    const current = this.#quiz(before, quizId);
    // An assignment a published quiz moves to must take its attempts before the change is stored.
    const next = this.#patched(current, patch);
    if (next.status === "published" && (next.assignmentId !== current.assignmentId || next.settings.attemptsAllowed > current.settings.attemptsAllowed)) {
      await this.#checkPlacement(scope, next, undefined, true);
      await this.#options.grading.prepareAssignment(subject, next.assignmentId!, next.settings.attemptsAllowed);
    }
    return this.#change(scope, async (book, outline) => {
      const quiz = this.#quiz(book, quizId);
      if (patch.items !== undefined && book.attempts.some((a) => a.quizId === quiz.id)) {
        throw new SchoolOsError("conflict", "Students have started this quiz, so its questions can no longer change.");
      }
      const updated = this.#patched(quiz, patch);
      await this.#checkPlacement(scope, updated, outline, updated.status === "published");
      return { write: { quizzes: [updated] }, result: updated };
    });
  }

  /**
   * Publishes a quiz to its class, or takes it back to a draft. Publishing needs an assignment to
   * release its scores to and at least one item; the assignment is readied to take its attempts.
   */
  async setPublished(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown, input: unknown): Promise<Quiz> {
    const { published } = parseInput(z.strictObject({ published: z.boolean() }), input);
    const scope = this.#scope(offeringId);
    await this.#requireManage(subject, scope, "publish");
    const before = await this.#load(scope.offeringId);
    const current = this.#quiz(before, quizId);
    if (published) {
      if (current.items.length === 0) throw new SchoolOsError("validation-failed", "A quiz needs at least one question before it is published.");
      await this.#checkPlacement(scope, current, undefined, true);
      await this.#options.grading.prepareAssignment(subject, current.assignmentId!, current.settings.attemptsAllowed);
    }
    return this.#change(scope, async (book) => {
      const quiz = this.#quiz(book, quizId);
      const updated: Quiz = { ...quiz, status: published ? "published" : "draft", updatedAt: this.#now() };
      return { write: { quizzes: [updated] }, result: updated };
    });
  }

  /** Deletes a quiz no student has started. */
  async deleteQuiz(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<void> {
    const scope = this.#scope(offeringId);
    await this.#requireManage(subject, scope, "delete");
    await this.#change(scope, async (book) => {
      const quiz = this.#quiz(book, quizId);
      if (book.attempts.some((a) => a.quizId === quiz.id)) throw new SchoolOsError("conflict", "Students have started this quiz, so it can't be deleted; unpublish it instead.");
      return { write: { deletedQuizIds: [quiz.id] }, result: undefined };
    });
  }

  // Taking

  /**
   * Starts an attempt, or resumes the student's attempt in progress. Its deadline is fixed now, on
   * the server's clock: its start plus the time limit, or the quiz's (or its assignment's) close,
   * whichever is earlier.
   *
   * @throws SchoolOsError `forbidden` before the quiz opens, after it closes, and once every
   *   attempt is used (an attempt whose time ran out counts).
   */
  async startAttempt(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<StudentAttemptView> {
    const scope = this.#scope(offeringId);
    const before = await this.#load(scope.offeringId);
    const quiz = await this.#studentReadable(subject, scope, before, quizId);
    await this.#require(subject, "create", scope, "quiz-attempt", subject.principalId, "You can't take this quiz.");
    const assignment = quiz.assignmentId === undefined ? undefined : await this.#options.grading.assignment(scope.offeringId, quiz.assignmentId);
    return this.#change(scope, async (book) => {
      const now = this.#now();
      const latest = this.#quiz(book, quiz.id);
      const mine = book.attempts.filter((a) => a.quizId === latest.id && a.studentId === subject.principalId);
      const live = mine.find((a) => attemptStatus(a, now) === "in-progress");
      if (live !== undefined) return { result: this.#attemptView(latest, live, now) };
      const availability = availabilityOf(latest, assignment, now);
      if (availability === "upcoming") throw new SchoolOsError("forbidden", "This quiz is not open yet.");
      if (availability === "closed") throw new SchoolOsError("forbidden", "This quiz is closed.");
      if (mine.length >= latest.settings.attemptsAllowed) throw new SchoolOsError("forbidden", "You have used every attempt this quiz allows.");
      const deadline = earliest([
        latest.settings.timeLimitMinutes === undefined ? undefined : new Date(Date.parse(now) + latest.settings.timeLimitMinutes * 60_000).toISOString(),
        latest.settings.availableUntil,
        assignment?.closesAt,
      ]);
      const attempt: QuizAttempt = {
        id: newId("qza"),
        quizId: latest.id,
        offeringId: scope.offeringId,
        studentId: subject.principalId,
        number: mine.length + 1,
        seed: randomBody(),
        startedAt: now,
        ...(deadline === undefined ? {} : { deadline }),
        answers: [],
        status: "in-progress",
      };
      return { write: { attempts: [attempt] }, result: this.#attemptView(latest, attempt, now) };
    });
  }

  /** The student's attempt in progress, to resume it: questions in its order, their saved answers, and the time. */
  async attempt(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown): Promise<StudentAttemptView> {
    const scope = this.#scope(offeringId);
    const book = await this.#load(scope.offeringId);
    const attempt = await this.#ownAttempt(subject, scope, book, attemptId, "read");
    const quiz = await this.#studentReadable(subject, scope, book, attempt.quizId);
    const now = this.#now();
    if (attemptStatus(attempt, now) !== "in-progress") throw new SchoolOsError("conflict", "This attempt is over.");
    return this.#attemptView(quiz, attempt, now);
  }

  /**
   * Saves answers to the student's attempt in progress, each replacing any earlier answer to the
   * same item.
   *
   * @throws SchoolOsError `forbidden` once the attempt's deadline has passed.
   */
  async saveAnswers(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown, input: unknown): Promise<{ savedAt: string; deadline?: string; serverNow: string }> {
    const { answers } = parseInput(AnswersInput, input);
    const scope = this.#scope(offeringId);
    return this.#change(scope, async (book) => {
      const attempt = await this.#ownAttempt(subject, scope, book, attemptId, "update");
      // A quiz its teacher took back (or whose module they unpublished) takes no more answers.
      const quiz = await this.#studentReadable(subject, scope, book, attempt.quizId);
      const now = this.#now();
      this.#assertOpen(attempt, now);
      const saved: QuizAttempt = { ...attempt, answers: mergeAnswers(quiz, attempt.answers, answers), savedAt: now };
      return { write: { attempts: [saved] }, result: { savedAt: now, ...(attempt.deadline === undefined ? {} : { deadline: attempt.deadline }), serverNow: now } };
    });
  }

  /**
   * Submits the student's attempt, with any last answers. Its answer sheet becomes their submission
   * to the quiz's assignment, and every item but essays is scored at once. The score is not a
   * grade: it stays a proposal until a teacher releases the quiz's scores.
   *
   * @throws SchoolOsError `forbidden` once the attempt's deadline has passed: a late submission is refused.
   */
  async submitAttempt(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown, input: unknown = { answers: [] }): Promise<StudentAttemptResult> {
    const { answers } = parseInput(AnswersInput, input);
    const scope = this.#scope(offeringId);
    const book = await this.#load(scope.offeringId);
    const attempt = await this.#ownAttempt(subject, scope, book, attemptId, "submit");
    const quiz = this.#quiz(book, attempt.quizId);
    if (attempt.status === "submitted") return this.#result(book, quiz, attempt);
    await this.#studentReadable(subject, scope, book, quiz.id);
    this.#assertOpen(attempt, this.#now());
    if (quiz.assignmentId === undefined) throw new SchoolOsError("conflict", "This quiz is not set up to take submissions.");
    const final = mergeAnswers(quiz, attempt.answers, answers);
    const submissionId = await this.#options.grading.submitAnswerSheet(subject, quiz.assignmentId, answerSheet(quiz, attempt, final));
    return this.#change(scope, async (latest) => {
      const current = latest.attempts.find((a) => a.id === attempt.id)!;
      if (current.status === "submitted") return { result: this.#result(latest, quiz, current) };
      const submittedAt = this.#now();
      const submitted: QuizAttempt = { ...current, answers: final, status: "submitted", submittedAt, submissionId, itemScores: scoreAttempt(quiz.items, final) };
      return { write: { attempts: [submitted] }, result: this.#result({ ...latest, attempts: latest.attempts.map((a) => (a.id === submitted.id ? submitted : a)) }, quiz, submitted) };
    });
  }

  /**
   * One of the student's own finished attempts as they may see it: their answers, and the key,
   * points and feedback only when the quiz shows them. Readable even after leaving the offering.
   */
  async attemptResult(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown): Promise<StudentAttemptResult> {
    const scope = this.#scope(offeringId);
    const book = await this.#load(scope.offeringId);
    const attempt = await this.#ownAttempt(subject, scope, book, attemptId, "read");
    if (attemptStatus(attempt, this.#now()) === "in-progress") throw new SchoolOsError("conflict", "This attempt is still in progress.");
    return this.#result(book, this.#quiz(book, attempt.quizId), attempt);
  }

  // Grading and release

  /** A quiz's results for its staff: each student's attempts and score, how each item fared, and the releases. */
  async results(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<QuizResults> {
    const scope = this.#scope(offeringId);
    if ((await this.#viewer(subject, scope)) !== "staff") throw NOT_FOUND();
    const book = await this.#load(scope.offeringId);
    const quiz = this.#quiz(book, quizId);
    const now = this.#now();
    const students = this.#rows(book, quiz, now);
    return {
      quiz,
      students,
      items: itemAnalysis(quiz, book.attempts.filter((a) => a.quizId === quiz.id && a.status === "submitted")),
      releases: book.releases.filter((r) => r.quizId === quiz.id),
      releasable: students.filter((row) => row.score !== undefined && row.released?.current !== true).length,
    };
  }

  /** A student's attempt whole, with the quiz's keys, for the staff grading it. */
  async staffAttempt(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown): Promise<StaffAttemptView> {
    const scope = this.#scope(offeringId);
    const book = await this.#load(scope.offeringId);
    const attempt = book.attempts.find((a) => a.id === attemptId);
    if (attempt === undefined || !(await this.#allowed(subject, "read", scope, "quiz-attempt", "course", attempt.studentId)) || attempt.studentId === subject.principalId) throw NOT_FOUND();
    return { quiz: this.#quiz(book, attempt.quizId), attempt };
  }

  /**
   * A teacher's grade for one item of a submitted attempt: an essay's points, or a rescore of any
   * item, with an optional comment. A released score that changes is released again by the next
   * release, as a new official version.
   */
  async gradeItem(subject: VerifiedPrincipal, offeringId: unknown, attemptId: unknown, itemId: unknown, input: unknown): Promise<StaffAttemptView> {
    const { points, comment } = parseInput(ItemGradeInput, input);
    const scope = this.#scope(offeringId);
    return this.#change(scope, async (book) => {
      const attempt = book.attempts.find((a) => a.id === attemptId);
      if (attempt === undefined) throw NOT_FOUND();
      await this.#require(subject, "review", scope, "quiz-attempt", attempt.studentId, "Only the class's teachers can grade its quizzes.");
      if (attempt.status !== "submitted" || attempt.itemScores === undefined) throw new SchoolOsError("conflict", "Only a submitted attempt can be graded.");
      const index = attempt.itemScores.findIndex((s) => s.itemId === itemId);
      if (index < 0) throw new SchoolOsError("not-found", "no such question in this attempt");
      const before = attempt.itemScores[index]!;
      if (points > before.maxPoints) throw new SchoolOsError("validation-failed", `This question is worth at most ${before.maxPoints} points.`);
      const graded = { ...before, points, source: "teacher" as const, gradedBy: subject.principalId, gradedAt: this.#now(), ...(comment === undefined || comment.trim() === "" ? {} : { comment }) };
      if (comment !== undefined && comment.trim() === "") delete graded.comment;
      const updated: QuizAttempt = { ...attempt, itemScores: attempt.itemScores.map((s, i) => (i === index ? graded : s)) };
      return { write: { attempts: [updated] }, result: { quiz: this.#quiz(book, attempt.quizId), attempt: updated } };
    });
  }

  /**
   * Releases the quiz's scores as official grades, in one action: for each student whose attempts
   * are fully graded, the score its score policy picks, unless that score is already released.
   * Students with an essay still waiting are left for a later release. The official-grade gate
   * decides each grade: the class's teacher makes it official at once; anyone else's release waits
   * for that teacher's approval. A rescored attempt is released again as a new official version.
   */
  async release(subject: VerifiedPrincipal, offeringId: unknown, quizId: unknown): Promise<ReleaseOutcome> {
    const scope = this.#scope(offeringId);
    await this.#requireManage(subject, scope, "grade", "Only the class's teachers can release its quiz scores.");
    const book = await this.#load(scope.offeringId);
    const quiz = this.#quiz(book, quizId);
    const rows = this.#rows(book, quiz, this.#now());
    const due = rows.filter((row) => row.score !== undefined && row.released?.current !== true);
    const counts = {
      unchanged: rows.filter((row) => row.released?.current === true).length,
      waitingForGrading: rows.filter((row) => row.needsGrading).length,
    };
    if (due.length === 0) return { official: 0, pendingApproval: 0, ...counts };
    const graded = due.map((row) => {
      const attempt = book.attempts.find((a) => a.id === row.gradedAttemptId)!;
      return { row, attempt, grade: { submissionId: attempt.submissionId!, points: row.score!.points, maxPoints: row.score!.maxPoints } };
    });
    const recorded = await this.#options.grading.recordGrades(subject, graded.map((g) => g.grade));
    const release: QuizRelease = {
      id: newId("qzr"),
      quizId: quiz.id,
      by: subject.principalId,
      at: this.#now(),
      grades: graded.map(({ row, attempt, grade }, i): ReleasedGrade => {
        const outcome = recorded[i]!;
        return {
          studentId: row.studentId,
          attemptId: attempt.id,
          ...grade,
          outcome: outcome.status,
          ...(outcome.status === "official" ? { version: outcome.version } : {}),
        };
      }),
    };
    await this.#change(scope, async () => ({ write: { releases: [release] }, result: undefined }));
    return {
      release,
      official: release.grades.filter((g) => g.outcome === "official").length,
      pendingApproval: release.grades.filter((g) => g.outcome === "pending-approval").length,
      ...counts,
    };
  }

  // Internals: views

  async #studentQuizView(subject: VerifiedPrincipal, scope: OfferingScope, book: QuizBook, quiz: Quiz): Promise<StudentQuizView> {
    const now = this.#now();
    const assignment = quiz.assignmentId === undefined ? undefined : await this.#options.grading.assignment(scope.offeringId, quiz.assignmentId);
    const availability = availabilityOf(quiz, assignment, now);
    const mine = book.attempts.filter((a) => a.quizId === quiz.id && a.studentId === subject.principalId);
    const attempts = mine.map((a): StudentAttemptSummary => ({
      id: a.id,
      number: a.number,
      status: attemptStatus(a, now),
      startedAt: a.startedAt,
      ...(a.deadline === undefined ? {} : { deadline: a.deadline }),
      ...(a.submittedAt === undefined ? {} : { submittedAt: a.submittedAt }),
    }));
    const resumable = attempts.some((a) => a.status === "in-progress");
    const canStart = (resumable || (availability === "open" && mine.length < quiz.settings.attemptsAllowed))
      && (await this.#allowed(subject, "create", scope, "quiz-attempt", "course", subject.principalId));
    const released = officialReleaseFor(book, quiz.id, subject.principalId);
    return StudentQuizView.parse({
      id: quiz.id,
      offeringId: quiz.offeringId,
      courseTitle: this.#courseTitle(quiz.offeringId),
      title: quiz.title,
      description: quiz.description,
      ...(quiz.moduleId === undefined ? {} : { moduleId: quiz.moduleId }),
      ...(quiz.assignmentId === undefined ? {} : { assignmentId: quiz.assignmentId }),
      questionCount: quiz.items.length,
      totalPoints: totalOf(quiz.items.map((i) => ({ itemId: i.id, points: 0, maxPoints: i.points, source: "auto" }))).maxPoints,
      attemptsAllowed: quiz.settings.attemptsAllowed,
      ...(quiz.settings.timeLimitMinutes === undefined ? {} : { timeLimitMinutes: quiz.settings.timeLimitMinutes }),
      ...(quiz.settings.availableFrom === undefined ? {} : { availableFrom: quiz.settings.availableFrom }),
      ...(earliest([quiz.settings.availableUntil, assignment?.closesAt]) === undefined ? {} : { availableUntil: earliest([quiz.settings.availableUntil, assignment?.closesAt]) }),
      showAnswers: quiz.settings.showAnswers,
      availability,
      attempts,
      canStart,
      ...(released === undefined ? {} : { releasedScore: { points: released.points, maxPoints: released.maxPoints } }),
    });
  }

  #attemptView(quiz: Quiz, attempt: QuizAttempt, now: string): StudentAttemptView {
    return StudentAttemptView.parse({
      attemptId: attempt.id,
      quizId: quiz.id,
      title: quiz.title,
      number: attempt.number,
      questions: questionsFor(quiz, attempt),
      answers: attempt.answers,
      startedAt: attempt.startedAt,
      ...(attempt.deadline === undefined ? {} : { deadline: attempt.deadline }),
      ...(attempt.savedAt === undefined ? {} : { savedAt: attempt.savedAt }),
      serverNow: now,
    });
  }

  #result(book: QuizBook, quiz: Quiz, attempt: QuizAttempt): StudentAttemptResult {
    const released = officialReleaseFor(book, quiz.id, attempt.studentId);
    const status = attemptStatus(attempt, this.#now());
    const shown = status === "submitted" && (quiz.settings.showAnswers === "after-submit" || (quiz.settings.showAnswers === "after-release" && released !== undefined));
    const responses = new Map(attempt.answers.map((a) => [a.itemId, a.response]));
    const scores = new Map((attempt.itemScores ?? []).map((s) => [s.itemId, s]));
    const questions = new Map(questionsFor(quiz, attempt).map((q) => [q.id, q]));
    const items = questionsFor(quiz, attempt).map((question): StudentItemResult => {
      const item = quiz.items.find((i) => i.id === question.id)!;
      const response = responses.get(item.id);
      const base: StudentItemResult = { question: questions.get(item.id)!, ...(response === undefined ? {} : { response }) };
      if (!shown) return base;
      const score = scores.get(item.id);
      const key = correctResponse(item);
      return {
        ...base,
        points: score?.points ?? null,
        ...(score?.points === null || score === undefined ? {} : { correct: score.points >= score.maxPoints }),
        ...(key === undefined ? {} : { correctResponse: key }),
        ...(item.type === "short-answer" && item.acceptedAnswers.length > 1 ? { acceptedAnswers: item.acceptedAnswers } : {}),
        ...(item.feedback === undefined || item.feedback === "" ? {} : { feedback: item.feedback }),
        ...(score?.comment === undefined ? {} : { comment: score.comment }),
      };
    });
    return StudentAttemptResult.parse({
      attemptId: attempt.id,
      quizId: quiz.id,
      courseTitle: this.#courseTitle(quiz.offeringId),
      title: quiz.title,
      number: attempt.number,
      status: status === "in-progress" ? "submitted" : status,
      ...(attempt.submittedAt === undefined ? {} : { submittedAt: attempt.submittedAt }),
      answersShown: shown,
      released: released !== undefined,
      ...(released === undefined ? {} : { releasedScore: { points: released.points, maxPoints: released.maxPoints } }),
      items,
    });
  }

  /** Each student's row in a quiz's results, in the order they first started it. */
  #rows(book: QuizBook, quiz: Quiz, now: string): StudentResultRow[] {
    const attempts = book.attempts.filter((a) => a.quizId === quiz.id);
    const students = [...new Set(attempts.map((a) => a.studentId))];
    const maxPoints = totalOf(quiz.items.map((i) => ({ itemId: i.id, points: 0, maxPoints: i.points, source: "auto" }))).maxPoints;
    return students.map((studentId): StudentResultRow => {
      const mine = attempts.filter((a) => a.studentId === studentId).toSorted((a, b) => a.number - b.number);
      const submitted = mine.filter((a) => a.status === "submitted");
      const totals = new Map(submitted.map((a) => [a.id, totalOf(a.itemScores ?? [])]));
      const needsGrading = submitted.some((a) => totals.get(a.id)!.points === null);
      let picked: QuizAttempt | undefined;
      if (!needsGrading && submitted.length > 0) {
        picked = quiz.settings.scorePolicy === "latest"
          ? submitted.at(-1)
          : submitted.reduce((best, a) => (totals.get(a.id)!.points! > totals.get(best.id)!.points! ? a : best));
      }
      const score = picked === undefined ? undefined : { points: totals.get(picked.id)!.points!, maxPoints: totals.get(picked.id)!.maxPoints };
      const last = lastReleasedFor(book, quiz.id, studentId);
      return {
        studentId,
        attempts: mine.map((a) => ({
          id: a.id,
          number: a.number,
          status: attemptStatus(a, now),
          ...(a.submittedAt === undefined ? {} : { submittedAt: a.submittedAt }),
          ...(a.status === "submitted" ? { points: totals.get(a.id)!.points } : {}),
          maxPoints: a.itemScores === undefined ? maxPoints : totals.get(a.id)!.maxPoints,
        })),
        ...(picked === undefined ? {} : { gradedAttemptId: picked.id }),
        ...(score === undefined ? {} : { score }),
        needsGrading,
        ...(last === undefined ? {} : {
          released: {
            points: last.grade.points,
            maxPoints: last.grade.maxPoints,
            outcome: last.grade.outcome,
            at: last.at,
            // A grade waiting for approval is sent again by the next release, so a declined one is not lost.
            current: last.grade.outcome === "official" && picked?.id === last.grade.attemptId && score?.points === last.grade.points && score.maxPoints === last.grade.maxPoints,
          },
        }),
      };
    });
  }

  /** The title of the course an offering is a section of, from the directory. */
  #courseTitle(offeringId: string): string {
    const { offerings, courses } = this.#options.directory;
    const courseId = offerings.find((o) => o.id === offeringId)?.courseId;
    return courses.find((c) => c.id === courseId)?.title ?? "";
  }

  #lastRelease(book: QuizBook, quizId: string): { lastReleasedAt?: string } {
    const last = book.releases.filter((r) => r.quizId === quizId).at(-1);
    return last === undefined ? {} : { lastReleasedAt: last.at };
  }

  // Internals: checks

  #patched(quiz: Quiz, patch: z.output<typeof QuizPatch>): Quiz {
    const { moduleId, assignmentId, items, ...rest } = patch;
    const next = parseInput(Quiz, {
      ...quiz,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
      ...(moduleId === undefined || moduleId === null ? {} : { moduleId }),
      ...(assignmentId === undefined || assignmentId === null ? {} : { assignmentId }),
      ...(items === undefined ? {} : { items: withItemIds(items) }),
      updatedAt: this.#now(),
    });
    if (moduleId === null) delete next.moduleId;
    if (assignmentId === null) delete next.assignmentId;
    return next;
  }

  async #addQuizzes(subject: VerifiedPrincipal, scope: OfferingScope, quizzes: Quiz[]): Promise<Quiz[]> {
    await this.#requireManage(subject, scope, "create");
    return this.#change(scope, async (_book, outline) => {
      for (const quiz of quizzes) await this.#checkPlacement(scope, quiz, outline, false);
      return { write: { quizzes }, result: quizzes };
    });
  }

  /**
   * A quiz's module must be one of the offering's, and its assignment one of the offering's; a
   * published quiz must have an assignment.
   */
  async #checkPlacement(scope: OfferingScope, quiz: Quiz, outline: CourseOutline | undefined, published: boolean): Promise<void> {
    const content = outline ?? (await this.#options.courseContent.load(scope.offeringId));
    if (quiz.moduleId !== undefined && !(content?.modules ?? []).some((m) => m.id === quiz.moduleId)) {
      throw new SchoolOsError("validation-failed", "a quiz can only be placed in one of this class's modules");
    }
    if (quiz.assignmentId === undefined) {
      if (published) throw new SchoolOsError("validation-failed", "A published quiz needs an assignment its scores are released to.");
      return;
    }
    if ((await this.#options.grading.assignment(scope.offeringId, quiz.assignmentId)) === undefined) {
      throw new SchoolOsError("validation-failed", "a quiz's scores can only be released to one of this class's assignments");
    }
  }

  /** A published quiz is class material unless the module it sits in is unpublished or gone; a draft is its staff's. */
  #classification(quiz: Quiz, outline: CourseOutline | undefined): Classification {
    if (quiz.status !== "published") return "teacher-only";
    if (quiz.moduleId === undefined) return "course";
    return outline?.modules.find((m) => m.id === quiz.moduleId)?.published === true ? "course" : "teacher-only";
  }

  /** A quiz the subject may read as a student: published, placed in a published module (or none), and in their class. */
  async #studentReadable(subject: VerifiedPrincipal, scope: OfferingScope, book: QuizBook, quizId: unknown): Promise<Quiz> {
    const quiz = this.#quiz(book, quizId);
    const outline = await this.#options.courseContent.load(scope.offeringId);
    const classification = this.#classification(quiz, outline);
    if (classification !== "course" || !(await this.#allowed(subject, "read", scope, "quiz", classification))) throw NOT_FOUND();
    return quiz;
  }

  /** The subject's own attempt, which they may `action`. Another student's attempt is not found. */
  async #ownAttempt(subject: VerifiedPrincipal, scope: OfferingScope, book: QuizBook, attemptId: unknown, action: Action): Promise<QuizAttempt> {
    const attempt = book.attempts.find((a) => a.id === attemptId);
    if (attempt === undefined || attempt.studentId !== subject.principalId) throw NOT_FOUND();
    if (!(await this.#allowed(subject, action, scope, "quiz-attempt", "course", attempt.studentId))) {
      if (action !== "read" && (await this.#allowed(subject, "read", scope, "quiz-attempt", "course", attempt.studentId))) {
        throw new SchoolOsError("forbidden", "This attempt can no longer be changed.");
      }
      throw NOT_FOUND();
    }
    return attempt;
  }

  #assertOpen(attempt: QuizAttempt, now: string): void {
    if (attempt.status === "submitted") throw new SchoolOsError("conflict", "This attempt has already been submitted.");
    if (attempt.deadline !== undefined && Date.parse(now) > Date.parse(attempt.deadline)) {
      throw new SchoolOsError("forbidden", "Time is up: this attempt can no longer be changed or submitted.");
    }
  }

  #quiz(book: QuizBook, quizId: unknown): Quiz {
    const quiz = book.quizzes.find((q) => q.id === quizId);
    if (quiz === undefined) throw NOT_FOUND();
    return quiz;
  }

  // Internals: storage

  /**
   * Applies `change` to the stored book and commits it over the revision it read, retrying when a
   * concurrent write (another student's autosave) won the race. `change` may run more than once, so
   * it has no effect of its own beyond the write it returns.
   */
  async #change<T>(scope: OfferingScope, change: (book: QuizBook, outline: CourseOutline | undefined) => Promise<{ write?: Partial<Omit<QuizBookWrite, "revision">>; result: T }>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const book = await this.#load(scope.offeringId);
      const outline = await this.#options.courseContent.load(scope.offeringId);
      const { write, result } = await change(book, outline);
      if (write === undefined) return result;
      try {
        await this.#options.storage.commit(scope.offeringId, {
          revision: book.revision + 1,
          quizzes: write.quizzes ?? [],
          deletedQuizIds: write.deletedQuizIds ?? [],
          attempts: write.attempts ?? [],
          releases: write.releases ?? [],
        }, book.revision);
        return result;
      } catch (error) {
        if (!(error instanceof SchoolOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }

  async #load(offeringId: OfferingId): Promise<QuizBook> {
    return (await this.#options.storage.load(offeringId)) ?? emptyQuizBook(offeringId);
  }

  // Internals: policy

  /**
   * Who the subject is to the offering's quizzes: its staff (they read every attempt), an
   * administrator overseeing it (they read quizzes, not attempts), or one of its students.
   *
   * @throws SchoolOsError `not-found` if they may read none of it.
   */
  async #viewer(subject: VerifiedPrincipal, scope: OfferingScope): Promise<Viewer> {
    if (await this.#allowed(subject, "list", scope, "quiz-attempt", "course")) return "staff";
    if (await this.#allowed(subject, "read", scope, "quiz", "teacher-only")) return "oversight";
    if (!(await this.#allowed(subject, "read", scope, "quiz", "course"))) throw NOT_FOUND();
    const kind = this.#options.directory.principals.find((p) => p.id === subject.principalId)?.kind;
    if (kind !== "student") throw NOT_FOUND();
    return "student";
  }

  async #requireManage(subject: VerifiedPrincipal, scope: OfferingScope, action: Action, message = "Only the class's teachers can manage its quizzes."): Promise<void> {
    await this.#require(subject, action, scope, "quiz", undefined, message, "teacher-only");
  }

  #scope(offeringId: unknown): OfferingScope {
    const id = OfferingId.safeParse(offeringId);
    const offering = id.success ? this.#options.directory.offerings.find((o) => o.id === id.data) : undefined;
    if (offering === undefined || offering.districtId !== this.#options.districtId) throw NOT_FOUND();
    return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
  }

  /** Requires `action`, answering `forbidden` if the subject may read the offering's quizzes and `not-found` otherwise. */
  async #require(subject: VerifiedPrincipal, action: Action, scope: OfferingScope, kind: ResourceKind, owner: PrincipalId | undefined, message: string, classification: Classification = "course"): Promise<void> {
    if (await this.#allowed(subject, action, scope, kind, classification, owner)) return;
    if ((await this.#allowed(subject, "read", scope, "quiz", "course")) || (await this.#allowed(subject, "read", scope, "quiz", "teacher-only"))) {
      throw new SchoolOsError("forbidden", message);
    }
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

// Pure helpers

/** Items as stored: each draft keeps its ID or is given one. */
function withItemIds(items: readonly QuizItemDraft[]): QuizItem[] {
  return items.map((item) => ({ ...item, id: item.id ?? newId("qzi") }) as QuizItem);
}

/** The earliest of some timestamps, or undefined if there are none. */
function earliest(times: readonly (string | undefined)[]): string | undefined {
  const present = times.filter((t): t is string => t !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** Where an attempt is at `now`: an unsubmitted attempt past its deadline has expired. */
export function attemptStatus(attempt: QuizAttempt, now: string): "in-progress" | "submitted" | "expired" {
  if (attempt.status === "submitted") return "submitted";
  return attempt.deadline !== undefined && Date.parse(now) > Date.parse(attempt.deadline) ? "expired" : "in-progress";
}

/** Whether a quiz takes new attempts at `now`: not before it opens, nor once it or its assignment closes. */
function availabilityOf(quiz: Quiz, assignment: QuizAssignment | undefined, now: string): QuizAvailability {
  const at = Date.parse(now);
  if (quiz.settings.availableFrom !== undefined && at < Date.parse(quiz.settings.availableFrom)) return "upcoming";
  const closes = earliest([quiz.settings.availableUntil, assignment?.closesAt]);
  return closes !== undefined && at >= Date.parse(closes) ? "closed" : "open";
}

/** An attempt's questions in its own order, with no key: the only form in which items reach a student. */
function questionsFor(quiz: Quiz, attempt: QuizAttempt): StudentQuestion[] {
  const items = quiz.settings.shuffleQuestions ? seededShuffle(quiz.items, attempt.seed, "questions") : quiz.items;
  return items.map((item): StudentQuestion => {
    const question: StudentQuestion = { id: item.id, type: item.type, prompt: item.prompt, points: item.points };
    if (item.type === "multiple-choice" || item.type === "multiple-select") {
      const choices = quiz.settings.shuffleChoices ? seededShuffle(item.choices, attempt.seed, item.id) : item.choices;
      question.choices = choices.map(({ id, text }) => ({ id, text }));
    }
    if (item.type === "short-answer") question.maxLength = 200;
    if (item.type === "essay") question.maxLength = item.maxLength ?? 20_000;
    return question;
  });
}

/** `saved` with `incoming` answers replacing any to the same item. Each answer must fit its item. */
function mergeAnswers(quiz: Quiz, saved: readonly QuizAnswer[], incoming: readonly QuizAnswer[]): QuizAnswer[] {
  const merged = new Map(saved.map((a) => [a.itemId, a]));
  for (const answer of incoming) {
    const item = quiz.items.find((i) => i.id === answer.itemId);
    if (item === undefined) throw new SchoolOsError("validation-failed", "an answer names a question this quiz does not have");
    if (!fits(item, answer.response)) throw new SchoolOsError("validation-failed", "an answer does not fit its question");
    merged.set(answer.itemId, answer);
  }
  return quiz.items.flatMap((item) => (merged.has(item.id) ? [merged.get(item.id)!] : []));
}

function fits(item: QuizItem, response: QuizResponse): boolean {
  if (response.type !== item.type) return false;
  if (response.type === "multiple-choice" && item.type === "multiple-choice") return item.choices.some((c) => c.id === response.choiceId);
  if (response.type === "multiple-select" && item.type === "multiple-select") {
    return new Set(response.choiceIds).size === response.choiceIds.length && response.choiceIds.every((id) => item.choices.some((c) => c.id === id));
  }
  if (response.type === "essay" && item.type === "essay") return response.text.length <= (item.maxLength ?? 20_000);
  return true;
}

/** A finished attempt's answers written out as Markdown: each question and the student's answer, never a key. */
function answerSheet(quiz: Quiz, attempt: QuizAttempt, answers: readonly QuizAnswer[]): AnswerSheet {
  const responses = new Map(answers.map((a) => [a.itemId, a.response]));
  const lines = [`# ${quiz.title}: attempt ${attempt.number}`, "", `Quiz ${quiz.id}, attempt ${attempt.id}.`];
  for (const [index, item] of quiz.items.entries()) {
    const response = responses.get(item.id);
    const choiceText = (id: string) => (item.type === "multiple-choice" || item.type === "multiple-select" ? item.choices.find((c) => c.id === id)?.text ?? id : id);
    let answer = "(no answer)";
    if (response?.type === "multiple-choice") answer = choiceText(response.choiceId);
    else if (response?.type === "multiple-select") answer = response.choiceIds.length === 0 ? "(none chosen)" : response.choiceIds.map((id) => `- ${choiceText(id)}`).join("\n");
    else if (response?.type === "true-false") answer = response.value ? "True" : "False";
    else if (response?.type === "numeric") answer = String(response.value);
    else if (response !== undefined) answer = response.text;
    lines.push("", `## ${index + 1}. ${item.prompt.split("\n")[0]!.slice(0, 200)}`, "", answer);
  }
  return {
    offeringId: quiz.offeringId,
    quizId: quiz.id,
    attemptId: attempt.id,
    title: `${quiz.title.slice(0, 120)}: quiz attempt ${attempt.number} answers (${attempt.id})`.slice(0, 200),
    text: `${lines.join("\n")}\n`,
  };
}

/** How each item fared over submitted attempts. */
function itemAnalysis(quiz: Quiz, submitted: readonly QuizAttempt[]): ItemAnalysis[] {
  return quiz.items.map((item) => {
    const scores = submitted.flatMap((a) => (a.itemScores ?? []).filter((s) => s.itemId === item.id));
    const graded = scores.filter((s) => s.points !== null);
    const correct = graded.filter((s) => s.points! >= s.maxPoints).length;
    const mean = graded.length === 0 ? null : Math.round((graded.reduce((sum, s) => sum + s.points!, 0) / graded.length) * 100) / 100;
    return {
      itemId: item.id,
      responses: submitted.filter((a) => a.answers.some((answer) => answer.itemId === item.id)).length,
      correct,
      graded: graded.length,
      percentCorrect: graded.length === 0 ? null : Math.round((correct / graded.length) * 1000) / 10,
      meanPoints: mean,
    };
  });
}

/** The latest release that included a student, with the grade it recorded for them. */
function lastReleasedFor(book: QuizBook, quizId: string, studentId: string): { at: string; grade: ReleasedGrade } | undefined {
  for (const release of book.releases.toReversed()) {
    if (release.quizId !== quizId) continue;
    const grade = release.grades.find((g) => g.studentId === studentId);
    if (grade !== undefined) return { at: release.at, grade };
  }
  return undefined;
}

/** The student's latest grade for a quiz that a release made official: what they are shown as released. */
function officialReleaseFor(book: QuizBook, quizId: string, studentId: string): ReleasedGrade | undefined {
  for (const release of book.releases.toReversed()) {
    if (release.quizId !== quizId) continue;
    const grade = release.grades.find((g) => g.studentId === studentId && g.outcome === "official");
    if (grade !== undefined) return grade;
  }
  return undefined;
}
