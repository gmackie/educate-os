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
  PrincipalId,
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
  AdultInvitationId,
  CHILD_SESSION_MAX_DAYS,
  DisplayName,
  MAX_ADULTS,
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
import { FAMILY_NOTICE_VERSION, familyNotice, type FamilyNotice } from "./notice.ts";

/** What the service is built from. */
export interface HomeLearningServiceOptions {
  store: HomeLearningStore;
  /** The district's policy engine, auditing under the request's correlation ID. */
  authorizer: Authorizer;
  districtId: DistrictId;
  now?: () => Date;
  /** The shipped packs; tests may pass others. */
  packs?: readonly Pack[];
  /**
   * How many days a practice session is kept after it started; {@link HomeLearningService.purgeExpired}
   * deletes older ones. Undefined keeps them until the family deletes them.
   */
  retentionDays?: number;
  /** Who runs the installation and how to reach them, as the family notice states it. */
  operator?: { name: string; contact?: string };
}

/** How long an invitation for another adult stays usable. */
export const ADULT_INVITATION_DAYS = 7;

/** How long an ended child session's record is kept before the scheduled purge deletes it. */
export const ENDED_CHILD_SESSION_KEEP_DAYS = 1;

/** What one scheduled purge deleted. */
export interface HomeLearningPurge {
  /** Practice sessions past the retention period; absent where the installation keeps them. */
  practiceSessions?: { deleted: number; before: string };
  /** Child sessions that ended, or whose cookie can no longer be presented. */
  childSessions: number;
  /** Expired invitations for another adult. */
  invitations: number;
}

const DAY_MS = 86_400_000;

// Inputs

/** The notice version an adult accepted, which must be the current one. */
export const NoticeAcceptance = z.string().min(1).max(32);

/** Starting a family, having accepted the current notice. */
export const CreateFamilyInput = z.strictObject({ name: DisplayName, pin: Pin, acceptNotice: NoticeAcceptance });
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

/** A family, as its adults see it. Never carries the PIN or an invitation's token. */
export interface FamilyView {
  id: string;
  name: string;
  /** Every adult of the family, the caller marked. */
  adults: { principalId: string; displayName?: string; joinedAt: string; you: boolean }[];
  /** Open invitations for more adults. */
  invitations: { id: string; createdAt: string; expiresAt: string }[];
  /** How long practice is kept, in days; undefined until the family deletes it. */
  retentionDays?: number;
  /** Whether the child's practice screen reads aloud. */
  readAloud: boolean;
  learners: Learner[];
  queues: Record<string, QueueEntryView[]>;
  shelf: ShelfItem[];
  pinLocked: boolean;
}

/** The home page's answer: the adult's family, or none yet. */
export interface HomeView {
  family: FamilyView | null;
  /** The current family notice, with this installation's facts. */
  notice: FamilyNotice;
  /** Whether the caller has accepted this version of it. */
  noticeAccepted: boolean;
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
  /** Whether the family lets the practice screen read aloud. */
  readAloud: boolean;
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

/** An adult's stored name, when the directory gave one that fits. */
const adultName = (displayName: string | undefined) => {
  const parsed = DisplayName.safeParse(displayName);
  return parsed.success ? { displayName: parsed.data } : {};
};

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
  readonly #retentionDays: number | undefined;
  readonly #notice: FamilyNotice;

