import { describe, expect, it } from "vitest";
import {
  CEDARVALLEY,
  DEMO_DISTRICTS,
  HARBOR,
  classroomSeed,
  cleverSeed,
  demoDistrict,
  lakeshoreLargeRemoval,
  oneRosterSeed,
  vendorSeeds,
} from "../src/index.ts";

const subjects = (snapshot: typeof CEDARVALLEY, kinds: readonly string[] = ["staff", "student", "guardian"]) =>
  snapshot.principals.filter((p) => kinds.includes(p.kind)).map((p) => p.externalIdentities[0]!.subject).toSorted();

const activeStudents = (snapshot: typeof CEDARVALLEY, offeringId: string) =>
  snapshot.enrollments.filter((e) => e.offeringId === offeringId && e.role === "student" && e.status === "active").map((e) => e.principalId);

describe("vendorSeeds", () => {
  it("gives each district the seeds its profile calls for", () => {
    expect(Object.fromEntries(DEMO_DISTRICTS.map((d) => [d.slug, Object.keys(vendorSeeds(d)).toSorted()]))).toEqual({
      northfield: ["oneRoster"],
      riverbend: ["oneRoster"],
      prairie: [],
      cedarvalley: ["classroom", "clever"],
      lakeshore: ["oneRoster"],
      harbor: ["classroom"],
    });
  });

  it("are plain JSON, so a fake in any runtime can load them", () => {
    for (const demo of DEMO_DISTRICTS) {
      const seeds = vendorSeeds(demo);
      expect(JSON.parse(JSON.stringify(seeds))).toEqual(seeds);
      expect(vendorSeeds(demo)).toEqual(seeds);
    }
  });
});

describe("cleverSeed (Cedar Valley)", () => {
  const seed = cleverSeed(demoDistrict("cedarvalley"));
  const user = (sisId: string) => seed.users.find((u) => (u.roles.student ?? u.roles.teacher ?? u.roles.contact ?? u.roles.staff)?.sis_id === sisId)!;

  it("holds exactly the directory's people, each under their Clever SSO subject", () => {
    expect(seed.users.map((u) => u.id).toSorted()).toEqual(subjects(CEDARVALLEY));
    expect(seed.users.every((u) => /^[0-9a-f]{24}$/.test(u.id))).toBe(true);
  });

  it("lists each section's current students, and records the mid-term drop as an event", () => {
    for (const section of seed.sections) {
      const expected = activeStudents(CEDARVALLEY, section.sis_id as never).map((id) => user(id).id);
      expect(section.students.toSorted(), section.sis_id).toEqual(expected.toSorted());
    }
    const sofia = user("prn_cv-student-sofia").id;
    expect(seed.events).toHaveLength(1);
    expect(seed.events[0]!.data.object.sis_id).toBe("off_cv-earthsci-p1");
    expect(seed.events[0]!.data.object.students).not.toContain(sofia);
    expect(seed.events[0]!.data.previous_attributes.students).toContain(sofia);
  });

  it("gives the teacher in two schools both, and the guardian a contact role for each twin", () => {
    expect(user("prn_cv-teacher-whitaker").roles.teacher!.schools).toHaveLength(2);
    expect(user("prn_cv-guardian-nguyen").roles.contact!.student_relationships.map((r) => r.student).toSorted())
      .toEqual([user("prn_cv-student-an").id, user("prn_cv-student-bao").id].toSorted());
    expect(seed.users.find((u) => u.roles.district_admin !== undefined)?.name).toEqual({ first: "Elaine", last: "Park" });
  });
});

describe("oneRosterSeed", () => {
  it.each(["northfield", "riverbend", "lakeshore"] as const)("holds %s's people under their IdP subjects as usernames", (slug) => {
    const demo = demoDistrict(slug);
    const seed = oneRosterSeed(demo);
    expect(seed.users.map((u) => u.username).toSorted()).toEqual(subjects(demo.directory));
    expect(seed.enrollments).toHaveLength(demo.directory.enrollments.length);
    expect(seed.users.every((u) => u.roles.length > 0)).toBe(true);
  });

  it("marks the mid-term drop tobedeleted and links the guardian as an agent both ways", () => {
    const seed = oneRosterSeed(demoDistrict("lakeshore"));
    expect(seed.enrollments.filter((e) => e.status === "tobedeleted").map((e) => e.sourcedId)).toEqual(["enr_ls-06"]);
    const user = (id: string) => seed.users.find((u) => u.sourcedId === id)!;
    expect(user("prn_ls-guardian-ito").roles.map((r) => r.role)).toEqual(["guardian"]);
    expect(user("prn_ls-guardian-ito").agents?.map((a) => a.sourcedId)).toEqual(["prn_ls-student-hana"]);
    expect(user("prn_ls-student-hana").agents?.map((a) => a.sourcedId)).toEqual(["prn_ls-guardian-ito"]);
    expect(user("prn_ls-district-admin").roles.map((r) => r.role)).toEqual(["districtAdministrator"]);
    expect(user("prn_ls-principal-high").roles.map((r) => r.role)).toEqual(["principal"]);
  });

  it("has a large-removal variant in which eight of Lakeshore's ten students vanish", () => {
    const full = oneRosterSeed(demoDistrict("lakeshore"));
    const removed = lakeshoreLargeRemoval();
    const students = (s: typeof full) => s.users.filter((u) => u.roles.some((r) => r.role === "student"));
    expect(students(full)).toHaveLength(10);
    expect(students(removed).map((u) => u.sourcedId)).toEqual(["prn_ls-student-hana", "prn_ls-student-iker"]);
    expect(removed.enrollments.every((e) => removed.users.some((u) => u.sourcedId === e.user.sourcedId))).toBe(true);
  });
});

describe("classroomSeed", () => {
  it.each([["harbor", HARBOR], ["cedarvalley", CEDARVALLEY]] as const)("gives %s's staff and students an account, and no guardian", (slug, snapshot) => {
    const seed = classroomSeed(demoDistrict(slug));
    expect(seed.users.map((u) => u.fixtureId).toSorted()).toEqual(
      snapshot.principals.filter((p) => p.kind !== "guardian").map((p) => p.id).toSorted(),
    );
    expect(new Set(seed.users.map((u) => u.primaryEmail)).size).toBe(seed.users.length);
    expect(seed.courses.map((c) => c.alias)).toEqual(snapshot.offerings.map((o) => `d:${o.id}`));
  });

  it("uses Harbor's Google sign-in subjects as user IDs and its directory emails as accounts", () => {
    const seed = classroomSeed(demoDistrict("harbor"));
    for (const user of seed.users) {
      const principal = HARBOR.principals.find((p) => p.id === user.fixtureId)!;
      expect(user.id).toBe(principal.externalIdentities[0]!.subject);
      expect(user.primaryEmail).toBe(principal.email);
    }
  });

  it("leaves the dropped student off the course roster and gives each course its lead teacher as owner", () => {
    const seed = classroomSeed(demoDistrict("harbor"));
    const id = (fixtureId: string) => seed.users.find((u) => u.fixtureId === fixtureId)!.id;
    const gov = seed.courses.find((c) => c.fixtureId === "off_hb-gov-b3")!;
    expect(gov.ownerId).toBe(id("prn_hb-teacher-asante"));
    expect(seed.students.filter((m) => m.courseId === gov.id).map((m) => m.userId)).toEqual([id("prn_hb-student-pia")]);
    expect(seed.teachers.filter((m) => m.courseId === gov.id).map((m) => m.userId)).toEqual([gov.ownerId]);
  });
});
