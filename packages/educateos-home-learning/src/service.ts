// The home-learning service (ADR-0016). Every method takes the verified adult it acts for and asks
// the district's policy engine before reading or changing anything, so each decision is audited
// with the rule that made it. A family's records are reachable only through a `family-adult`
// relationship; a request for another family's records is answered as if they did not exist.
//
// Child practice runs as the adult who started the child session, restricted by that session to
// one learner and to practice alone: the district app refuses every other route while a child
// session's cookie is on the browser, and only the family PIN (or the adult, from another device)
// ends it.
import {
  EducateOsError,
  FamilyId,
  LearnerId,
  type Authorizer,
  type DistrictId,
  type ResourceRef,
  type VerifiedPrincipal,
  type Action,
} from "@educateos/contracts";
import { z } from "zod";
import {
  PACKS,
  currentPackFor,
  currentPacks,
  itemOf,
  refTo,
  resolveActivity,
  ActivityKey,
  GradeBand,
  PackId,
  type Activity,
  type ActivityRef,
  type Item,
  type Pack,
  type Track,
} from "./content/index.ts";
import {
  DisplayName,
  LearnerAvatar,
  MAX_LEARNERS,
  MAX_QUEUE,
  MAX_SHELF,
  PracticeSessionId,
  QueueEntryId,
  ShelfItem,
  ShelfItemId,
  type ChildSession,
  type EvidenceCorrection,
  type FamilyRecord,
  type Learner,
  type PracticeSession,
  type QueueEntry,
} from "./model.ts";
import { nextAfter, progressOf, sessionNote, suggestionFor, type SkillProgress } from "./progress.ts";
import { scoreResponse, ResponseInput, type ScoredResponse } from "./scoring.ts";
import { PIN_LOCK_MS, PIN_MAX_FAILURES, Pin, hashPin, idBody, newToken, pinMatches, tokenDigest } from "./secrets.ts";
import type { HomeLearningStore } from "./storage.ts";

/** What the service is built from. */
export interface HomeLearningServiceOptions {
  store: HomeLearningStore;
  /** The district's policy engine, auditing under the request's correlation ID. */
  authorizer: Authorizer;
  districtId: DistrictId;
  now?: () => Date;
  /** The shipped packs; tests may pass others. */
  packs?: readonly Pack[];
}

// Inputs

/** Starting a family. */
export const CreateFamilyInput = z.strictObject({ name: DisplayName, pin: Pin });
/** Adding a child. */
export const AddLearnerInput = z.strictObject({ displayName: DisplayName, avatar: LearnerAvatar, gradeBand: GradeBand });
/** Changing a child's profile or starting points. */
export const UpdateLearnerInput = z.strictObject({
  displayName: DisplayName.optional(),
  avatar: LearnerAvatar.optional(),
  gradeBand: GradeBand.optional(),
  starts: z.strictObject({ reading: ActivityKey.optional(), math: ActivityKey.optional() }).optional(),
});
/** Adding an activity of a pack's current version to a child's queue. */
export const QueueAddInput = z.strictObject({ pack: PackId, activity: ActivityKey });
/** Changing one queue entry: moving it, or pausing or resuming it. */
export const QueueChangeInput = z.strictObject({ moveTo: z.int().min(0).max(MAX_QUEUE - 1).optional(), paused: z.boolean().optional() });
/** Adding to the shelf. */
export const ShelfAddInput = ShelfItem.pick({ kind: true, title: true, url: true, note: true, learnerIds: true });
/** An adult's correction of one response. */
export const CorrectionInput = z.strictObject({ item: z.string().min(1).max(64), verdict: z.enum(["independent", "with-help", "incorrect", "exclude"]) });

// Views

/** One queued activity, as a parent sees it. */
export interface QueueEntryView {
  id: string;
  ref: ActivityRef;
  title: string;
  track: Track;
  mode: Activity["mode"];
  minutes: number;
  paused: boolean;
  /** An unfinished session of it exists, to resume. */
  inProgress: boolean;
}

/** A family, as its adults see it. Never carries the PIN. */
export interface FamilyView {
  id: string;
  name: string;
  learners: Learner[];
  queues: Record<string, QueueEntryView[]>;
  shelf: ShelfItem[];
  pinLocked: boolean;
}

/** The home page's answer: the adult's family, or none yet. */
export interface HomeView {
  family: FamilyView | null;
}

