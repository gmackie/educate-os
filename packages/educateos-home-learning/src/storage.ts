// Where home learning is kept (ADR-0016), and an in-memory store for tests and the in-browser demo.
// The district Worker keeps the same records in its Durable Object's SQLite.
import { EducateOsError, type FamilyId, type LearnerId, type PrincipalId } from "@educateos/contracts";
import { ChildSession, FamilyRecord, PracticeSession, type PracticeSessionId } from "./model.ts";
import type { ActivityRef } from "./content/schema.ts";

/** The message a conflicting write fails with. */
export const HOME_LEARNING_CONFLICT = "This changed while you were working on it; reload and try again.";

/** Where home learning is kept. Every read returns a copy; every write is checked against what it read. */
export interface HomeLearningStore {
  /** A family, or undefined. */
  loadFamily(id: FamilyId): Promise<FamilyRecord | undefined>;
  /** The family an adult belongs to, if any. */
  familyOfAdult(principalId: PrincipalId): Promise<FamilyId | undefined>;
  /** The family a learner belongs to, if any. */
  familyOfLearner(learnerId: LearnerId): Promise<FamilyId | undefined>;
  /**
   * Writes a family whole. `expectedRevision` is the revision it was read at, or undefined to create
   * it; `next.revision` must be one more.
   *
   * @throws EducateOsError `conflict` if the stored revision differs, or an adult already belongs to
   *   another family.
   */
  commitFamily(next: FamilyRecord, expectedRevision: number | undefined): Promise<void>;
  /** Deletes a family with its sessions and child sessions. */
  deleteFamily(id: FamilyId): Promise<void>;
  /** A session, or undefined. */
  getSession(id: PracticeSessionId): Promise<PracticeSession | undefined>;
  /**
   * Writes a session whole. `expectedVersion` is the version it was read at, or undefined to create it.
   *
   * @throws EducateOsError `conflict` if the stored version differs.
   */
  saveSession(next: PracticeSession, expectedVersion: number | undefined): Promise<void>;
  /** A learner's sessions, newest first, up to `limit`. */
  listSessions(learnerId: LearnerId, limit: number): Promise<PracticeSession[]>;
  /** The learner's unfinished session of exactly this activity version, if any. */
  openSession(learnerId: LearnerId, ref: ActivityRef): Promise<PracticeSession | undefined>;
  /** Deletes every session of a learner. */
  deleteSessionsOf(learnerId: LearnerId): Promise<void>;
  /** The child session with this token digest, or undefined. */
  getChildSession(digest: string): Promise<ChildSession | undefined>;
  /** Writes a child session whole, by digest. */
  putChildSession(session: ChildSession): Promise<void>;
  /** Ends every open child session of a family (only those `startedBy` started, if given), as of `at`. Returns how many it ended. */
  endChildSessionsOf(familyId: FamilyId, at: string, startedBy?: PrincipalId): Promise<number>;
  /** Deletes every practice session started before `before`, in any family. Returns how many. */
  deleteSessionsStartedBefore(before: string): Promise<number>;
  /**
   * Deletes every child session that ended before `endedBefore` or started before `startedBefore`,
   * in any family. Returns how many.
   */
  deleteChildSessions(endedBefore: string, startedBefore: string): Promise<number>;
  /** Every family's ID, for the scheduled purge. */
  familyIds(): Promise<FamilyId[]>;
}

const conflict = () => new EducateOsError("conflict", HOME_LEARNING_CONFLICT);
const sameRef = (a: ActivityRef, b: ActivityRef) => a.pack === b.pack && a.version === b.version && a.activity === b.activity;

/** A {@link HomeLearningStore} in memory. */
export class InMemoryHomeLearningStore implements HomeLearningStore {
  readonly #families = new Map<string, FamilyRecord>();
  readonly #sessions = new Map<string, PracticeSession>();
  readonly #children = new Map<string, ChildSession>();

  async loadFamily(id: FamilyId) {
    const family = this.#families.get(id);
    return family === undefined ? undefined : structuredClone(family);
  }

  async familyOfAdult(principalId: PrincipalId) {
    return [...this.#families.values()].find((f) => f.adults.some((a) => a.principalId === principalId))?.id;
  }

  async familyOfLearner(learnerId: LearnerId) {
    return [...this.#families.values()].find((f) => f.learners.some((l) => l.id === learnerId))?.id;
  }

  async commitFamily(next: FamilyRecord, expectedRevision: number | undefined) {
    const parsed = FamilyRecord.parse(next);
    const stored = this.#families.get(parsed.id);
    if ((stored?.revision) !== expectedRevision || parsed.revision !== (expectedRevision ?? 0) + 1) throw conflict();
    for (const adult of parsed.adults) {
      const other = await this.familyOfAdult(adult.principalId);
      if (other !== undefined && other !== parsed.id) throw new EducateOsError("conflict", "That adult already belongs to a family.");
    }
    this.#families.set(parsed.id, structuredClone(parsed));
  }

  async deleteFamily(id: FamilyId) {
    this.#families.delete(id);
    for (const [key, session] of this.#sessions) if (session.familyId === id) this.#sessions.delete(key);
    for (const [key, child] of this.#children) if (child.familyId === id) this.#children.delete(key);
  }

  async getSession(id: PracticeSessionId) {
    const session = this.#sessions.get(id);
    return session === undefined ? undefined : structuredClone(session);
  }

  async saveSession(next: PracticeSession, expectedVersion: number | undefined) {
    const parsed = PracticeSession.parse(next);
    const stored = this.#sessions.get(parsed.id);
    if ((stored?.version) !== expectedVersion || parsed.version !== (expectedVersion ?? 0) + 1) throw conflict();
    this.#sessions.set(parsed.id, structuredClone(parsed));
  }

  async listSessions(learnerId: LearnerId, limit: number) {
    return [...this.#sessions.values()]
      .filter((s) => s.learnerId === learnerId)
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  async openSession(learnerId: LearnerId, ref: ActivityRef) {
    const open = [...this.#sessions.values()].find((s) => s.learnerId === learnerId && s.completedAt === undefined && sameRef(s.ref, ref));
    return open === undefined ? undefined : structuredClone(open);
  }

  async deleteSessionsOf(learnerId: LearnerId) {
    for (const [key, session] of this.#sessions) if (session.learnerId === learnerId) this.#sessions.delete(key);
    for (const [key, child] of this.#children) if (child.learnerId === learnerId) this.#children.delete(key);
  }

  async getChildSession(digest: string) {
    const child = this.#children.get(digest);
    return child === undefined ? undefined : structuredClone(child);
  }

  async putChildSession(session: ChildSession) {
    const parsed = ChildSession.parse(session);
    this.#children.set(parsed.digest, structuredClone(parsed));
  }

  async deleteSessionsStartedBefore(before: string) {
    let deleted = 0;
    for (const [key, session] of this.#sessions) {
      if (session.startedAt < before) {
        this.#sessions.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteChildSessions(endedBefore: string, startedBefore: string) {
    let deleted = 0;
    for (const [key, child] of this.#children) {
      if ((child.endedAt !== undefined && child.endedAt < endedBefore) || child.startedAt < startedBefore) {
        this.#children.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async familyIds() {
    return [...this.#families.keys()] as FamilyId[];
  }

  async endChildSessionsOf(familyId: FamilyId, at: string, startedBy?: PrincipalId) {
    let ended = 0;
    for (const child of this.#children.values()) {
      if (child.familyId === familyId && child.endedAt === undefined && (startedBy === undefined || child.startedBy === startedBy)) {
        child.endedAt = at;
        ended += 1;
      }
    }
    return ended;
  }
}
