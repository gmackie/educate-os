import { describe, expect, it } from "vitest";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import { InMemoryGradeRouteStore, LTI_SCOPES } from "../src/index.ts";
import { rejection } from "./helpers.ts";
import { AMARA, AMARA_SUB, approval, BIO, BIO_CONTEXT, createServicesWorld, ENG9, requestFor, RIVERA } from "./services-helpers.ts";

async function setup(options: Parameters<typeof createServicesWorld>[0] = {}) {
  const world = await createServicesWorld(options);
  const lineItem = world.canvas.addLineItem(BIO_CONTEXT, { label: "Cell lab report", scoreMaximum: 10 });
  return { world, lineItem };
}

describe("grade passback (I02 acceptance: explicit, teacher-authorized, no duplicates)", () => {
  it("publishes a teacher-approved grade as a completed, fully graded AGS score", async () => {
    const { world, lineItem } = await setup();
    const approved = approval(world, lineItem);
    world.approvals.record(approved);

    expect(await world.passback.publish(requestFor(approved, "Clear method section."))).toEqual({ status: "posted", route: "lti-ags" });
    expect(world.canvas.scores).toEqual([
      {
        lineItem,
        score: {
          userId: AMARA_SUB,
          scoreGiven: 8,
          scoreMaximum: 10,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp: approved.approvedAt,
          comment: "Clear method section.",
        },
      },
    ]);
    const post = world.canvas.requests.find((request) => request.url === `${lineItem}/scores`);
    expect(post?.contentType).toBe("application/vnd.ims.lis.v1.score+json");
  });

  it("refuses an AI-suggested score nobody approved, and sends nothing", async () => {
    const { world, lineItem } = await setup();
    // An AI evaluator suggested 9/10; no teacher approval exists for it.
    const suggestion = requestFor(approval(world, lineItem, { scoreGiven: 9 }));
    expect(await rejection(world.passback.publish(suggestion))).toBe("policy-violation");
    expect(world.canvas.scores).toEqual([]);
    expect(world.fetched).toEqual([]);
  });

  it("refuses a score that differs from the approved one", async () => {
    const { world, lineItem } = await setup();
    const approved = approval(world, lineItem);
    world.approvals.record(approved);
    expect(await rejection(world.passback.publish({ ...requestFor(approved), scoreGiven: 10 }))).toBe("policy-violation");
    expect(await rejection(world.passback.publish({ ...requestFor(approved), scoreMaximum: 8 }))).toBe("policy-violation");
    expect(world.canvas.scores).toEqual([]);
  });

  it("refuses an approval by someone who does not teach the offering", async () => {
    const { world, lineItem } = await setup();
    for (const approverId of [RIVERA, AMARA]) {
      const approved = approval(world, lineItem, { approverId, gradeVersion: approverId === RIVERA ? 1 : 2 });
      world.approvals.record(approved);
      expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("policy-violation");
    }
    expect(world.canvas.scores).toEqual([]);
  });

  it("posts a retried grade version once", async () => {
    const { world, lineItem } = await setup();
    const approved = approval(world, lineItem);
    world.approvals.record(approved);

    expect((await world.passback.publish(requestFor(approved))).status).toBe("posted");
    expect((await world.passback.publish(requestFor(approved))).status).toBe("already-posted");
    const concurrent = await Promise.allSettled([world.passback.publish(requestFor(approved)), world.passback.publish(requestFor(approved))]);
    expect(concurrent.every((result) => result.status === "fulfilled" && result.value.status === "already-posted")).toBe(true);
    expect(world.canvas.scores).toHaveLength(1);
  });

  it("lets only one of two concurrent first sends deliver", async () => {
    const { world, lineItem } = await setup();
    const approved = approval(world, lineItem);
    world.approvals.record(approved);
    const results = await Promise.allSettled([world.passback.publish(requestFor(approved)), world.passback.publish(requestFor(approved))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(world.canvas.scores).toHaveLength(1);
  });

  it("rejects a stale version once a newer one is posted", async () => {
    const { world, lineItem } = await setup();
    const v1 = approval(world, lineItem, { gradeVersion: 1, scoreGiven: 6, minutesAgo: 30 });
    const v2 = approval(world, lineItem, { gradeVersion: 2, scoreGiven: 8, minutesAgo: 5 });
    world.approvals.record(v1);
    world.approvals.record(v2);

    expect((await world.passback.publish(requestFor(v2))).status).toBe("posted");
    expect(await rejection(world.passback.publish(requestFor(v1)))).toBe("conflict");
    expect(world.canvas.scores.map((posted) => posted.score.scoreGiven)).toEqual([8]);
  });

  it("rejects a newer version whose approval is not later than the posted one's", async () => {
    const { world, lineItem } = await setup();
    const v1 = approval(world, lineItem, { gradeVersion: 1, minutesAgo: 5 });
    const v2 = approval(world, lineItem, { gradeVersion: 2, scoreGiven: 9, minutesAgo: 30 });
    world.approvals.record(v1);
    world.approvals.record(v2);
    await world.passback.publish(requestFor(v1));
    // The platform would discard a score with an older timestamp, so it is not sent at all.
    expect(await rejection(world.passback.publish(requestFor(v2)))).toBe("conflict");
    expect(world.canvas.scores).toHaveLength(1);
  });

  it("releases a failed delivery so a retry sends it", async () => {
    const { world, lineItem } = await setup();
    const approved = approval(world, lineItem);
    world.approvals.record(approved);
    world.canvas.scoreFailures.push(503);
    expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("unavailable");
    expect((await world.passback.publish(requestFor(approved))).status).toBe("posted");
    expect(world.canvas.scores).toHaveLength(1);
  });

  it("refuses AGS for an offering whose grades EducateOS keeps, and for an offering with no route", async () => {
    const { world } = await setup();
    const eng9Item = world.canvas.addLineItem("nf-canvas-course-eng9-p3", { label: "Essay", scoreMaximum: 10 });
    const local = approval(world, eng9Item, { offeringId: ENG9, approverId: RIVERA });
    world.approvals.record(local);
    expect(await rejection(world.passback.publish(requestFor(local)))).toBe("conflict");

    const unrouted = approval(world, eng9Item, { offeringId: OfferingId.parse("off_nf-ushist-fall-p5") });
    expect(await rejection(world.passback.publish(requestFor(unrouted)))).toBe("conflict");
    expect(world.fetched).toEqual([]);
  });

  it("refuses a line item from another course even with a valid approval", async () => {
    const { world } = await setup();
    const elsewhere = world.canvas.addLineItem("nf-canvas-course-eng9-p3", { label: "Essay", scoreMaximum: 10 });
    const approved = approval(world, elsewhere);
    world.approvals.record(approved);
    expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("forbidden");
    expect(world.canvas.scores).toEqual([]);
  });

  it("refuses when the platform does not grant the score scope in the course", async () => {
    const { world, lineItem } = await setup({
      routes: (canvas) => [
        { offeringId: BIO, authority: "lms:nf-canvas", via: "lti-ags", services: canvas.contextServices(BIO_CONTEXT, [LTI_SCOPES.lineItemReadonly]) },
      ],
    });
    const approved = approval(world, lineItem);
    world.approvals.record(approved);
    expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("forbidden");
  });

  it("refuses a student who is not actively enrolled, or has no account on the platform", async () => {
    const { world, lineItem } = await setup();
    // Dmitri is enrolled in Biology but has no Canvas identity link.
    const dmitri = approval(world, lineItem, { studentId: PrincipalId.parse("prn_nf-student-dmitri") });
    world.approvals.record(dmitri);
    expect(await rejection(world.passback.publish(requestFor(dmitri)))).toBe("not-found");
    // Felix is not in Biology.
    const felix = approval(world, lineItem, { studentId: PrincipalId.parse("prn_nf-student-felix") });
    world.approvals.record(felix);
    expect(await rejection(world.passback.publish(requestFor(felix)))).toBe("not-found");
    expect(world.canvas.scores).toEqual([]);
  });

  it("refuses two routes for one offering", () => {
    expect(() => new InMemoryGradeRouteStore([
      { offeringId: BIO, authority: "local" },
      { offeringId: BIO, authority: "local" },
    ])).toThrow();
  });
});