/** One finished or unfinished session, summarized with its parent note. */
export interface SessionSummary {
  id: string;
  ref: ActivityRef;
  title: string;
  track: Track;
  skillTitle: string;
  mode: Activity["mode"];
  startedAt: string;
  completedAt?: string;
  answered: number;
  of: number;
  independent: number;
  note: string;
}

/** A child's Today: what is queued, what to suggest, and the latest session. */
export interface TodayLearner {
  learner: Learner;
  next: QueueEntryView[];
  suggestions: { track: Track; ref: ActivityRef; title: string; minutes: number; preview: string }[];
  latest?: SessionSummary;
}

/** One skill's progress as sent to a parent. */
export interface SkillProgressView extends Omit<SkillProgress, "skill"> {
  skillId: string;
  title: string;
  description: string;
  standards: string[];
}

/** A child's progress page. */
export interface ProgressView {
  learner: Learner;
  skills: SkillProgressView[];
  sessions: SessionSummary[];
}

/** One item of a session, with what was saved and any correction. */
export interface SessionItemView {
  item: Item;
  response?: ScoredResponse;
  correction?: EvidenceCorrection;
}

/** A session in full, for a parent reviewing it. */
export interface SessionDetail {
  summary: SessionSummary;
  activity: Activity;
  items: SessionItemView[];
}

/** One activity in the library. */
export interface LibraryActivity {
  ref: ActivityRef;
  title: string;
  skillId: string;
  skillTitle: string;
  strand: string;
  mode: Activity["mode"];
  minutes: number;
  preview: string;
  adultGuide?: string;
  after: string[];
  itemCount: number;
}

/** The library: the current version of each pack. */
export interface LibraryView {
  packs: {
    id: string;
    version: string;
    track: Track;
    title: string;
    summary: string;
    review: Pack["review"];
    gradeBands: string[];
    startFor: Record<string, string>;
    activities: LibraryActivity[];
  }[];
}

/** What a child sees on their practice page. */
export interface PracticeHome {
  learner: Pick<Learner, "id" | "displayName" | "avatar">;
  queue: { entryId: string; title: string; track: Track; minutes: number; inProgress: boolean }[];
}

/** A session as the child's screen runs it: the activity's child-facing text and the drawn items, answers included for feedback. */
export interface PracticeView {
  sessionId: string;
  title: string;
  track: Track;
  mode: Activity["mode"];
  directions: string;
  example: string;
  /** Guidance for the adult sitting alongside, shown behind an "For grown-ups" control. */
  adultGuide?: string;
  items: Item[];
  /** Items already saved, by key, so a resumed session continues where it stopped. */
  saved: string[];
  completed: boolean;
}

/** A family export: everything the installation keeps for the family, except its PIN. */
export interface FamilyExport {
  format: "educateos.home-learning-export.v1";
  exportedAt: string;
  family: Omit<FamilyRecord, "pin">;
  sessions: PracticeSession[];
}

const notFound = () => new EducateOsError("not-found", "We couldn't find that.");

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The home-learning service. */
export class HomeLearningService {
  readonly #store: HomeLearningStore;
  readonly #authorizer: Authorizer;
  readonly #districtId: DistrictId;
  readonly #now: () => Date;
  readonly #packs: readonly Pack[];

  constructor(options: HomeLearningServiceOptions) {
    this.#store = options.store;
    this.#authorizer = options.authorizer;
    this.#districtId = options.districtId;
    this.#now = options.now ?? (() => new Date());
    this.#packs = options.packs ?? PACKS;
  }

  // Family

