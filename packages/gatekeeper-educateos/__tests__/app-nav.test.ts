// The School app's sidebar entries (SCHO-218): what each kind of person is offered, read from the
// district as them.
import { describe, expect, it } from "vitest";
import { isGatekeeperAppPath, sanitizeGatekeeperAppNav } from "@gadgets/workshop-shared/gatekeeper";
import { readSchoolNavFacts, schoolNav, type DistrictGet } from "../src/app-nav.ts";

const DISTRICT = { level: "district", districtId: "dst_coop" } as const;
const offering = (id: string, sectionName: string, archived = false) => ({
  offering: { id, districtId: "dst_coop", schoolId: "sch_1", termId: "trm_1", courseId: "crs_1", sectionName, ...(archived ? { archivedAt: "2026-10-26T00:00:00Z" } : {}) },
  course: { id: "crs_1", districtId: "dst_coop", title: "Earth Science", subject: "science", gradeBand: "6-8" },
});

/** A district that answers `routes` as the person and refuses anything else. */
const district = (routes: Record<string, unknown>): { get: DistrictGet; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    get: async <T,>(path: string) => {
      asked.push(path);
      if (!(path in routes)) throw new Error(`refused ${path}`);
      return routes[path] as T;
    },
  };
};

const navOf = async (routes: Record<string, unknown>) => schoolNav(await readSchoolNavFacts(district(routes).get));

describe("School app sidebar entries", () => {
  it("gives a district administrator Administration and a page per school", async () => {
    const nav = await navOf({
      "/api/me": { kind: "staff", roles: [{ role: "district-admin", scope: DISTRICT }], enrollments: [] },
      "/api/admin/authoring": { schools: [{ id: "sch_1", districtId: "dst_coop", name: "Gmacko Demo Co-op", gradeBands: ["K-8"] }] },
    });
    expect(nav).toStrictEqual([
      { label: "Administration", path: "/admin" },
      { label: "Gmacko Demo Co-op", path: "/schools/sch_1", group: "Schools" },
    ]);
  });

  it("gives a teacher Teacher Studio and each current class they teach", async () => {
    const nav = await navOf({
      "/api/me": { kind: "staff", roles: [], enrollments: [{ role: "teacher" }] },
      "/api/teacher/offerings": [offering("off_1", "Tuesday mornings"), offering("off_old", "Last spring", true)],
    });
    expect(nav).toStrictEqual([
      { label: "Teacher Studio", path: "/teach" },
      { label: "Earth Science · Tuesday mornings", path: "/teach/classes/off_1/roster", group: "Teaching" },
    ]);
  });

  it("gives a student their Learning Home and classes, and a guardian the family view and children", async () => {
    expect(await navOf({
      "/api/me": { kind: "student", roles: [], enrollments: [{ role: "student" }] },
      "/api/student/offerings": [offering("off_1", "Tuesday mornings")],
    })).toStrictEqual([
      { label: "Learning Home", path: "/learn" },
      { label: "Earth Science · Tuesday mornings", path: "/learn/courses/off_1", group: "My classes" },
    ]);
    expect(await navOf({
      "/api/me": { kind: "guardian", roles: [], enrollments: [] },
      "/api/guardian/children": [{ studentPrincipalId: "prn_sam", displayName: "Sam Student" }],
    })).toStrictEqual([
      { label: "Family", path: "/learn/family" },
      { label: "Sam Student", path: "/learn/family/children/prn_sam", group: "Family" },
    ]);
  });

  it("asks only for what the person's kind and roles can read", async () => {
    const student = district({ "/api/me": { kind: "student", roles: [], enrollments: [] }, "/api/student/offerings": [] });
    await readSchoolNavFacts(student.get);
    expect(student.asked).toStrictEqual(["/api/me", "/api/student/offerings"]);
  });

  it("drops a list the district refuses rather than the whole section", async () => {
    const nav = await navOf({ "/api/me": { kind: "staff", roles: [{ role: "district-admin", scope: DISTRICT }], enrollments: [] } });
    expect(nav).toStrictEqual([{ label: "Administration", path: "/admin" }]);
  });

  it("makes only entries the Workshop keeps, with IDs escaped into their paths", async () => {
    const nav = schoolNav({
      kind: "staff", districtAdmin: true, schools: [{ id: "sch_a b/c", name: "Odd" }], teaching: [], learning: [], children: [],
    });
    expect(nav.every((entry) => isGatekeeperAppPath(entry.path))).toBe(true);
    expect(sanitizeGatekeeperAppNav(nav)).toStrictEqual(nav);
    expect(nav[1]!.path).toBe("/schools/sch_a%20b%2Fc");
  });
});
