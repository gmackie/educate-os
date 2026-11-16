// The records of home learning (ADR-0016). A family is one document, changed over a revision: its
// adults, its children's learner profiles, each child's practice queue, and its resource shelf.
// Practice sessions are separate records, one per activity a child worked, holding the responses
// saved in it and any corrections an adult made later. A child session (the shared-device lock) is
// a third record, found by the digest of the token its cookie carries.
//
// A child's profile holds a display name, an avatar, a grade band and two starting points: no
// birth date, no school, no photo. Responses are structured answers; the app records no audio.
import { z } from "zod";
import { DistrictId, FamilyId, LearnerId, PrincipalId } from "@educateos/contracts";
import { ActivityKey, ActivityMode, ActivityRef, GradeBand, ItemKey } from "./content/schema.ts";
import { ScoredResponse } from "./scoring.ts";

const Timestamp = z.iso.datetime({ offset: true });

/** Identifies one entry in a child's practice queue. */
export const QueueEntryId = z.string().regex(/^hqe_[a-z0-9]{1,64}$/, "expected a queue entry ID");
/** A queue entry identifier. */
export type QueueEntryId = z.infer<typeof QueueEntryId>;

/** Identifies one practice session. */
export const PracticeSessionId = z.string().regex(/^hps_[a-z0-9]{1,64}$/, "expected a practice session ID");
/** A practice session identifier. */
export type PracticeSessionId = z.infer<typeof PracticeSessionId>;

/** Identifies one item on a family's resource shelf. */
export const ShelfItemId = z.string().regex(/^hsi_[a-z0-9]{1,64}$/, "expected a shelf item ID");
/** A shelf item identifier. */
export type ShelfItemId = z.infer<typeof ShelfItemId>;

/** The avatars a child may pick: pictures, never photos. */
export const LEARNER_AVATARS = ["🦊", "🐢", "🦉", "🐙", "🦁", "🐼", "🐸", "🦋", "🐳", "🦄", "🐝", "🚀"] as const;
/** A learner avatar. */
export const LearnerAvatar = z.enum(LEARNER_AVATARS);
/** A learner avatar. */
export type LearnerAvatar = z.infer<typeof LearnerAvatar>;

/** A name a family uses for a child or for itself: short, plain text. */
export const DisplayName = z.string().trim().min(1).max(40).refine((s) => !/[<>]/.test(s), "use plain text");

/** One child's learner profile. */
export const Learner = z.strictObject({
  id: LearnerId,
  displayName: DisplayName,
  avatar: LearnerAvatar,
  /** A starting suggestion, never a ceiling. */
  gradeBand: GradeBand,
  /** Where each track starts, by activity key in that track's current pack. */
  starts: z.strictObject({ reading: ActivityKey, math: ActivityKey }),
  createdAt: Timestamp,
});
/** A learner. */
export type Learner = z.infer<typeof Learner>;

/** One activity waiting in a child's queue, pinned to the pack version it was added from. */
export const QueueEntry = z.strictObject({
  id: QueueEntryId,
  ref: ActivityRef,
  addedAt: Timestamp,
  addedBy: PrincipalId,
  /** A paused entry stays in place but isn't offered to the child. */
  paused: z.boolean(),
});
/** A queue entry. */
export type QueueEntry = z.infer<typeof QueueEntry>;

/** The most activities one child's queue holds. */
export const MAX_QUEUE = 30;
/** The most children one family holds. */
export const MAX_LEARNERS = 8;
/** The most adults one family holds. */
export const MAX_ADULTS = 4;
/** The most items one family's shelf holds. */
export const MAX_SHELF = 200;

/**
 * Something a family keeps for reference: a book, a link, a worksheet or a note. Shelf items are
 * never practice: nothing on the shelf produces evidence or counts toward progress.
 */
export const ShelfItem = z.strictObject({
  id: ShelfItemId,
  kind: z.enum(["book", "link", "worksheet", "note"]),
  title: z.string().trim().min(1).max(120),
  /** An https link, for a link or an online worksheet. */
  url: z.url({ protocol: /^https$/ }).max(2000).optional(),
  note: z.string().trim().max(1000).optional(),
  /** The children it's for; empty means the whole family. */
  learnerIds: z.array(LearnerId).max(MAX_LEARNERS),
  addedAt: Timestamp,
  addedBy: PrincipalId,
});
/** A shelf item. */
export type ShelfItem = z.infer<typeof ShelfItem>;

/**
 * The family's adult PIN, as stored: a PBKDF2-SHA-256 hash, never the PIN. An adult enters it to
 * end a child session on a shared device. Repeated failures lock it for a while.
 */
export const StoredPin = z.strictObject({
  salt: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  hash: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  iterations: z.int().min(10_000).max(100_000),
  failures: z.int().min(0).max(1000),
  lockedUntil: Timestamp.optional(),
});
/** A stored PIN. */
export type StoredPin = z.infer<typeof StoredPin>;

