import { describe, expect, it } from "vitest";
import { DEMO_DISTRICTS, googleDemoPlan } from "../src/index.ts";

const DOMAIN = "gedu.demo.educateos.io";
const plan = googleDemoPlan(DOMAIN, DEMO_DISTRICTS);

describe("googleDemoPlan", () => {
  it("creates Staff and Students units under Harbor and CedarValley only", () => {
    expect(plan.orgUnits.map((u) => u.path)).toEqual([
      "/CedarValley", "/CedarValley/Staff", "/CedarValley/Students",
      "/Harbor", "/Harbor/Staff", "/Harbor/Students",
    ]);
    for (const unit of plan.orgUnits) expect(`${unit.parentPath === "/" ? "" : unit.parentPath}/${unit.name}`).toBe(unit.path);
  });

  it("creates a modest set of accounts in the demo domain, each in its district's unit for its kind", () => {
    const count = (district: string, kind: string) => plan.users.filter((u) => u.district === district && u.kind === kind).length;
    expect([count("harbor", "staff"), count("harbor", "student"), count("cedarvalley", "staff"), count("cedarvalley", "student")]).toEqual([3, 6, 3, 6]);
    for (const user of plan.users) {
      expect(user.primaryEmail.endsWith(`@${DOMAIN}`)).toBe(true);
      expect(user.orgUnitPath).toMatch(user.kind === "staff" ? /\/Staff$/ : /\/Students$/);
      expect(user.orgUnitPath.startsWith(user.district === "harbor" ? "/Harbor/" : "/CedarValley/")).toBe(true);
    }
    expect(new Set(plan.users.map((u) => u.primaryEmail)).size).toBe(plan.users.length);
  });

  it("creates one course per offering, keyed by its alias, whose roster names only planned accounts", () => {
    expect(plan.courses).toHaveLength(8);
    expect(new Set(plan.courses.map((c) => c.alias)).size).toBe(8);
    const emails = new Set(plan.users.map((u) => u.primaryEmail));
    const staff = new Set(plan.users.filter((u) => u.kind === "staff").map((u) => u.primaryEmail));
    for (const course of plan.courses) {
      expect(course.alias).toBe(`d:${course.fixtureId}`);
      expect(staff.has(course.ownerEmail)).toBe(true);
      for (const email of [...course.coTeacherEmails, ...course.studentEmails]) expect(emails.has(email)).toBe(true);
      expect(course.coTeacherEmails).not.toContain(course.ownerEmail);
    }
  });

  it("does not enrol the students dropped mid-term", () => {
    const roster = (fixtureId: string) => plan.courses.find((c) => c.fixtureId === fixtureId)!.studentEmails;
    expect(roster("off_hb-gov-b3")).not.toContain(`hb-student-quentin@${DOMAIN}`);
    expect(roster("off_cv-earthsci-p1")).not.toContain(`cv-student-sofia@${DOMAIN}`);
    expect(roster("off_cv-eng8-p2")).toContain(`cv-student-sofia@${DOMAIN}`);
  });
});
