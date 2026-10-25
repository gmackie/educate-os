// Where an offering's quizzes are kept. A change is a write of the records it touched, applied over
// the book revision it was made against, so a student's autosave cannot lose a teacher's edit or
// another student's submission.
import { EducateOsError, type OfferingId } from "@educateos/contracts";
import { QuizBook, type Quiz, type QuizAttempt, type QuizRelease } from "./model.ts";

/** What one change writes to a book: the quizzes and attempts it added or changed, and the releases it appended. */
export interface QuizBookWrite {
  /** The book's next revision: one more than the revision the change was made against. */
  revision: number;
  /** Quizzes added or changed, whole. */
  quizzes: readonly Quiz[];
  /** Quizzes deleted. Only a quiz no one has attempted is ever deleted. */
  deletedQuizIds: readonly string[];
  /** Attempts added or changed, whole. */
  attempts: readonly QuizAttempt[];
  /** Releases appended. */
  releases: readonly QuizRelease[];
}

/**
 * Where each offering's quizzes are kept. A commit applies a write only if the book's revision is
 * still the one the change was made against.
 */
export interface QuizStorage {
  /** The offering's book, or undefined if nothing has been stored for it. */
  load(offeringId: OfferingId): Promise<QuizBook | undefined>;
  /**
   * Applies `write` to the offering's book.
   *
   * @throws EducateOsError `conflict` if the stored revision is not `expectedRevision`.
   */
  commit(offeringId: OfferingId, write: QuizBookWrite, expectedRevision: number): Promise<void>;
}

/** The message a conflicting commit fails with. */
export const QUIZ_CONFLICT = "The quiz changed while this request was in progress; reload it and try again.";

/**
 * Applies a write to a book as stored (the in-memory and the durable stores apply it alike). A
 * changed record keeps its place; new ones go last.
 */
export function applyQuizBookWrite(book: QuizBook, write: QuizBookWrite): QuizBook {
  const deleted = new Set(write.deletedQuizIds);
  const quizzes = new Map(book.quizzes.filter((q) => !deleted.has(q.id)).map((q) => [q.id, q]));
  for (const quiz of write.quizzes) quizzes.set(quiz.id, quiz);
  const attempts = new Map(book.attempts.map((a) => [a.id, a]));
  for (const attempt of write.attempts) attempts.set(attempt.id, attempt);
  return QuizBook.parse({
    offeringId: book.offeringId,
    revision: write.revision,
    quizzes: [...quizzes.values()],
    attempts: [...attempts.values()],
    releases: [...book.releases, ...write.releases],
  });
}

/** An offering's book before anything is stored. */
export const emptyQuizBook = (offeringId: OfferingId): QuizBook => ({ offeringId, revision: 0, quizzes: [], attempts: [], releases: [] });

/** {@link QuizStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryQuizStorage implements QuizStorage {
  readonly #books = new Map<string, QuizBook>();

  async load(offeringId: OfferingId): Promise<QuizBook | undefined> {
    const book = this.#books.get(offeringId);
    return book === undefined ? undefined : structuredClone(book);
  }

  async commit(offeringId: OfferingId, write: QuizBookWrite, expectedRevision: number): Promise<void> {
    const current = this.#books.get(offeringId) ?? emptyQuizBook(offeringId);
    if (current.revision !== expectedRevision) throw new EducateOsError("conflict", QUIZ_CONFLICT);
    this.#books.set(offeringId, structuredClone(applyQuizBookWrite(current, write)));
  }
}