  /** The adult's family, or none yet. */
  async home(subject: VerifiedPrincipal): Promise<HomeView> {
    const familyId = await this.#store.familyOfAdult(subject.principalId);
    if (familyId === undefined) return { family: null };
    const family = await this.#read(subject, "read", familyId);
    return { family: await this.#view(family) };
  }

  /**
   * Starts a family with the adult as its first member.
   *
   * @throws EducateOsError `conflict` if the adult already has one.
   */
  async createFamily(subject: VerifiedPrincipal, input: unknown): Promise<FamilyView> {
    const { name, pin } = CreateFamilyInput.parse(input);
    await this.#require(subject, "create", this.#familyRef());
    if (await this.#store.familyOfAdult(subject.principalId) !== undefined) {
      throw new EducateOsError("conflict", "You already have a family here.");
    }
    const at = this.#iso();
    const family: FamilyRecord = {
      id: FamilyId.parse(`fam_${idBody()}`),
      districtId: this.#districtId,
      name,
      adults: [{ principalId: subject.principalId, joinedAt: at }],
      learners: [],
      queues: {},
      shelf: [],
      pin: await hashPin(pin),
      createdAt: at,
      revision: 1,
    };
    await this.#store.commitFamily(family, undefined);
    return this.#view(family);
  }

  /** Renames the family. */
  async renameFamily(subject: VerifiedPrincipal, name: unknown): Promise<FamilyView> {
    const parsed = DisplayName.parse(name);
    return this.#change(subject, (family) => ({ ...family, name: parsed }));
  }

  /** Sets a new PIN, clearing any lock. Only reachable outside a child session. */
  async changePin(subject: VerifiedPrincipal, pin: unknown): Promise<FamilyView> {
    const stored = await hashPin(Pin.parse(pin));
    return this.#change(subject, (family) => ({ ...family, pin: stored }));
  }

  /** Adds a child, starting each track where the pack suggests for their grade band. */
  async addLearner(subject: VerifiedPrincipal, input: unknown): Promise<Learner> {
    const { displayName, avatar, gradeBand } = AddLearnerInput.parse(input);
    const learner: Learner = {
      id: LearnerId.parse(`lrn_${idBody()}`),
      displayName,
      avatar,
      gradeBand,
      starts: { reading: this.#pack("reading").startFor[gradeBand]!, math: this.#pack("math").startFor[gradeBand]! },
      createdAt: this.#iso(),
    };
    await this.#change(subject, (family) => {
      if (family.learners.length >= MAX_LEARNERS) throw new EducateOsError("conflict", `A family can have up to ${MAX_LEARNERS} children.`);
      return { ...family, learners: [...family.learners, learner], queues: { ...family.queues, [learner.id]: [] } };
    });
    return learner;
  }

