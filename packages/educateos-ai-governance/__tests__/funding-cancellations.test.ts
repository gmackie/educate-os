import { NORTHFIELD } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import {
  drainCourseFundingCancellations,
  NO_FUNDING_CANCELLATIONS,
  resolveFunding,
  withCourseFundingCancellations,
  type AiGovernanceSource,
  type CourseFundingCancelledEvent,
} from "../src/index.ts";
import { AMARA, BIO_FALL, CATALOG, ELENA, FLOOR, northfieldPools } from "./setup.ts";

const pools = northfieldPools();

/** Northfield with Amara dropped from fall Biology, as the roster apply committed it. */
const AFTER_DROP = {
  ...NORTHFIELD,
  enrollments: NORTHFIELD.enrollments.map((e) =>
    e.principalId === AMARA.principalId && e.offeringId === "off_nf-bio-fall-p2" ? { ...e, status: "inactive" as const } : e
  ),
};

const dropped: CourseFundingCancelledEvent = {
  type: "course-ai-funding.cancelled",
  offeringId: "off_nf-bio-fall-p2" as CourseFundingCancelledEvent["offeringId"],
  termId: "trm_nf-2026-fall" as CourseFundingCancelledEvent["termId"],
  principalIds: [AMARA.principalId],
  reason: "roster-dropped",
  occurredAt: "2026-10-20T15:00:00.000Z",
};

/** A source whose directory is stale: it still has Amara in fall Biology. */
const staleSource: AiGovernanceSource = {
  directory: async () => NORTHFIELD,
  fundingPools: async () => pools,
  termClosures: async () => [],
  modelCatalog: async () => CATALOG,
  effectivePolicy: async () => FLOOR,
};

describe("drainCourseFundingCancellations", () => {
  it("is idempotent: draining the same outbox again, or an event twice, changes nothing", () => {
    const once = drainCourseFundingCancellations(NO_FUNDING_CANCELLATIONS, [dropped], AFTER_DROP);
    expect(once.drained).toBe(1);
    expect(once.next.cancelled).toEqual([{ offeringId: dropped.offeringId, principalId: AMARA.principalId, cancelledAt: dropped.occurredAt }]);

    expect(drainCourseFundingCancellations(once.next, [dropped], AFTER_DROP)).toEqual({ next: once.next, drained: 0 });
    // The same event delivered again further down the outbox adds nothing new.
    const redelivered = drainCourseFundingCancellations(once.next, [dropped, dropped], AFTER_DROP);
    expect(redelivered.next.cancelled).toEqual(once.next.cancelled);
    expect(redelivered.next.drained).toBe(2);
  });

  it("refuses an outbox entry that is not a cancellation event, draining nothing", () => {
    expect(() => drainCourseFundingCancellations(NO_FUNDING_CANCELLATIONS, [{ type: "something-else" }], AFTER_DROP)).toThrow();
  });

  it("lifts a cancellation once the directory enrolls the student again", () => {
    const { next } = drainCourseFundingCancellations(NO_FUNDING_CANCELLATIONS, [dropped], AFTER_DROP);
    expect(drainCourseFundingCancellations(next, [dropped], NORTHFIELD).next.cancelled).toEqual([]);
  });
});

describe("withCourseFundingCancellations", () => {
  it("stops a cancelled student's course funding even while the directory it reads is stale", async () => {
    const { next } = drainCourseFundingCancellations(NO_FUNDING_CANCELLATIONS, [dropped], AFTER_DROP);
    const source = withCourseFundingCancellations(staleSource, async () => next);
    const fund = async (principal: typeof AMARA) =>
      resolveFunding(await source.directory(), await source.fundingPools(), await source.termClosures(), principal, BIO_FALL);

    expect(resolveFunding(NORTHFIELD, pools, [], AMARA, BIO_FALL).ok).toBe(true);
    expect(await fund(AMARA)).toEqual({ ok: false, reason: "not-enrolled" });
    // Classmates are untouched.
    expect((await fund(ELENA)).ok).toBe(resolveFunding(NORTHFIELD, pools, [], ELENA, BIO_FALL).ok);
  });

  it("closes a term the outbox closed", async () => {
    const termClosed = { ...dropped, principalIds: [], reason: "term-closed" as const };
    const { next } = drainCourseFundingCancellations(NO_FUNDING_CANCELLATIONS, [termClosed], NORTHFIELD);
    const source = withCourseFundingCancellations(staleSource, async () => next);
    expect(await source.termClosures()).toEqual([
      { type: "term.closed", districtId: NORTHFIELD.district.id, termId: dropped.termId, closedAt: dropped.occurredAt },
    ]);
  });
});
