import { SchoolOsError } from "@schoolos/contracts";
import { R2_CONTENT_PREFIX, type InlineTextTable, type R2BucketLike, type StoredContent } from "./content.ts";
import type { ArtifactState, SweepingContent } from "./model.ts";
import type { ArtifactRecordStore } from "./store.ts";

/** What an {@link ArtifactContentSweeper} is built from. */
export interface ArtifactContentSweeperOptions {
  /** The district's artifact records, which say what content is referenced. */
  records: ArtifactRecordStore;
  /** The district's inline text table. */
  text: InlineTextTable;
  /** The district's R2 bucket. */
  r2: R2BucketLike;
  /**
   * How long new content is left alone. Content is written before the revision that references it
   * is committed, so a save in flight holds content nothing references yet; the grace period keeps
   * the sweep from deleting it under the save (which would then have to write it again).
   */
  gracePeriodMs: number;
  /** The most content one batch marks, deletes and releases. */
  batchSize?: number;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** What one {@link ArtifactContentSweeper.sweep} deleted. */
export interface SweepResult {
  /** Inline text rows deleted. */
  text: number;
  /** R2 objects deleted. */
  r2: number;
}

/** Commit attempts before one step gives up on concurrent saves and leaves the rest for the next sweep. */
const COMMIT_ATTEMPTS = 3;
const DEFAULT_BATCH_SIZE = 100;

/**
 * The content retention sweep: deletes inline text and R2 objects that no revision references,
 * which is what is left once deleted artifacts' revisions are collected. A pinned revision is never
 * collected, so the content of anything pinned (a submission, a kept version, starter material's
 * baseline) is always referenced and never swept. Registered and external content is never
 * touched: SchoolOS does not hold the one, and its provider owns the other's retention.
 *
 * It must not race a concurrent save of identical content, which would find the bytes already
 * stored, skip writing them, and commit a revision pointing at content the sweep then deletes. So
 * content is deleted in three steps per batch:
 *
 * 1. **Mark.** Commit the batch as `sweeping`, against a version of the records in which no
 *    revision references it. Content newer than the grace period is skipped.
 * 2. **Delete** it. A save that loaded the records before the mark fails its commit on the version
 *    check; one that loads them after sees the mark and is refused with `conflict`.
 * 3. **Release.** Commit the batch out of `sweeping`. A retried save then writes the content again.
 *
 * A sweep that stops part-way finishes the marked batch first on its next run. The text table and
 * bucket must hold this district's content only, since everything this district's records do not
 * reference is deleted.
 */
export class ArtifactContentSweeper {
  readonly #records: ArtifactRecordStore;
  readonly #text: InlineTextTable;
  readonly #r2: R2BucketLike;
  readonly #gracePeriodMs: number;
  readonly #batchSize: number;
  readonly #now: () => Date;

  constructor(options: ArtifactContentSweeperOptions) {
    if (!Number.isFinite(options.gracePeriodMs) || options.gracePeriodMs < 0) throw new Error("the grace period must be a non-negative number of milliseconds");
    this.#records = options.records;
    this.#text = options.text;
    this.#r2 = options.r2;
    this.#gracePeriodMs = options.gracePeriodMs;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#now = options.now ?? (() => new Date());
  }

  /** Deletes all unreferenced content older than the grace period. */
  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { text: 0, r2: 0 };
    const interrupted = (await this.#records.load()).state.sweeping ?? [];
    if (interrupted.length > 0) await this.#deleteAndRelease(interrupted, result);

    const cutoff = this.#now().getTime() - this.#gracePeriodMs;
    const old = (stored: StoredContent[]) => stored.filter((c) => c.storedAt.getTime() <= cutoff).map((c) => c.key);
    const candidates: SweepingContent[] = [
      ...old(await this.#text.list()).map((key) => ({ backend: "text" as const, key })),
      ...old(await this.#listR2()).map((key) => ({ backend: "r2" as const, key })),
    ];
    for (let start = 0; start < candidates.length; start += this.#batchSize) {
      const marked = await this.#mark(candidates.slice(start, start + this.#batchSize));
      if (marked.length > 0) await this.#deleteAndRelease(marked, result);
    }
    return result;
  }

  /** Step 1: marks those of `batch` no revision references, against the version that says so. */
  async #mark(batch: SweepingContent[]): Promise<SweepingContent[]> {
    return this.#change((state) => {
      const referenced = referencedContent(state);
      const marked = batch.filter((c) => !referenced.has(contentId(c)));
      if (marked.length === 0) return { result: [] };
      return { next: { ...state, sweeping: [...(state.sweeping ?? []), ...marked] }, result: marked };
    });
  }

  /** Steps 2 and 3: deletes marked content, then releases the marks. */
  async #deleteAndRelease(marked: SweepingContent[], result: SweepResult): Promise<void> {
    for (const content of marked) {
      if (content.backend === "text") await this.#text.delete(content.key);
      else await this.#r2.delete(content.key);
      result[content.backend] += 1;
    }
    const released = new Set(marked.map(contentId));
    await this.#change((state) => {
      const remaining = (state.sweeping ?? []).filter((c) => !released.has(contentId(c)));
      const { sweeping: _marks, ...rest } = state;
      return { next: remaining.length === 0 ? rest : { ...rest, sweeping: remaining }, result: undefined };
    });
  }

  async #listR2(): Promise<StoredContent[]> {
    const stored: StoredContent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#r2.list({ prefix: R2_CONTENT_PREFIX, ...(cursor === undefined ? {} : { cursor }) });
      stored.push(...page.objects.map((o) => ({ key: o.key, storedAt: o.uploaded })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return stored;
  }

  /** Applies one step to fresh records, committing it against the version it read. */
  async #change<T>(step: (state: ArtifactState) => { next?: ArtifactState; result: T }): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const { state, version } = await this.#records.load();
      const { next, result } = step(state);
      if (next === undefined) return result;
      try {
        await this.#records.commit(next, version);
        return result;
      } catch (error) {
        if (!(error instanceof SchoolOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }
}

function contentId(content: SweepingContent): string {
  return `${content.backend} ${content.key}`;
}

/** Every held content a stored revision points at. */
function referencedContent(state: ArtifactState): Set<string> {
  const referenced = new Set<string>();
  for (const { content } of state.revisions) {
    if (content.backend === "text" || content.backend === "r2") referenced.add(contentId({ backend: content.backend, key: content.key }));
  }
  return referenced;
}