  /** Changes a child's profile or starting points. */
  async updateLearner(subject: VerifiedPrincipal, learnerId: unknown, input: unknown): Promise<Learner> {
    const id = LearnerId.parse(learnerId);
    const change = UpdateLearnerInput.parse(input);
    for (const track of ["reading", "math"] as const) {
      const key = change.starts?.[track];
      if (key !== undefined && !this.#pack(track).activities.some((a) => a.key === key)) {
        throw new EducateOsError("validation-failed", `That ${track} starting point isn't in the library.`);
      }
    }
    let updated: Learner | undefined;
    await this.#changeForLearner(subject, id, "update", (family) => ({
      ...family,
      learners: family.learners.map((l) => {
        if (l.id !== id) return l;
        updated = {
          ...l,
          ...(change.displayName === undefined ? {} : { displayName: change.displayName }),
          ...(change.avatar === undefined ? {} : { avatar: change.avatar }),
          ...(change.gradeBand === undefined ? {} : { gradeBand: change.gradeBand }),
          starts: { reading: change.starts?.reading ?? l.starts.reading, math: change.starts?.math ?? l.starts.math },
        };
        return updated;
      }),
    }));
    return updated!;
  }

  /** Removes a child with all their practice. This can't be undone. */
  async removeLearner(subject: VerifiedPrincipal, learnerId: unknown): Promise<void> {
    const id = LearnerId.parse(learnerId);
    await this.#changeForLearner(subject, id, "delete", (family) => {
      const queues = { ...family.queues };
      delete queues[id];
      return {
        ...family,
        learners: family.learners.filter((l) => l.id !== id),
        queues,
        shelf: family.shelf.map((s) => ({ ...s, learnerIds: s.learnerIds.filter((l) => l !== id) })),
      };
    });
    await this.#store.deleteSessionsOf(id);
  }

  /** Everything the installation keeps for the family, except its PIN. */
  async exportFamily(subject: VerifiedPrincipal): Promise<FamilyExport> {
    const family = await this.#read(subject, "export", await this.#familyIdOf(subject));
    const sessions = (await Promise.all(family.learners.map((l) => this.#store.listSessions(l.id, 10_000)))).flat();
    const { pin: _pin, ...rest } = family;
    return { format: "educateos.home-learning-export.v1", exportedAt: this.#iso(), family: rest, sessions };
  }

  /** Deletes the family and all its children's practice. The adult's sign-in stays. */
  async deleteFamily(subject: VerifiedPrincipal): Promise<void> {
    const family = await this.#read(subject, "delete", await this.#familyIdOf(subject));
    await this.#store.deleteFamily(family.id);
  }

  // Shelf

  /** Adds something to the family's shelf. Shelf items are never practice and never evidence. */
  async addShelfItem(subject: VerifiedPrincipal, input: unknown): Promise<ShelfItem> {
    const parsed = ShelfAddInput.parse(input);
    const item: ShelfItem = { ...parsed, id: ShelfItemId.parse(`hsi_${idBody()}`), addedAt: this.#iso(), addedBy: subject.principalId };
    await this.#change(subject, (family) => {
      if (family.shelf.length >= MAX_SHELF) throw new EducateOsError("conflict", `The shelf holds up to ${MAX_SHELF} items.`);
      if (item.learnerIds.some((id) => !family.learners.some((l) => l.id === id))) throw notFound();
      if (item.kind === "link" && item.url === undefined) throw new EducateOsError("validation-failed", "A link needs its address.");
      if ((item.kind === "book" || item.kind === "note") && item.url !== undefined) throw new EducateOsError("validation-failed", "Only links and worksheets have an address.");
      return { ...family, shelf: [...family.shelf, item] };
    });
    return item;
  }

  /** Removes something from the shelf. */
  async removeShelfItem(subject: VerifiedPrincipal, itemId: unknown): Promise<void> {
    const id = ShelfItemId.parse(itemId);
    await this.#change(subject, (family) => {
      if (!family.shelf.some((s) => s.id === id)) throw notFound();
      return { ...family, shelf: family.shelf.filter((s) => s.id !== id) };
    });
  }

  // Library and queue

  /** The current version of every pack, with each activity's preview. */
  async library(subject: VerifiedPrincipal): Promise<LibraryView> {
    await this.#read(subject, "read", await this.#familyIdOf(subject));
    return {
      packs: currentPacks(this.#packs).map((pack) => ({
        id: pack.id, version: pack.version, track: pack.track, title: pack.title, summary: pack.summary, review: pack.review,
        gradeBands: pack.gradeBands, startFor: pack.startFor,
        activities: pack.activities.map((a) => {
          const skill = pack.skills.find((s) => s.id === a.skill)!;
          return {
            ref: refTo(pack, a.key), title: a.title, skillId: skill.id, skillTitle: skill.title, strand: skill.strand, mode: a.mode,
            minutes: a.minutes, preview: a.preview, after: a.after, itemCount: a.items.length,
            ...(a.adultGuide === undefined ? {} : { adultGuide: a.adultGuide }),
          };
        }),
      })),
    };
  }

  /** One activity in full, items included, for a parent previewing it. */
  async previewActivity(subject: VerifiedPrincipal, ref: unknown): Promise<Activity> {
    await this.#read(subject, "read", await this.#familyIdOf(subject));
    return this.#resolve(ref as ActivityRef).activity;
  }

  /** Adds an activity of a pack's current version to the end of a child's queue. */
  async addToQueue(subject: VerifiedPrincipal, learnerId: unknown, input: unknown): Promise<QueueEntryView[]> {
    const id = LearnerId.parse(learnerId);
    const { pack: packId, activity } = QueueAddInput.parse(input);
    const pack = currentPacks(this.#packs).find((p) => p.id === packId);
    if (pack === undefined || !pack.activities.some((a) => a.key === activity)) throw notFound();
    const entry: QueueEntry = { id: QueueEntryId.parse(`hqe_${idBody()}`), ref: refTo(pack, activity), addedAt: this.#iso(), addedBy: subject.principalId, paused: false };
    const family = await this.#changeForLearner(subject, id, "update", (f) => {
      const queue = f.queues[id] ?? [];
      if (queue.length >= MAX_QUEUE) throw new EducateOsError("conflict", `A queue holds up to ${MAX_QUEUE} activities.`);
      return { ...f, queues: { ...f.queues, [id]: [...queue, entry] } };
    });
    return this.#queueView(family, id);
  }

  /** Moves, pauses or resumes one queued activity. */
  async changeQueueEntry(subject: VerifiedPrincipal, learnerId: unknown, entryId: unknown, input: unknown): Promise<QueueEntryView[]> {
    const id = LearnerId.parse(learnerId);
    const eid = QueueEntryId.parse(entryId);
    const { moveTo, paused } = QueueChangeInput.parse(input);
    const family = await this.#changeForLearner(subject, id, "update", (f) => {
      const queue = [...(f.queues[id] ?? [])];
      const index = queue.findIndex((e) => e.id === eid);
      if (index < 0) throw notFound();
      const [entry] = queue.splice(index, 1);
      const changed = paused === undefined ? entry! : { ...entry!, paused };
      queue.splice(moveTo === undefined ? index : Math.min(moveTo, queue.length), 0, changed);
      return { ...f, queues: { ...f.queues, [id]: queue } };
    });
    return this.#queueView(family, id);
  }

  /** Removes one queued activity. Any practice already saved for it stays. */
  async removeQueueEntry(subject: VerifiedPrincipal, learnerId: unknown, entryId: unknown): Promise<QueueEntryView[]> {
    const id = LearnerId.parse(learnerId);
    const eid = QueueEntryId.parse(entryId);
    const family = await this.#changeForLearner(subject, id, "update", (f) => {
      const queue = f.queues[id] ?? [];
      if (!queue.some((e) => e.id === eid)) throw notFound();
      return { ...f, queues: { ...f.queues, [id]: queue.filter((e) => e.id !== eid) } };
    });
    return this.#queueView(family, id);
  }

  // Today and progress

  /** Each child's Today: the next queued activities, suggestions for each track, and the latest session. */
  async today(subject: VerifiedPrincipal): Promise<TodayLearner[]> {
    const family = await this.#read(subject, "read", await this.#familyIdOf(subject));
    const result: TodayLearner[] = [];
    for (const learner of family.learners) {
      await this.#require(subject, "read", this.#practiceRef(learner.id));
      const sessions = await this.#store.listSessions(learner.id, 200);
      const progress = progressOf(currentPacks(this.#packs), sessions, this.#now());
      const queue = family.queues[learner.id] ?? [];
      const suggestions = (["reading", "math"] as const).flatMap((track) => {
        const pack = this.#pack(track);
        const next = suggestionFor(pack, learner, progress.filter((p) => p.track === track), queue);
        return next === undefined ? [] : [{ track, ref: refTo(pack, next.key), title: next.title, minutes: next.minutes, preview: next.preview }];
      });
      const latest = sessions[0];
      result.push({
        learner,
        next: (await this.#queueView(family, learner.id)).filter((e) => !e.paused).slice(0, 3),
        suggestions,
        ...(latest === undefined ? {} : { latest: this.#summary(learner, latest, progress) }),
      });
    }
    return result;
  }

  /** A child's progress by skill, with their recent sessions and a note for each. */
  async progress(subject: VerifiedPrincipal, learnerId: unknown): Promise<ProgressView> {
    const { learner } = await this.#learner(subject, LearnerId.parse(learnerId), "read");
    const sessions = await this.#store.listSessions(learner.id, 200);
    const progress = progressOf(currentPacks(this.#packs), sessions, this.#now());
    return {
      learner,
      skills: progress.map(({ skill, ...rest }) => ({ ...rest, skillId: skill.id, title: skill.title, description: skill.description, standards: skill.standards })),
      sessions: sessions.slice(0, 30).map((s) => this.#summary(learner, s, progress)),
    };
  }

  /** One session in full: each item, what was saved and any correction. */
  async session(subject: VerifiedPrincipal, learnerId: unknown, sessionId: unknown): Promise<SessionDetail> {
    const { learner } = await this.#learner(subject, LearnerId.parse(learnerId), "read");
    const session = await this.#sessionOf(learner.id, sessionId);
    const { activity } = this.#resolve(session.ref);
    const sessions = await this.#store.listSessions(learner.id, 200);
    const progress = progressOf(currentPacks(this.#packs), sessions, this.#now());
    return {
      summary: this.#summary(learner, session, progress),
      activity,
      items: session.items.map((key) => {
        const response = session.responses.find((r) => r.item === key);
        const correction = session.corrections.filter((c) => c.item === key).at(-1);
        return { item: itemOf(activity, key), ...(response === undefined ? {} : { response }), ...(correction === undefined ? {} : { correction }) };
      }),
    };
  }

  /** Records an adult's correction of one saved response. The response itself is kept unchanged. */
  async correct(subject: VerifiedPrincipal, learnerId: unknown, sessionId: unknown, input: unknown): Promise<SessionDetail> {
    const id = LearnerId.parse(learnerId);
    const { item, verdict } = CorrectionInput.parse(input);
    await this.#learner(subject, id, "update");
    const session = await this.#sessionOf(id, sessionId);
    if (!session.responses.some((r) => r.item === item)) throw notFound();
    const next: PracticeSession = {
      ...session,
      corrections: [...session.corrections, { item, verdict, at: this.#iso(), by: subject.principalId }],
      updatedAt: this.#iso(),
      version: session.version + 1,
    };
    await this.#store.saveSession(next, session.version);
    return this.session(subject, id, session.id);
  }

  // Child sessions

  /** Starts a child session on this browser: returns the token for its cookie. */
  async startChildSession(subject: VerifiedPrincipal, learnerId: unknown): Promise<{ token: string; learner: Learner }> {
    const { learner, family } = await this.#learner(subject, LearnerId.parse(learnerId), "submit");
    const token = newToken();
    await this.#store.putChildSession({ digest: await tokenDigest(token), familyId: family.id, learnerId: learner.id, startedBy: subject.principalId, startedAt: this.#iso() });
    return { token, learner };
  }

  /**
   * The open child session a token names for this adult, or undefined. A token another adult
   * started, or one that has ended or whose child was removed, names none.
   */
  async childSession(subject: VerifiedPrincipal, token: string | undefined): Promise<ChildSession | undefined> {
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const child = await this.#store.getChildSession(await tokenDigest(token));
    if (child === undefined || child.endedAt !== undefined || child.startedBy !== subject.principalId) return undefined;
    if (await this.#store.familyOfLearner(child.learnerId) !== child.familyId) return undefined;
    return child;
  }

  /**
   * Ends a child session with the family PIN. Five wrong PINs lock it for fifteen minutes; an adult
   * can still end it from another device.
   *
   * @throws EducateOsError `forbidden` for a wrong or locked PIN.
   */
  async endChildSession(subject: VerifiedPrincipal, child: ChildSession, pin: unknown): Promise<void> {
    const family = await this.#read(subject, "update", child.familyId);
    const now = this.#now();
    if (family.pin.lockedUntil !== undefined && Date.parse(family.pin.lockedUntil) > now.getTime()) {
      throw new EducateOsError("forbidden", "Too many tries. Wait a few minutes, or end practice from a grown-up's other device.");
    }
    const ok = await pinMatches(family.pin, typeof pin === "string" ? pin : "");
    const failures = ok ? 0 : family.pin.failures + 1;
    const locked = failures >= PIN_MAX_FAILURES;
    const { lockedUntil: _cleared, ...pinWithoutLock } = family.pin;
    await this.#store.commitFamily({
      ...family,
      pin: { ...pinWithoutLock, failures: locked ? 0 : failures, ...(locked ? { lockedUntil: new Date(now.getTime() + PIN_LOCK_MS).toISOString() } : {}) },
      revision: family.revision + 1,
    }, family.revision);
    if (!ok) throw new EducateOsError("forbidden", locked ? "Too many tries. Wait a few minutes, or end practice from a grown-up's other device." : "That PIN isn't right.");
    await this.#store.putChildSession({ ...child, endedAt: now.toISOString() });
  }

  /** Ends every child session of the adult's family, from a device that isn't in one. */
  async endAllChildSessions(subject: VerifiedPrincipal): Promise<number> {
    const family = await this.#read(subject, "update", await this.#familyIdOf(subject));
    return this.#store.endChildSessionsOf(family.id, this.#iso());
  }

  // Practice, inside a child session

  /** The child's practice page: their unpaused queue. */
  async practiceHome(subject: VerifiedPrincipal, child: ChildSession): Promise<PracticeHome> {
    const { learner, family } = await this.#learner(subject, child.learnerId, "read");
    const queue = await this.#queueView(family, learner.id);
    return {
      learner: { id: learner.id, displayName: learner.displayName, avatar: learner.avatar },
      queue: queue.filter((e) => !e.paused).map((e) => ({ entryId: e.id, title: e.title, track: e.track, minutes: e.minutes, inProgress: e.inProgress })),
    };
  }

  /** Starts (or resumes) the child's practice of one queued activity. */
  async startPractice(subject: VerifiedPrincipal, child: ChildSession, entryId: unknown): Promise<PracticeView> {
    const eid = QueueEntryId.parse(entryId);
    const { learner, family } = await this.#learner(subject, child.learnerId, "submit");
    const entry = (family.queues[learner.id] ?? []).find((e) => e.id === eid && !e.paused);
    if (entry === undefined) throw notFound();
    const { activity } = this.#resolve(entry.ref);
    const open = await this.#store.openSession(learner.id, entry.ref);
    if (open !== undefined) return this.#practiceView(open, activity);
    const id = PracticeSessionId.parse(`hps_${idBody()}`);
    const previous = (await this.#store.listSessions(learner.id, 200)).find((s) => s.ref.pack === entry.ref.pack && s.ref.activity === entry.ref.activity);
    const at = this.#iso();
    const session: PracticeSession = {
      id, familyId: family.id, learnerId: learner.id, ref: entry.ref, mode: activity.mode,
      items: this.#draw(activity, id, new Set(previous?.items ?? [])),
      queueEntryId: entry.id, startedAt: at, updatedAt: at, responses: [], corrections: [], version: 1,
    };
    await this.#store.saveSession(session, undefined);
    return this.#practiceView(session, activity);
  }

  /**
   * Saves one finished item. Saving the same `requestId` again returns the stored response unchanged;
   * a different response to an item already saved is a conflict. Saving the last item finishes the
   * session and takes its activity off the queue.
   */
  async saveResponse(subject: VerifiedPrincipal, child: ChildSession, sessionId: unknown, input: unknown): Promise<{ response: ScoredResponse; completed: boolean }> {
    const parsed = ResponseInput.parse(input);
    await this.#learner(subject, child.learnerId, "submit");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await this.#sessionOf(child.learnerId, sessionId);
      const existing = session.responses.find((r) => r.item === parsed.item);
      if (existing !== undefined) {
        if (existing.requestId === parsed.requestId) return { response: existing, completed: session.completedAt !== undefined };
        throw new EducateOsError("conflict", "That answer was already saved.");
      }
      if (session.completedAt !== undefined) throw new EducateOsError("conflict", "This practice is already finished.");
      if (!session.items.includes(parsed.item)) throw notFound();
      const { activity } = this.#resolve(session.ref);
      const at = this.#iso();
      const response = scoreResponse(itemOf(activity, parsed.item), session.mode, parsed, at);
      const responses = [...session.responses, response];
      const completed = session.items.every((key) => responses.some((r) => r.item === key));
      const next: PracticeSession = { ...session, responses, updatedAt: at, ...(completed ? { completedAt: at } : {}), version: session.version + 1 };
      try {
        await this.#store.saveSession(next, session.version);
      } catch (error) {
        if (error instanceof EducateOsError && error.code === "conflict") continue;
        throw error;
      }
      if (completed && session.queueEntryId !== undefined) await this.#finishEntry(subject, child.learnerId, session.queueEntryId);
      return { response, completed };
    }
    throw new EducateOsError("conflict", "Couldn't save that answer; try again.");
  }

  // Internals

  async #finishEntry(subject: VerifiedPrincipal, learnerId: string, entryId: string): Promise<void> {
    await this.#changeForLearner(subject, LearnerId.parse(learnerId), "submit", (family) => ({
      ...family,
      queues: { ...family.queues, [learnerId]: (family.queues[learnerId] ?? []).filter((e) => e.id !== entryId) },
    })).catch((error: unknown) => {
      // The session is saved; a queue that changed meanwhile only means the entry stays to repeat.
      if (!(error instanceof EducateOsError && (error.code === "conflict" || error.code === "not-found"))) throw error;
    });
  }

  #draw(activity: Activity, sessionId: string, avoid: ReadonlySet<string>): string[] {
    const order = (keys: string[]) => keys.toSorted((a, b) => fnv(sessionId + a) - fnv(sessionId + b));
    const fresh = order(activity.items.map((i) => i.key).filter((k) => !avoid.has(k)));
    const repeat = order(activity.items.map((i) => i.key).filter((k) => avoid.has(k)));
    return [...fresh, ...repeat].slice(0, activity.itemsPerSession);
  }

  #practiceView(session: PracticeSession, activity: Activity): PracticeView {
    return {
      sessionId: session.id, title: activity.title, track: this.#resolve(session.ref).pack.track, mode: session.mode,
      directions: activity.directions, example: activity.example,
      ...(activity.adultGuide === undefined ? {} : { adultGuide: activity.adultGuide }),
      items: session.items.map((key) => itemOf(activity, key)),
      saved: session.responses.map((r) => r.item),
      completed: session.completedAt !== undefined,
    };
  }

  #summary(learner: Learner, session: PracticeSession, progress: readonly SkillProgress[]): SessionSummary {
    const { pack, activity, skill } = this.#resolve(session.ref);
    const current = currentPacks(this.#packs).find((p) => p.id === pack.id) ?? pack;
    const next = nextAfter(current, activity.key, progress.filter((p) => p.track === pack.track));
    return {
      id: session.id, ref: session.ref, title: activity.title, track: pack.track, skillTitle: skill.title, mode: session.mode,
      startedAt: session.startedAt, ...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
      answered: session.responses.length, of: session.items.length,
      independent: session.responses.filter((r) => r.independent).length,
      note: sessionNote(learner, session, next),
    };
  }

  async #queueView(family: FamilyRecord, learnerId: string): Promise<QueueEntryView[]> {
    const views: QueueEntryView[] = [];
    for (const entry of family.queues[learnerId] ?? []) {
      const { pack, activity } = this.#resolve(entry.ref);
      const open = await this.#store.openSession(LearnerId.parse(learnerId), entry.ref);
      views.push({ id: entry.id, ref: entry.ref, title: activity.title, track: pack.track, mode: activity.mode, minutes: activity.minutes, paused: entry.paused, inProgress: open !== undefined });
    }
    return views;
  }

  async #view(family: FamilyRecord): Promise<FamilyView> {
    const queues: Record<string, QueueEntryView[]> = {};
    for (const learner of family.learners) queues[learner.id] = await this.#queueView(family, learner.id);
    const locked = family.pin.lockedUntil !== undefined && Date.parse(family.pin.lockedUntil) > this.#now().getTime();
    return { id: family.id, name: family.name, learners: family.learners, queues, shelf: family.shelf, pinLocked: locked };
  }

  #resolve(ref: ActivityRef) {
    return resolveActivity(ref, this.#packs);
  }

  #pack(track: Track): Pack {
    return currentPackFor(track, this.#packs);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #familyRef(id?: string): ResourceRef {
    return { kind: "family", ...(id === undefined ? {} : { id }), scope: { level: "district", districtId: this.#districtId }, classification: "personal-private" };
  }

  #practiceRef(learnerId: string): ResourceRef {
    return { kind: "home-practice", id: learnerId, scope: { level: "district", districtId: this.#districtId }, classification: "personal-private" };
  }

  async #require(subject: VerifiedPrincipal, action: Action, resource: ResourceRef): Promise<void> {
    const decision = await this.#authorizer.authorize({ subject, action, resource, context: { channel: "http" } });
    if (decision.effect !== "allow") throw resource.id === undefined ? new EducateOsError("forbidden", "Home learning isn't available to your account.") : notFound();
  }

  async #familyIdOf(subject: VerifiedPrincipal): Promise<FamilyId> {
    const id = await this.#store.familyOfAdult(subject.principalId);
    if (id === undefined) throw new EducateOsError("not-found", "Set up your family first.");
    return id;
  }

  async #read(subject: VerifiedPrincipal, action: Action, familyId: FamilyId): Promise<FamilyRecord> {
    await this.#require(subject, action, this.#familyRef(familyId));
    const family = await this.#store.loadFamily(familyId);
    if (family === undefined) throw notFound();
    return family;
  }

  async #learner(subject: VerifiedPrincipal, learnerId: LearnerId, action: Action): Promise<{ learner: Learner; family: FamilyRecord }> {
    await this.#require(subject, action, this.#practiceRef(learnerId));
    const familyId = await this.#store.familyOfLearner(learnerId);
    const family = familyId === undefined ? undefined : await this.#store.loadFamily(familyId);
    const learner = family?.learners.find((l) => l.id === learnerId);
    if (family === undefined || learner === undefined) throw notFound();
    return { learner, family };
  }

  async #sessionOf(learnerId: string, sessionId: unknown): Promise<PracticeSession> {
    const session = await this.#store.getSession(PracticeSessionId.parse(sessionId));
    if (session === undefined || session.learnerId !== learnerId) throw notFound();
    return session;
  }

  async #change(subject: VerifiedPrincipal, update: (family: FamilyRecord) => FamilyRecord): Promise<FamilyView> {
    const familyId = await this.#familyIdOf(subject);
    const family = await this.#read(subject, "update", familyId);
    const next = { ...update(family), revision: family.revision + 1 };
    await this.#store.commitFamily(next, family.revision);
    return this.#view(next);
  }

  async #changeForLearner(subject: VerifiedPrincipal, learnerId: LearnerId, action: Action, update: (family: FamilyRecord) => FamilyRecord): Promise<FamilyRecord> {
    const { family } = await this.#learner(subject, learnerId, action);
    await this.#require(subject, "update", this.#familyRef(family.id));
    const next = { ...update(family), revision: family.revision + 1 };
    await this.#store.commitFamily(next, family.revision);
    return next;
  }
}