/** One adult of a family. Every adult sees and manages the whole family's home learning. */
export const FamilyAdult = z.strictObject({
  principalId: PrincipalId,
  /** Their name as the directory had it when they joined, for the other adults to recognize. */
  displayName: DisplayName.optional(),
  joinedAt: Timestamp,
  /** The family notice they last accepted. Absent in records from before the notice existed. */
  noticeAccepted: z.strictObject({ version: z.string().min(1).max(32), at: Timestamp }).optional(),
});
/** A family adult. */
export type FamilyAdult = z.infer<typeof FamilyAdult>;

/** Identifies an invitation for another adult to join a family. */
export const AdultInvitationId = z.string().regex(/^hai_[a-z0-9]{1,64}$/, "expected an invitation ID");
/** An adult invitation identifier. */
export type AdultInvitationId = z.infer<typeof AdultInvitationId>;

/**
 * An invitation for another adult to join the family: single use, expiring, stored as the SHA-256
 * digest of its token. Whoever redeems it while signed in becomes an adult of the family with the
 * same access as the inviter, so it is shared only with the person meant to join.
 */
export const AdultInvitation = z.strictObject({
  id: AdultInvitationId,
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  createdBy: PrincipalId,
});
/** An adult invitation. */
export type AdultInvitation = z.infer<typeof AdultInvitation>;

/** A family, as stored. */
export const FamilyRecord = z.strictObject({
  id: FamilyId,
  districtId: DistrictId,
  name: DisplayName,
  adults: z.array(FamilyAdult).min(1).max(MAX_ADULTS),
  learners: z.array(Learner).max(MAX_LEARNERS),
  /** Each child's queue, by learner ID. */
  queues: z.record(z.string(), z.array(QueueEntry).max(MAX_QUEUE)),
  shelf: z.array(ShelfItem).max(MAX_SHELF),
  /** Open invitations for more adults. Absent in records from before invitations existed. */
  invitations: z.array(AdultInvitation).max(MAX_ADULTS).default([]),
  /** Whether a child's practice screen reads directions and words aloud with the browser's speech. */
  readAloud: z.boolean().default(true),
  pin: StoredPin,
  createdAt: Timestamp,
  revision: z.int().min(1),
}).superRefine((family, ctx) => {
  const learners = new Set<string>(family.learners.map((l) => l.id));
  for (const id of Object.keys(family.queues)) {
    if (!learners.has(id)) ctx.addIssue({ code: "custom", message: `a queue names unknown learner ${id}` });
  }
  if (new Set(family.adults.map((a) => a.principalId)).size !== family.adults.length) ctx.addIssue({ code: "custom", message: "adults must be unique" });
});
/** A family record. */
export type FamilyRecord = z.infer<typeof FamilyRecord>;

/**
 * An adult's later correction of one response's evidence, kept beside the original: the response
 * itself never changes. The latest correction for an item is the one progress reads.
 */
export const EvidenceCorrection = z.strictObject({
  item: ItemKey,
  at: Timestamp,
  by: PrincipalId,
  /** `exclude` removes the response from progress (a sibling answered, the device misread a tap). */
  verdict: z.enum(["independent", "with-help", "incorrect", "exclude"]),
});
/** An evidence correction. */
export type EvidenceCorrection = z.infer<typeof EvidenceCorrection>;

/** One practice session: one child, one pinned activity, the items drawn for it and what was saved. */
export const PracticeSession = z.strictObject({
  id: PracticeSessionId,
  familyId: FamilyId,
  learnerId: LearnerId,
  ref: ActivityRef,
  mode: ActivityMode,
  /** The items drawn from the pool, in the order the child sees them. */
  items: z.array(ItemKey).min(1).max(10),
  /** The queue entry it was started from, if any. */
  queueEntryId: QueueEntryId.optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),
  responses: z.array(ScoredResponse).max(10),
  corrections: z.array(EvidenceCorrection).max(100),
  /** Bumped on every write; a save is applied only over the version it read. */
  version: z.int().min(1),
});
/** A practice session. */
export type PracticeSession = z.infer<typeof PracticeSession>;

/**
 * A child session: while its token's cookie is on a browser, that browser can only practice as
 * this child, and adult pages refuse it until an adult ends it with the family PIN (or from
 * another device). Only the token's SHA-256 digest is stored.
 */
export const ChildSession = z.strictObject({
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  familyId: FamilyId,
  learnerId: LearnerId,
  /** The adult who started it: the only account whose requests it applies to. */
  startedBy: PrincipalId,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
/** A child session. */
export type ChildSession = z.infer<typeof ChildSession>;

/**
 * How long a child session's cookie lasts. A child session older than this can no longer be
 * presented by any browser, so the scheduled purge deletes it.
 */
export const CHILD_SESSION_MAX_DAYS = 30;
