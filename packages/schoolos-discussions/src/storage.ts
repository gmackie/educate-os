// Where an offering's discussions are kept. A change is a write of the records it touched, applied
// over the board revision it was made against, so two teachers moderating at once cannot lose one
// another's work.
import { SchoolOsError, type OfferingId } from "@schoolos/contracts";
import { DiscussionBoard, type DiscussionPost, type DiscussionSettings, type DiscussionTopic, type ModerationEvent } from "./model.ts";

/** What one change writes to a board: its settings, the topics and posts it added or changed, and the trail entries it appended. */
export interface BoardWrite {
  /** The board's next revision: one more than the revision the change was made against. */
  revision: number;
  settings: DiscussionSettings;
  /** Topics added or changed, whole. */
  topics: readonly DiscussionTopic[];
  /** Topics deleted, with every post in them. */
  deletedTopicIds: readonly string[];
  /** Posts added or changed, whole. */
  posts: readonly DiscussionPost[];
  /** Entries appended to the moderation trail. */
  moderation: readonly ModerationEvent[];
}

/**
 * Where each offering's discussions are kept. A commit applies a write only if the board's
 * revision is still the one the change was made against.
 */
export interface DiscussionStorage {
  /** The offering's board, or undefined if nothing has been stored for it. */
  load(offeringId: OfferingId): Promise<DiscussionBoard | undefined>;
  /**
   * Applies `write` to the offering's board.
   *
   * @throws SchoolOsError `conflict` if the stored revision is not `expectedRevision`.
   */
  commit(offeringId: OfferingId, write: BoardWrite, expectedRevision: number): Promise<void>;
}

/** The message a conflicting commit fails with. */
export const DISCUSSION_CONFLICT = "The discussion changed while this request was in progress; reload it and try again.";

/** Applies a write to a board as stored (the in-memory and the durable stores apply it alike). */
export function applyBoardWrite(board: DiscussionBoard, write: BoardWrite): DiscussionBoard {
  const deleted = new Set(write.deletedTopicIds);
  const topics = new Map(board.topics.filter((t) => !deleted.has(t.id)).map((t) => [t.id, t]));
  for (const topic of write.topics) topics.set(topic.id, topic);
  const posts = new Map(board.posts.filter((p) => !deleted.has(p.topicId)).map((p) => [p.id, p]));
  for (const post of write.posts) posts.set(post.id, post);
  return DiscussionBoard.parse({
    offeringId: board.offeringId,
    revision: write.revision,
    settings: write.settings,
    topics: [...topics.values()],
    posts: [...posts.values()],
    moderation: [...board.moderation, ...write.moderation],
  });
}

/** An offering's board before anything is stored. */
export const emptyBoard = (offeringId: OfferingId): DiscussionBoard => ({
  offeringId,
  revision: 0,
  settings: { premoderation: false },
  topics: [],
  posts: [],
  moderation: [],
});

/** {@link DiscussionStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryDiscussionStorage implements DiscussionStorage {
  readonly #boards = new Map<string, DiscussionBoard>();

  async load(offeringId: OfferingId): Promise<DiscussionBoard | undefined> {
    const board = this.#boards.get(offeringId);
    return board === undefined ? undefined : structuredClone(board);
  }

  async commit(offeringId: OfferingId, write: BoardWrite, expectedRevision: number): Promise<void> {
    const current = this.#boards.get(offeringId) ?? emptyBoard(offeringId);
    if (current.revision !== expectedRevision) throw new SchoolOsError("conflict", DISCUSSION_CONFLICT);
    this.#boards.set(offeringId, structuredClone(applyBoardWrite(current, write)));
  }
}
