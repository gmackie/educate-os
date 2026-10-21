// G01's side of the workspace directory's `course-ai-funding.cancelled` events: draining them
// idempotently into a record of cancelled course funding, and a governance source that applies the
// record. The ledger itself is unchanged; it reads the record through the source it already takes.
import { z } from "zod";
import {
  OfferingId,
  PrincipalId,
  TermId,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import type { AiGovernanceSource } from "./ledger.ts";
import type { TermClosedEvent } from "./pools.ts";

/**
 * The event W01 emits when it revokes course grants. It is defined here until the workspace
 * directory publishes it, like `TermClosedEvent`. `principalIds` lists the students whose course
 * funding ends; a term-close event may list none, since the whole term's funding ends.
 */
export const CourseFundingCancelledEvent = z.strictObject({
  type: z.literal("course-ai-funding.cancelled"),
  offeringId: OfferingId,
  termId: TermId,
  principalIds: z.array(PrincipalId),
  reason: z.enum(["term-closed", "roster-dropped"]),
  occurredAt: z.iso.datetime(),
});
/** A course-funding cancellation event. */
export type CourseFundingCancelledEvent = z.infer<typeof CourseFundingCancelledEvent>;

/** What G01 has drained from the workspace directory's outbox. */
export const CourseFundingCancellations = z.strictObject({
  /** How many outbox events have been drained. The outbox is append-only, so this is a read position. */
  drained: z.int().nonnegative(),
  /** Students whose funding from an offering is cancelled, until the directory enrolls them again. */
  cancelled: z.array(z.strictObject({ offeringId: OfferingId, principalId: PrincipalId, cancelledAt: z.iso.datetime() })),
  /** Terms whose course funding the outbox ended. */
  closedTerms: z.array(z.strictObject({ termId: TermId, closedAt: z.iso.datetime() })),
});
/** Drained course-funding cancellations. */
export type CourseFundingCancellations = z.infer<typeof CourseFundingCancellations>;

/** The record before anything has been drained. */
export const NO_FUNDING_CANCELLATIONS: CourseFundingCancellations = { drained: 0, cancelled: [], closedTerms: [] };

/** Identifies one student's funding from one offering. */
function key(offeringId: string, principalId: string): string {
  return `${offeringId} ${principalId}`;
}

/**
 * Drains the outbox's events after position `record.drained` into the record, and returns the
 * record to keep and how many events were new. Draining is idempotent: the same outbox drains to
 * the same record, an event already drained changes nothing, and a cancellation already recorded is
 * not recorded twice.
 *
 * `directory` is the directory as committed by the roster apply that emitted the events. A
 * cancellation is lifted once it shows the student actively enrolled in the offering again (the
 * workspace directory then reissues their grants), so a student dropped and re-added is funded
 * again; one it does not show enrolled stays cancelled even if a stale snapshot elsewhere still
 * lists the enrollment.
 */
export function drainCourseFundingCancellations(
  record: CourseFundingCancellations,
  outbox: readonly unknown[],
  directory: DistrictDirectorySnapshot,
): { next: CourseFundingCancellations; drained: number } {
  const current = CourseFundingCancellations.parse(record);
  const fresh = z.array(CourseFundingCancelledEvent).parse(outbox.slice(current.drained));
  const cancelled = new Map(current.cancelled.map((c) => [key(c.offeringId, c.principalId), c]));
  const closedTerms = new Map(current.closedTerms.map((t) => [t.termId as string, t]));
  for (const event of fresh) {
    for (const principalId of event.principalIds) {
      const k = key(event.offeringId, principalId);
      if (!cancelled.has(k)) cancelled.set(k, { offeringId: event.offeringId, principalId, cancelledAt: event.occurredAt });
    }
    if (event.reason === "term-closed" && !closedTerms.has(event.termId)) {
      closedTerms.set(event.termId, { termId: event.termId, closedAt: event.occurredAt });
    }
  }
  const enrolled = new Set(directory.enrollments
    .filter((e) => e.status === "active" && e.role === "student")
    .map((e) => key(e.offeringId, e.principalId)));
  return {
    next: {
      drained: current.drained + fresh.length,
      cancelled: [...cancelled].filter(([k]) => !enrolled.has(k)).map(([, c]) => c),
      closedTerms: [...closedTerms.values()],
    },
    drained: fresh.length,
  };
}

/**
 * A governance source that applies drained cancellations on top of `source`: a cancelled student's
 * enrollment in the offering reads as inactive, so the ledger denies their course requests there
 * as `not-enrolled`, and a term the outbox closed reads as closed. Everything else is `source`'s.
 */
export function withCourseFundingCancellations(
  source: AiGovernanceSource,
  read: () => Promise<CourseFundingCancellations>,
): AiGovernanceSource {
  return {
    effectivePolicy: (scope) => source.effectivePolicy(scope),
    fundingPools: () => source.fundingPools(),
    modelCatalog: () => source.modelCatalog(),
    async directory() {
      const [snapshot, record] = await Promise.all([source.directory(), read()]);
      const cancelled = new Set(record.cancelled.map((c) => key(c.offeringId, c.principalId)));
      if (cancelled.size === 0) return snapshot;
      return {
        ...snapshot,
        enrollments: snapshot.enrollments.map((e) =>
          e.status === "active" && cancelled.has(key(e.offeringId, e.principalId)) ? { ...e, status: "inactive" as const } : e
        ),
      };
    },
    async termClosures() {
      const [closures, record] = await Promise.all([source.termClosures(), read()]);
      const known = new Set(closures.map((c) => c.termId as string));
      const districtId = (await source.directory()).district.id;
      const added: TermClosedEvent[] = record.closedTerms
        .filter((t) => !known.has(t.termId))
        .map((t) => ({ type: "term.closed", districtId, termId: t.termId, closedAt: t.closedAt }));
      return [...closures, ...added];
    },
  };
}
