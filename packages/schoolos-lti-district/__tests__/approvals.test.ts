// The passback gate reading teacher approvals from E01's official grade versions, with its ledger
// in the district's record table (SCHO-76).
import { describe, expect, it } from "vitest";
import { GradePassback, routeOfKind, type GradeDelivery, type GradeSink, type LmsGradeRoute } from "@schoolos/lti";
import { OfficialGradeApprovals } from "../src/index.ts";
import { AMARA, BIO, BIO_CONTEXT, createDistrict, gradedBiology, MORGAN, NF, NF_CANVAS, rejection } from "./setup.ts";

const COLUMN = `${NF_CANVAS}/api/lti/courses/1/line_items/7`;

/** A sink that records deliveries and accepts any column and student. */
class RecordingSink implements GradeSink {
  readonly via = "lti-ags";
  readonly delivered: GradeDelivery[] = [];

  async check(route: LmsGradeRoute): Promise<void> {
    routeOfKind(route, "lti-ags");
  }

  async deliver(_route: LmsGradeRoute, delivery: GradeDelivery): Promise<void> {
    this.delivered.push(delivery);
  }
}

async function setup() {
  const district = createDistrict();
  await district.assessments.commit(gradedBiology(), 0);
  await district.stores.gradeColumns.bind({ offeringId: BIO, column: COLUMN, assignmentId: "asg_cell-lab" as never });
  await district.stores.gradeRoutes.setRoute({
    offeringId: BIO,
    authority: "lms:canvas",
    via: "lti-ags",
    services: { registration: { issuer: NF_CANVAS, clientId: "10000000000001" }, contextId: BIO_CONTEXT, ags: { scopes: [], lineItemsUrl: `${NF_CANVAS}/api/lti/courses/1/line_items` } },
  });
  const approvals = new OfficialGradeApprovals({ districtId: NF, columns: district.stores.gradeColumns, assessments: district.assessments });
  const sink = new RecordingSink();
  const passback = new GradePassback({
    districtId: NF,
    directory: district.loadDirectory,
    routes: district.stores.gradeRoutes,
    approvals,
    ledger: district.stores.passbackLedger,
    sinks: [sink],
    now: () => Date.parse("2026-10-21T09:00:00Z"),
  });
  const request = { offeringId: BIO, studentId: AMARA, column: COLUMN, gradeVersion: 1, scoreGiven: 8, scoreMaximum: 10 };
  return { ...district, approvals, sink, passback, request };
}

describe("OfficialGradeApprovals (SCHO-76)", () => {
  it("is the teacher's official grade version, read from the assessment records", async () => {
    const { approvals } = await setup();
    expect(await approvals.find({ offeringId: BIO, studentId: AMARA, column: COLUMN, gradeVersion: 1 })).toEqual({
      offeringId: BIO,
      studentId: AMARA,
      column: COLUMN,
      gradeVersion: 1,
      scoreGiven: 8,
      scoreMaximum: 10,
      approverId: MORGAN,
      approvedAt: "2026-10-20T15:00:00Z",
    });
    expect(await approvals.find({ offeringId: BIO, studentId: AMARA, column: COLUMN, gradeVersion: 2 })).toBeUndefined();
    expect(await approvals.find({ offeringId: BIO, studentId: AMARA, column: `${COLUMN}/other`, gradeVersion: 1 })).toBeUndefined();
  });

  it("publishes an approved grade once, through the durable ledger", async () => {
    const { passback, sink, request } = await setup();
    expect(await passback.publish(request)).toEqual({ status: "posted", route: "lti-ags" });
    expect(await passback.publish(request)).toEqual({ status: "already-posted", route: "lti-ags" });
    expect(sink.delivered).toEqual([{ column: COLUMN, scoreGiven: 8, scoreMaximum: 10, approvedAt: "2026-10-20T15:00:00Z", comment: undefined }]);
  });

  it("sends exactly once when the same grade is published concurrently", async () => {
    const { passback, sink, request } = await setup();
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => passback.publish(request)));
    expect(outcomes.filter((o) => o.status === "fulfilled" && o.value.status === "posted")).toHaveLength(1);
    expect(sink.delivered).toHaveLength(1);
  });

  it("refuses a grade no teacher approved, or a score other than the approved one", async () => {
    const { passback, sink, request } = await setup();
    // An AI-suggested version 2 that never became an official grade version.
    expect(await rejection(passback.publish({ ...request, gradeVersion: 2, scoreGiven: 9 }))).toBe("policy-violation");
    expect(await rejection(passback.publish({ ...request, scoreGiven: 10 }))).toBe("policy-violation");
    expect(sink.delivered).toEqual([]);
  });
});