  constructor(options: HomeLearningServiceOptions) {
    this.#store = options.store;
    this.#authorizer = options.authorizer;
    this.#districtId = options.districtId;
    this.#now = options.now ?? (() => new Date());
    this.#packs = options.packs ?? PACKS;
    this.#retentionDays = options.retentionDays;
    this.#notice = familyNotice({
      operator: options.operator?.name ?? "this community's organizers",
      ...(options.operator?.contact === undefined ? {} : { contact: options.operator.contact }),
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    });
  }

  /** The current family notice, with this installation's facts. */
  notice(): FamilyNotice {
    return structuredClone(this.#notice);
  }

  // Family

  /** The adult's family, or none yet. */
  async home(subject: VerifiedPrincipal): Promise<HomeView> {
    const familyId = await this.#store.familyOfAdult(subject.principalId);
    if (familyId === undefined) return { family: null, notice: this.notice(), noticeAccepted: false };
    const family = await this.#read(subject, "read", familyId);
    const accepted = family.adults.find((a) => a.principalId === subject.principalId)?.noticeAccepted?.version === FAMILY_NOTICE_VERSION;
    return { family: await this.#view(family, subject), notice: this.notice(), noticeAccepted: accepted };
  }

  /**
   * Records that the adult accepted the current notice.
   *
   * @throws EducateOsError `validation-failed` if `version` isn't the current notice's.
   */
  async acceptNotice(subject: VerifiedPrincipal, version: unknown): Promise<HomeView> {
    const accepted = this.#acceptance(version);
    await this.#change(subject, (family) => ({
      ...family,
      adults: family.adults.map((a) => (a.principalId === subject.principalId ? { ...a, noticeAccepted: accepted } : a)),
    }));
    return this.home(subject);
  }

  /** Turns the practice screen's reading aloud on or off for every child of the family. */
  async setReadAloud(subject: VerifiedPrincipal, on: unknown): Promise<FamilyView> {
    const parsed = z.boolean().parse(on);
    return this.#change(subject, (family) => ({ ...family, readAloud: parsed }));
  }

  /**
   * Starts a family with the adult as its first member.
   *
   * @throws EducateOsError `conflict` if the adult already has one.
   */
  async createFamily(subject: VerifiedPrincipal, input: unknown, displayName?: string): Promise<FamilyView> {
    const { name, pin, acceptNotice } = CreateFamilyInput.parse(input);
    const accepted = this.#acceptance(acceptNotice);
    await this.#require(subject, "create", this.#familyRef());
    if (await this.#store.familyOfAdult(subject.principalId) !== undefined) {
      throw new EducateOsError("conflict", "You already have a family here.");
    }
    const at = this.#iso();
    const family: FamilyRecord = {
      id: FamilyId.parse(`fam_${idBody()}`),
      districtId: this.#districtId,
      name,
      adults: [{ principalId: subject.principalId, ...adultName(displayName), joinedAt: at, noticeAccepted: accepted }],
      learners: [],
      queues: {},
      shelf: [],
      invitations: [],
      readAloud: true,
      pin: await hashPin(pin),
      createdAt: at,
      revision: 1,
    };
    await this.#store.commitFamily(family, undefined);
    return this.#view(family, subject);
  }

  // Adults

  /**
   * Invites another adult. Returns the token once; only its digest is kept. Whoever redeems it
   * while signed in joins with the same access as every other adult of the family.
   *
   * @throws EducateOsError `conflict` if the family's adults and open invitations are at the limit.
   */
  async inviteAdult(subject: VerifiedPrincipal): Promise<{ token: string; id: string; expiresAt: string }> {
    const now = this.#now();
    const id = AdultInvitationId.parse(`hai_${idBody()}`);
    const familyId = await this.#familyIdOf(subject);
    const token = `${familyId}.${newToken()}`;
    const expiresAt = new Date(now.getTime() + ADULT_INVITATION_DAYS * 86_400_000).toISOString();
    const digest = await tokenDigest(token);
    await this.#change(subject, (family) => {
      const open = family.invitations.filter((i) => Date.parse(i.expiresAt) > now.getTime());
      if (family.adults.length + open.length >= MAX_ADULTS) {
        throw new EducateOsError("conflict", `A family can have up to ${MAX_ADULTS} grown-ups, counting open invitations.`);
      }
      return { ...family, invitations: [...open, { id, digest, createdAt: now.toISOString(), expiresAt, createdBy: subject.principalId }] };
    });
    return { token, id, expiresAt };
  }

  /** Withdraws an open invitation. */
  async revokeInvitation(subject: VerifiedPrincipal, invitationId: unknown): Promise<FamilyView> {
    const id = AdultInvitationId.parse(invitationId);
    return this.#change(subject, (family) => {
      if (!family.invitations.some((i) => i.id === id)) throw notFound();
      return { ...family, invitations: family.invitations.filter((i) => i.id !== id) };
    });
  }

  /**
   * Joins the family an invitation names. Every refusal of a token (unknown, expired, used, or a
   * family that no longer exists) is the same `not-found`.
   *
   * @throws EducateOsError `conflict` if the caller already belongs to a family.
   */
  async acceptInvitation(subject: VerifiedPrincipal, token: unknown, acceptNotice: unknown, displayName?: string): Promise<FamilyView> {
    const accepted = this.#acceptance(acceptNotice);
    await this.#require(subject, "create", this.#familyRef());
    if (await this.#store.familyOfAdult(subject.principalId) !== undefined) {
      throw new EducateOsError("conflict", "You already belong to a family here. Leave it first to join another.");
    }
    const invalid = () => new EducateOsError("not-found", "This invitation can't be used. Ask for a new one.");
    if (typeof token !== "string" || token.length > 200) throw invalid();
    const familyId = FamilyId.safeParse(token.split(".")[0]).data;
    const family = familyId === undefined ? undefined : await this.#store.loadFamily(familyId);
    if (family === undefined) throw invalid();
    const digest = await tokenDigest(token);
    const now = this.#now();
    const invitation = family.invitations.find((i) => i.digest === digest && Date.parse(i.expiresAt) > now.getTime());
    if (invitation === undefined) throw invalid();
    if (family.adults.length >= MAX_ADULTS) throw new EducateOsError("conflict", `A family can have up to ${MAX_ADULTS} grown-ups.`);
    const next: FamilyRecord = {
      ...family,
      adults: [...family.adults, { principalId: subject.principalId, ...adultName(displayName), joinedAt: now.toISOString(), noticeAccepted: accepted }],
      invitations: family.invitations.filter((i) => i.id !== invitation.id),
      revision: family.revision + 1,
    };
    await this.#store.commitFamily(next, family.revision);
    // Read back through policy, so the new adult's first view is audited under the family.
    return (await this.home(subject)).family!;
  }

  /**
   * Removes an adult from the family: oneself (leaving), or another adult. The last adult can't
   * leave; they delete the family instead. Child sessions the removed adult started end.
   */
  async removeAdult(subject: VerifiedPrincipal, principalId: unknown): Promise<HomeView> {
    const id = PrincipalId.parse(principalId);
    const familyId = await this.#familyIdOf(subject);
    await this.#change(subject, (family) => {
      if (!family.adults.some((a) => a.principalId === id)) throw notFound();
      if (family.adults.length === 1) throw new EducateOsError("conflict", "The last grown-up can't leave. Delete the family instead.");
      return { ...family, adults: family.adults.filter((a) => a.principalId !== id) };
    }, id === subject.principalId);
    await this.#store.endChildSessionsOf(familyId, this.#iso(), id);
    return this.home(subject);
  }

  /**
   * The family's part of deleting an adult's account: they leave the family, or, as its last adult,
   * delete it with all its children's practice. Returns whether the family was deleted. The caller
   * then removes the adult's sign-in from the installation's directory.
   */
  async leaveForAccountDeletion(subject: VerifiedPrincipal): Promise<{ familyDeleted: boolean }> {
    const familyId = await this.#store.familyOfAdult(subject.principalId);
    if (familyId === undefined) return { familyDeleted: false };
    const family = await this.#read(subject, "update", familyId);
    if (family.adults.length === 1) {
      await this.deleteFamily(subject);
      return { familyDeleted: true };
    }
    await this.removeAdult(subject, subject.principalId);
    return { familyDeleted: false };
  }

  /**
   * The scheduled purge, across every family: practice sessions older than the retention period
   * (where one is set), child sessions that ended or can no longer be presented, and expired
   * invitations. A system job: it reads no family on anyone's behalf, only prunes by age.
   */
  async purgeExpired(): Promise<HomeLearningPurge> {
    const now = this.#now().getTime();
    const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
    let practiceSessions: HomeLearningPurge["practiceSessions"];
    if (this.#retentionDays !== undefined) {
      const before = ago(this.#retentionDays);
      practiceSessions = { deleted: await this.#store.deleteSessionsStartedBefore(before), before };
    }
    const childSessions = await this.#store.deleteChildSessions(ago(ENDED_CHILD_SESSION_KEEP_DAYS), ago(CHILD_SESSION_MAX_DAYS));
    let invitations = 0;
    for (const id of await this.#store.familyIds()) {
      const family = await this.#store.loadFamily(id);
      const open = family?.invitations.filter((i) => Date.parse(i.expiresAt) > now);
      if (family === undefined || open === undefined || open.length === family.invitations.length) continue;
      // A family changed meanwhile keeps its expired invitations until the next run.
      await this.#store.commitFamily({ ...family, invitations: open, revision: family.revision + 1 }, family.revision).then(
        () => { invitations += family.invitations.length - open.length; },
        (error: unknown) => { if (!(error instanceof EducateOsError && error.code === "conflict")) throw error; },
      );
    }
    return { ...(practiceSessions === undefined ? {} : { practiceSessions }), childSessions, invitations };
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
      readAloud: family.readAloud,
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

  async #view(family: FamilyRecord, subject: VerifiedPrincipal): Promise<FamilyView> {
    const queues: Record<string, QueueEntryView[]> = {};
    for (const learner of family.learners) queues[learner.id] = await this.#queueView(family, learner.id);
    const locked = family.pin.lockedUntil !== undefined && Date.parse(family.pin.lockedUntil) > this.#now().getTime();
    const now = this.#now().getTime();
    return {
      id: family.id,
      name: family.name,
      adults: family.adults.map((a) => ({ principalId: a.principalId, ...(a.displayName === undefined ? {} : { displayName: a.displayName }), joinedAt: a.joinedAt, you: a.principalId === subject.principalId })),
      invitations: family.invitations.filter((i) => Date.parse(i.expiresAt) > now).map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt })),
      ...(this.#retentionDays === undefined ? {} : { retentionDays: this.#retentionDays }),
      readAloud: family.readAloud,
      learners: family.learners,
      queues,
      shelf: family.shelf,
      pinLocked: locked,
    };
  }

  #acceptance(version: unknown): { version: string; at: string } {
    if (version !== FAMILY_NOTICE_VERSION) {
      throw new EducateOsError("validation-failed", "The notice about your family's information has changed. Read it again, then accept it.");
    }
    return { version: FAMILY_NOTICE_VERSION, at: this.#iso() };
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

  async #change(subject: VerifiedPrincipal, update: (family: FamilyRecord) => FamilyRecord, leaving = false): Promise<FamilyView> {
    const familyId = await this.#familyIdOf(subject);
    const family = await this.#read(subject, "update", familyId);
    const next = { ...update(family), revision: family.revision + 1 };
    await this.#store.commitFamily(next, family.revision);
    return leaving ? this.#view(family, subject) : this.#view(next, subject);
  }

  async #changeForLearner(subject: VerifiedPrincipal, learnerId: LearnerId, action: Action, update: (family: FamilyRecord) => FamilyRecord): Promise<FamilyRecord> {
    const { family } = await this.#learner(subject, learnerId, action);
    await this.#require(subject, "update", this.#familyRef(family.id));
    const next = { ...update(family), revision: family.revision + 1 };
    await this.#store.commitFamily(next, family.revision);
    return next;
  }
}
