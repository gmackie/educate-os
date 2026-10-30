// Clever LMS Connect grade passback against `CleverDataFake`, which is built to the same published
// v3.1 spec as the sink. Passing here shows the two agree with the spec as read; neither has been
// tested against Clever.
import { describe, expect, it } from "vitest";
import { CLEVER_ISSUER } from "@educateos/identity";
import { CleverDataFake, SAMPLE_DISTRICT } from "@educateos/provider-fakes";
import {
  CleverLmsConnectAdapter,
  CleverLmsConnectClient,
  CleverLmsConnectGradeSink,
  GradeRoute,
  type CleverLmsConnectGradeRoute,
  type GradeRoute as GradeRouteType,
} from "../src/index.ts";
import { NORTHFIELD_LTI, rejection, withLtiPlatform } from "./helpers.ts";
import { AMARA, approval, BIO, createServicesWorld, ENG9, requestFor } from "./services-helpers.ts";

/**
 * Northfield's Biology period 2 is the seed's `mw-bio-p2` in Clever, and Amara is its student
 * `mw-s-01` unless `student` names another.
 */
async function setup(options: { student?: string; section?: string; route?: Partial<CleverLmsConnectGradeRoute>; token?: string } = {}) {
  const clever = new CleverDataFake({ seed: SAMPLE_DISTRICT });
  const client = new CleverLmsConnectClient({ fetch: clever.fetch, token: async () => options.token ?? clever.districtToken });
  const sink = new CleverLmsConnectGradeSink({ client });
  const directory = withLtiPlatform(NORTHFIELD_LTI, CLEVER_ISSUER, { [AMARA]: clever.userId(options.student ?? "mw-s-01") });
  const bioP2 = clever.idOf("sections", "mw-bio-p2");
  const route: CleverLmsConnectGradeRoute = {
    offeringId: BIO,
    authority: "lms:nf-clever",
    via: "clever-lms-connect",
    districtId: clever.districtId,
    sectionId: clever.idOf("sections", options.section ?? "mw-bio-p2"),
    ...options.route,
  };
  const world = await createServicesWorld({ directory, routes: () => [route, { offeringId: ENG9, authority: "local" }], sinks: [sink] });
  const adapter = new CleverLmsConnectAdapter({ client: new CleverLmsConnectClient({ fetch: clever.fetch, token: async () => clever.districtToken }), routes: world.routes });
  // The column is made in Biology period 2 directly, so a route elsewhere does not own it.
  const created = await clever.fetch(`https://api.clever.com/v3.1/sections/${bioP2}/assignments`, {
    method: "POST",
    headers: { authorization: `Bearer ${clever.districtToken}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Cell lab report", grading_type: "points", points_possible: 10 }),
  });
  const column = ((await created.json()) as { data: { id: string } }).data.id;
  const student = directory.principals.find((p) => p.id === AMARA)!;
  return { world, clever, sink, route, adapter, column, bioP2, student, amaraClever: clever.userId(options.student ?? "mw-s-01") };
}

describe("Clever LMS Connect grade sink (built to the v3.1 spec, not tested against Clever)", () => {
  it("accepts the route kind and refuses a malformed one", () => {
    const valid: GradeRouteType = { offeringId: BIO, authority: "lms:nf-clever", via: "clever-lms-connect", districtId: "a".repeat(24), sectionId: "b".repeat(24) };
    expect(GradeRoute.parse(valid)).toEqual(valid);
    expect(GradeRoute.safeParse({ ...valid, sectionId: "../users" }).success).toBe(false);
    expect(GradeRoute.safeParse({ ...valid, courseId: "x" }).success).toBe(false);
  });

  it("publishes a teacher-approved grade to the student's Clever submission, once", async () => {
    const { world, clever, column, bioP2, amaraClever } = await setup();
    const approved = approval(world, column);
    world.approvals.record(approved);
    expect(await world.passback.publish(requestFor(approved, "Clear method"))).toEqual({ status: "posted", route: "clever-lms-connect" });
    expect(await world.passback.publish(requestFor(approved, "Clear method"))).toEqual({ status: "already-posted", route: "clever-lms-connect" });
    expect(clever.submissionFor(bioP2, column, amaraClever)).toMatchObject({ grade_points: 8, grade_comment: "Clear method", state: "created" });
    expect(clever.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    // Nothing else in the section was graded, and no assignment was created along the way.
    expect(clever.submissionFor(bioP2, column, clever.userId("mw-s-02"))).not.toHaveProperty("grade_points");
    expect(clever.assignmentsFor(bioP2)).toHaveLength(1);
  });

  it("delivers the same grade again harmlessly when retried", async () => {
    const { world, clever, sink, route, column, bioP2, amaraClever, student } = await setup();
    const delivery = { column, scoreGiven: 8, scoreMaximum: 10, approvedAt: new Date(world.clock.now()).toISOString(), comment: undefined };
    await sink.check(route, column, student);
    await sink.deliver(route, delivery, student);
    const first = clever.submissionFor(bioP2, column, amaraClever);
    await sink.deliver(route, delivery, student);
    expect(clever.submissionFor(bioP2, column, amaraClever)).toMatchObject({ grade_points: first!.grade_points, grade_comment: null });
    expect(clever.assignmentsFor(bioP2)).toHaveLength(1);
  });

  it("releases a failed delivery so the retry lands it", async () => {
    const { world, clever, column, bioP2, amaraClever } = await setup();
    const approved = approval(world, column);
    world.approvals.record(approved);
    clever.inject({ kind: "outage", times: 1, match: { method: "PATCH" } });
    expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("unavailable");
    expect(clever.submissionFor(bioP2, column, amaraClever)).not.toHaveProperty("grade_points");
    expect(await world.passback.publish(requestFor(approved))).toEqual({ status: "posted", route: "clever-lms-connect" });
    expect(clever.submissionFor(bioP2, column, amaraClever)).toMatchObject({ grade_points: 8 });
  });

  it("publishes through the route's column mapping", async () => {
    const mapped = await setup();
    const { world, clever, bioP2, amaraClever } = await setup({ route: { assignments: { "eos-cell-lab": mapped.column } } });
    // Each fake derives assignment IDs the same way, so the mapped ID is this fake's first assignment too.
    const approved = approval(world, "eos-cell-lab");
    world.approvals.record(approved);
    expect(await world.passback.publish(requestFor(approved))).toEqual({ status: "posted", route: "clever-lms-connect" });
    expect(clever.submissionFor(bioP2, mapped.column, amaraClever)).toMatchObject({ grade_points: 8 });
  });

  it("refuses a column outside the route's section", async () => {
    // Amara is in English 9 period 1 too, so only the column is wrong.
    const { world, clever, column, sink, route, student } = await setup({ section: "mw-eng9-p1" });
    const approved = approval(world, column);
    world.approvals.record(approved);
    expect(await rejection(world.passback.publish(requestFor(approved)))).toBe("forbidden");
    expect(await rejection(sink.check(route, "../../users", student))).toBe("forbidden");
    expect(clever.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("refuses a student who is not on the section's Clever roster, or has no Clever link", async () => {
    const outsider = await setup({ student: "mw-s-07" });
    const approved = approval(outsider.world, outsider.column);
    outsider.world.approvals.record(approved);
    expect(await rejection(outsider.world.passback.publish(requestFor(approved)))).toBe("not-found");
    expect(outsider.clever.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);

    const { sink, route, column } = await setup();
    const unlinked = NORTHFIELD_LTI.principals.find((p) => p.id === AMARA)!;
    expect(await rejection(sink.check(route, column, unlinked))).toBe("not-found");
  });

  it("refuses a section in another district, a differing maximum and another route kind", async () => {
    const foreign = await setup({ route: { districtId: "0".repeat(24) } });
    expect(await rejection(foreign.sink.check(foreign.route, foreign.column, foreign.student))).toBe("conflict");

    const { world, column, sink, student } = await setup();
    const outOfTwenty = approval(world, column, { scoreMaximum: 20 });
    world.approvals.record(outOfTwenty);
    expect(await rejection(world.passback.publish(requestFor(outOfTwenty)))).toBe("conflict");
    expect(await rejection(sink.check({ offeringId: BIO, authority: "lms:x", via: "google-classroom", courseId: "c" }, column, student))).toBe("conflict");
  });

  it("maps Clever's errors to EducateOS errors", async () => {
    const { clever, column, sink, route, student } = await setup();
    clever.inject({ kind: "outage", times: 1 });
    expect(await rejection(sink.check(route, column, student))).toBe("unavailable");
    clever.inject({ kind: "rate-limit", retryAfterSeconds: 1, times: 1 });
    expect(await rejection(sink.check(route, column, student))).toBe("unavailable");
    clever.inject({ kind: "network-error", times: 1 });
    expect(await rejection(sink.check(route, column, student))).toBe("unavailable");
    const missing = await setup({ route: { sectionId: "c".repeat(24) } });
    expect(await rejection(missing.sink.check(missing.route, missing.column, missing.student))).toBe("not-found");

    const revoked = await setup({ token: "revoked" });
    const approved = approval(revoked.world, revoked.column);
    revoked.world.approvals.record(approved);
    expect(await rejection(revoked.world.passback.publish(requestFor(approved)))).toBe("forbidden");
  });

  it("creates assignments only for an offering routed to Clever, and grades them", async () => {
    const { world, clever, adapter, bioP2, amaraClever } = await setup();
    const created = await adapter.createAssignment(BIO, { title: "Field notes", pointsPossible: 10 });
    expect(created).toMatchObject({ title: "Field notes", grading_type: "points", points_possible: 10 });
    expect(await adapter.assignment(BIO, created.id)).toMatchObject({ id: created.id });
    expect(await adapter.assignment(BIO, "f".repeat(24))).toBeUndefined();
    expect(await rejection(adapter.createAssignment(ENG9, { title: "Essay", pointsPossible: 10 }))).toBe("conflict");
    expect(await rejection(adapter.createAssignment(BIO, { title: " ", pointsPossible: 10 }))).toBe("validation-failed");

    const approved = approval(world, created.id);
    world.approvals.record(approved);
    expect(await world.passback.publish(requestFor(approved))).toEqual({ status: "posted", route: "clever-lms-connect" });
    expect(clever.submissionFor(bioP2, created.id, amaraClever)).toMatchObject({ grade_points: 8 });
  });
});
