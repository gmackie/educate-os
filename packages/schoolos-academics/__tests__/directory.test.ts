import { describe, expect, it, vi } from "vitest";
import {
  checkDirectoryIntegrity,
  EnrollmentId,
  OfferingId,
  PrincipalId,
  TermId,
  type Authorizer,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { AcademicDirectory, AcademicSync, DirectoryValidationError, InMemoryAcademicStore, isDistrictAdmin, RoleTableAuthorizer, storePrincipalFacts } from "../src/index.ts";
import { ALL_LOCAL, directoryFor, NF, nf, RB_ADMIN, rejectsWith, ROSTER_EXTERNAL } from "./setup.ts";

const BIO_FALL = OfferingId.parse("off_nf-bio-fall-p2");
const MATH7 = OfferingId.parse("off_nf-math7-fall-p1");
const FALL = TermId.parse("trm_nf-2026-fall");

/** Northfield with only its district, its admin, one teacher and two students: nothing academic yet. */
function emptyNorthfield(): DistrictDirectorySnapshot {
  const keep = new Set(["prn_nf-district-admin", "prn_nf-teacher-rivera", "prn_nf-student-amara", "prn_nf-student-elena"]);
  return {
    district: NORTHFIELD.district,
    schools: [],
    terms: [],
    courses: [],
    offerings: [],
    principals: NORTHFIELD.principals.filter((p) => keep.has(p.id)),
    enrollments: [],
    roleAssignments: NORTHFIELD.roleAssignments.filter((r) => r.role === "district-admin"),
  };
}

describe("A01 acceptance: seed 2 schools, 3 classes and 2 students through CRUD", () => {
  it("builds a consistent directory and serves it back", async () => {
    const { store, directory } = directoryFor(emptyNorthfield());
    const admin = NF.admin;

    const high = await directory.createSchool(admin, { name: "Northfield High School", gradeBands: ["9-12"] });
    const middle = await directory.createSchool(admin, { name: "Northfield Middle School", gradeBands: ["6-8"] });
    const term = await directory.createTerm(admin, { name: "Fall 2026", startsOn: "2026-08-31", endsOn: "2027-01-22" });
    expect(term.state).toBe("planned");
    const biology = await directory.createCourse(admin, { title: "Biology I", subject: "science", gradeBand: "9-10" });
    const english = await directory.createCourse(admin, { title: "English 9", subject: "english-language-arts", gradeBand: "9" });
    const history = await directory.createCourse(admin, { title: "History 7", subject: "history-social-studies", gradeBand: "7" });

    const classes = [
      await directory.createOffering(admin, { schoolId: high.id, termId: term.id, courseId: biology.id, sectionName: "Period 2" }),
      await directory.createOffering(admin, { schoolId: high.id, termId: term.id, courseId: english.id, sectionName: "Period 3" }),
      await directory.createOffering(admin, { schoolId: middle.id, termId: term.id, courseId: history.id, sectionName: "Period 1" }),
    ];
    const amara = PrincipalId.parse("prn_nf-student-amara");
    const elena = PrincipalId.parse("prn_nf-student-elena");
    for (const offering of classes) {
      await directory.createEnrollment(admin, { offeringId: offering.id, principalId: PrincipalId.parse("prn_nf-teacher-rivera"), role: "teacher" });
      await directory.createEnrollment(admin, { offeringId: offering.id, principalId: amara, role: "student" });
    }
    await directory.createEnrollment(admin, { offeringId: classes[0]!.id, principalId: elena, role: "student" });

    expect(await directory.listSchools(admin)).toHaveLength(2);
    expect(await directory.listOfferings(admin)).toHaveLength(3);
    expect(await directory.listOfferings(admin, { principalId: amara })).toHaveLength(3);
    expect(await directory.listOfferings(admin, { schoolId: middle.id })).toEqual([classes[2]]);
    expect((await directory.roster(admin, classes[0]!.id)).map((e) => e.principalId).toSorted()).toEqual(
      [amara, elena, "prn_nf-teacher-rivera"].toSorted(),
    );

    const renamed = await directory.updateOffering(admin, classes[1]!.id, { sectionName: "Period 4" });
    expect(await directory.getOffering(admin, classes[1]!.id)).toEqual(renamed);
    await directory.updateSchool(admin, middle.id, { name: "Northfield Middle" });
    expect((await directory.getSchool(admin, middle.id)).name).toBe("Northfield Middle");

    // A teacher enrolled through the service can read their roster with no separate grant.
    expect(await directory.roster(nf("prn_nf-teacher-rivera"), classes[2]!.id)).toHaveLength(2);
    // A student reads their own enrollments, and no one else's.
    const own = await directory.listEnrollments(nf("prn_nf-student-elena"), elena);
    expect(own.map((e) => e.offeringId)).toEqual([classes[0]!.id]);

    const { snapshot } = await store.load();
    expect(checkDirectoryIntegrity(snapshot)).toEqual([]);
    expect(snapshot.schools).toHaveLength(2);
    expect(snapshot.offerings).toHaveLength(3);
    expect(snapshot.principals.filter((p) => p.kind === "student")).toHaveLength(2);
  });

  it("refuses a write that would break directory integrity, listing the issues, and stores nothing", async () => {
    const { store, directory } = directoryFor(emptyNorthfield());
    const school = await directory.createSchool(NF.admin, { name: "High", gradeBands: ["9-12"] });
    const before = await store.load();

    const error = await rejectsWith(
      directory.createOffering(NF.admin, {
        schoolId: school.id,
        termId: TermId.parse("trm_nowhere"),
        courseId: "crs_nowhere" as never,
        sectionName: "P1",
      }),
      "validation-failed",
    );
    expect(error).toBeInstanceOf(DirectoryValidationError);
    expect((error as DirectoryValidationError).issues.map((i) => i.path).toSorted()).toEqual(
      ["offerings[0].courseId", "offerings[0].termId"],
    );
    expect(error.message).toContain("unknown term trm_nowhere");
    expect(await store.load()).toEqual(before);

    // A staff member cannot be enrolled as a student: the integrity check, not the route, says so.
    const term = await directory.createTerm(NF.admin, { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" });
    const course = await directory.createCourse(NF.admin, { title: "C", subject: "arts", gradeBand: "9" });
    const offering = await directory.createOffering(NF.admin, { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "P1" });
    await rejectsWith(
      directory.createEnrollment(NF.admin, { offeringId: offering.id, principalId: PrincipalId.parse("prn_nf-teacher-rivera"), role: "student" }),
      "validation-failed",
    );
    await rejectsWith(
      directory.updateTerm(NF.admin, term.id, { endsOn: "2026-01-01" }),
      "validation-failed",
    );
  });

  it("refuses to seed from a snapshot that fails integrity", () => {
    const broken = { ...NORTHFIELD, enrollments: [...NORTHFIELD.enrollments, { ...NORTHFIELD.enrollments[0]!, id: EnrollmentId.parse("enr_x"), offeringId: OfferingId.parse("off_gone") }] };
    expect(() => InMemoryAcademicStore.seeded(broken)).toThrow(DirectoryValidationError);
  });
});

describe("source of record", () => {
  it("refuses user writes to an externally owned type, naming the owner, and changes nothing", async () => {
    const { store, directory } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const before = await store.load();

    const error = await rejectsWith(
      directory.createEnrollment(NF.admin, { offeringId: BIO_FALL, principalId: PrincipalId.parse("prn_nf-student-felix"), role: "student" }),
      "conflict",
    );
    expect(error.message).toContain("external:oneroster");
    await rejectsWith(directory.deactivateEnrollment(NF.admin, EnrollmentId.parse("enr_nf-02")), "conflict");
    await rejectsWith(directory.updateOffering(NF.admin, BIO_FALL, { sectionName: "Renamed" }), "conflict");
    expect(await store.load()).toEqual(before);

    // Locally owned types in the same directory still accept writes.
    await directory.updateSchool(NF.admin, NORTHFIELD.schools[0]!.id, { name: "Renamed High" });
  });

  it("does not reveal the authority map to a caller who may not write anyway", async () => {
    const { directory } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    await rejectsWith(directory.deactivateEnrollment(NF.amara, EnrollmentId.parse("enr_nf-03")), "not-found");
  });

  it("lets only the owning provider's sync adapter write, atomically", async () => {
    const { store, directory, authority } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const sync = new AcademicSync({ store, authority, provider: "oneroster" });

    const dropped = { ...NORTHFIELD.enrollments.find((e) => e.id === "enr_nf-02")!, status: "inactive" as const };
    await sync.apply({ enrollments: [dropped] });
    expect((await directory.getEnrollment(NF.admin, dropped.id)).status).toBe("inactive");

    // Another provider, or a type the roster does not own, is refused before anything is read.
    const other = new AcademicSync({ store, authority, provider: "clever" });
    await rejectsWith(other.apply({ enrollments: [dropped] }), "conflict");
    await rejectsWith(sync.apply({ enrollments: [], schools: [NORTHFIELD.schools[0]!] }), "conflict");

    // A batch that would break integrity stores none of it.
    const before = await store.load();
    const orphan = { ...dropped, id: EnrollmentId.parse("enr_orphan"), offeringId: OfferingId.parse("off_missing") };
    const renamed = { ...NORTHFIELD.offerings[0]!, sectionName: "Renamed" };
    await rejectsWith(sync.apply({ offerings: [renamed], enrollments: [orphan] }), "validation-failed");
    expect(await store.load()).toEqual(before);
  });

  it("holds synced terms to forward-only transitions too", async () => {
    const authority = { ...ALL_LOCAL, term: "external:sis" as const };
    const { store } = directoryFor(NORTHFIELD, { authority });
    const sync = new AcademicSync({ store, authority, provider: "sis" });
    const spring = NORTHFIELD.terms.find((t) => t.id === "trm_nf-2026-spring")!;
    await rejectsWith(sync.apply({ terms: [{ ...spring, state: "active" }] }), "conflict");
  });
});

describe("term transitions", () => {
  it("moves a term forward one step at a time", async () => {
    const { directory } = directoryFor(emptyNorthfield());
    const term = await directory.createTerm(NF.admin, { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" });
    for (const state of ["active", "grading", "completed"] as const) {
      expect((await directory.transitionTerm(NF.admin, term.id, state)).state).toBe(state);
    }
    expect((await directory.getTerm(NF.admin, term.id)).state).toBe("completed");
  });

  it.each([
    ["trm_nf-2026-fall", "planned"],
    ["trm_nf-2026-fall", "completed"],
    ["trm_nf-2026-fall", "active"],
    ["trm_nf-2026-spring", "active"],
    ["trm_nf-2026-spring", "completed"],
  ] as const)("refuses %s → %s", async (termId, to) => {
    const { store, directory } = directoryFor();
    const before = await store.load();
    await rejectsWith(directory.transitionTerm(NF.admin, TermId.parse(termId), to), "conflict");
    expect(await store.load()).toEqual(before);
  });

  it("cannot change state through an ordinary update", async () => {
    const { directory } = directoryFor();
    await rejectsWith(
      directory.updateTerm(NF.admin, FALL, { state: "completed" } as never),
      "validation-failed",
    );
  });
});

describe("enrollment removal", () => {
  it("deactivates rather than deletes", async () => {
    const { store, directory } = directoryFor();
    const id = EnrollmentId.parse("enr_nf-03");
    const countBefore = (await store.load()).snapshot.enrollments.length;

    const result = await directory.deactivateEnrollment(NF.admin, id);
    expect(result.status).toBe("inactive");
    expect((await directory.roster(NF.admin, BIO_FALL)).map((e) => e.id)).not.toContain(id);

    const { snapshot } = await store.load();
    expect(snapshot.enrollments).toHaveLength(countBefore);
    expect(snapshot.enrollments.find((e) => e.id === id)).toMatchObject({ status: "inactive", principalId: "prn_nf-student-dmitri" });
    expect(snapshot.principals.some((p) => p.id === "prn_nf-student-dmitri")).toBe(true);
    // The student can still see their own retained record.
    expect((await directory.listEnrollments(NF.dmitri, PrincipalId.parse("prn_nf-student-dmitri"))).map((e) => e.id)).toContain(id);
    // Deactivating again is a no-op, and there is no delete operation at all.
    expect(await directory.deactivateEnrollment(NF.admin, id)).toEqual(result);
    expect("deleteEnrollment" in directory).toBe(false);
  });

  it("refuses a second active enrollment of the same principal in an offering", async () => {
    const { directory } = directoryFor();
    await rejectsWith(
      directory.createEnrollment(NF.admin, { offeringId: BIO_FALL, principalId: PrincipalId.parse("prn_nf-student-amara"), role: "student" }),
      "conflict",
    );
  });

  it("ends roster access that came from a teacher's enrollment when it is deactivated", async () => {
    const { directory } = directoryFor(emptyNorthfield());
    const school = await directory.createSchool(NF.admin, { name: "High", gradeBands: ["9-12"] });
    const term = await directory.createTerm(NF.admin, { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" });
    const course = await directory.createCourse(NF.admin, { title: "C", subject: "arts", gradeBand: "9" });
    const offering = await directory.createOffering(NF.admin, { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "P1" });
    const rivera = nf("prn_nf-teacher-rivera");
    const teaching = await directory.createEnrollment(NF.admin, { offeringId: offering.id, principalId: rivera.principal.principalId, role: "teacher" });

    expect(await directory.roster(rivera, offering.id)).toHaveLength(1);
    await directory.deactivateEnrollment(NF.admin, teaching.id);
    await rejectsWith(directory.roster(rivera, offering.id), "not-found");
  });
});

describe("authorization", () => {
  it("lets a teacher read their own offering's roster, and nothing else", async () => {
    const { directory } = directoryFor();
    expect((await directory.roster(NF.morgan, BIO_FALL)).length).toBeGreaterThan(0);
    await rejectsWith(directory.roster(NF.morgan, MATH7), "not-found");
    await rejectsWith(directory.getOffering(NF.morgan, BIO_FALL), "not-found");
    await rejectsWith(directory.createEnrollment(NF.morgan, { offeringId: BIO_FALL, principalId: PrincipalId.parse("prn_nf-student-felix"), role: "student" }), "not-found");
    expect(await directory.listTerms(NF.morgan)).toEqual([]);
  });

  it("answers a student reading another offering's roster with not-found, as for a missing one", async () => {
    const { directory } = directoryFor();
    const hidden = await rejectsWith(directory.roster(NF.chidi, BIO_FALL), "not-found");
    const missing = await rejectsWith(directory.roster(NF.chidi, OfferingId.parse("off_nf-does-not-exist")), "not-found");
    expect(hidden.message.replace(BIO_FALL, "X")).toBe(missing.message.replace("off_nf-does-not-exist", "X"));
    // Even their own offering's roster is not theirs to list.
    await rejectsWith(directory.roster(NF.chidi, MATH7), "not-found");
  });

  it("lets a student read only their own enrollments", async () => {
    const { directory } = directoryFor();
    const amara = PrincipalId.parse("prn_nf-student-amara");
    const own = await directory.listEnrollments(NF.amara, amara);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.principalId === amara)).toBe(true);
    expect(await directory.listEnrollments(NF.amara, PrincipalId.parse("prn_nf-student-elena"))).toEqual([]);
    await rejectsWith(directory.getEnrollment(NF.amara, EnrollmentId.parse("enr_nf-04")), "not-found");
    expect(await directory.listOfferings(NF.amara, { principalId: PrincipalId.parse("prn_nf-student-elena") })).toEqual([]);
  });

  it("confines a school admin to their school", async () => {
    const { directory } = directoryFor();
    const high = NORTHFIELD.schools.find((s) => s.id === "sch_nf-high")!;
    const middle = NORTHFIELD.schools.find((s) => s.id === "sch_nf-middle")!;
    const offerings = await directory.listOfferings(NF.highPrincipal);
    expect(offerings.every((o) => o.schoolId === high.id)).toBe(true);
    await directory.createOffering(NF.highPrincipal, { schoolId: high.id, termId: FALL, courseId: NORTHFIELD.courses[0]!.id, sectionName: "P6" });
    await rejectsWith(
      directory.createOffering(NF.highPrincipal, { schoolId: middle.id, termId: FALL, courseId: NORTHFIELD.courses[0]!.id, sectionName: "P6" }),
      "not-found",
    );
    await rejectsWith(directory.createTerm(NF.highPrincipal, { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" }), "forbidden");
    await rejectsWith(directory.deactivateEnrollment(NF.highPrincipal, EnrollmentId.parse("enr_nf-16")), "not-found");
  });

  it("ends a graduated teacher's roster access while keeping their records", async () => {
    const graduated = structuredClone(NORTHFIELD);
    graduated.principals.find((p) => p.id === NF.morgan.principal.principalId)!.status = "graduated";
    const { directory } = directoryFor(graduated);
    await rejectsWith(directory.roster(NF.morgan, BIO_FALL), "not-found");
    expect((await directory.roster(NF.admin, BIO_FALL)).some((e) => e.principalId === NF.morgan.principal.principalId)).toBe(true);
  });

  it("answers forbidden for a write to something the caller can see but not change", async () => {
    // A student may read their own enrollment but not deactivate it.
    const { directory } = directoryFor();
    await rejectsWith(directory.deactivateEnrollment(NF.amara, EnrollmentId.parse("enr_nf-02")), "forbidden");
  });

  it("denies a cross-district caller even when the authorizer would allow everything, after showing it the request", async () => {
    const allowAll: Authorizer = { authorize: vi.fn(async () => ({ effect: "allow" as const })) };
    const { store, directory } = directoryFor(NORTHFIELD, { authorizer: allowAll });
    const before = await store.load();

    await rejectsWith(directory.roster(RB_ADMIN, BIO_FALL), "not-found");
    await rejectsWith(directory.getTerm(RB_ADMIN, FALL), "not-found");
    await rejectsWith(directory.createTerm(RB_ADMIN, { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" }), "forbidden");
    await rejectsWith(directory.deactivateEnrollment(RB_ADMIN, EnrollmentId.parse("enr_nf-02")), "not-found");
    expect(await directory.listSchools(RB_ADMIN)).toEqual([]);
    // The authorizer is still asked, so an auditing one records the attempt (SCHO-54).
    expect(allowAll.authorize).toHaveBeenCalledWith(expect.objectContaining({ subject: RB_ADMIN.principal }));
    expect(await store.load()).toEqual(before);
  });

  it("denies a principal from another district who names themselves as a Northfield district", async () => {
    // The verified district is Northfield, but the principal only exists in Riverbend.
    const { directory } = directoryFor();
    const impostor = nf("prn_rb-district-admin");
    await rejectsWith(directory.getTerm(impostor, FALL), "not-found");
    expect(await directory.listSchools(impostor)).toEqual([]);
  });

  it("gives the role-table authorizer's cross-district denial its reason", async () => {
    const store = InMemoryAcademicStore.seeded(RIVERBEND);
    const authorizer = new RoleTableAuthorizer(storePrincipalFacts(store));
    const decision = await authorizer.authorize({
      subject: RB_ADMIN.principal,
      action: "read",
      resource: { kind: "school", id: "sch_nf-high", scope: { level: "school", districtId: "dst_northfield", schoolId: "sch_nf-high" }, classification: "district-internal" },
      context: { channel: "http" },
    });
    expect(decision).toEqual({ effect: "deny", reason: "cross-district" });
  });

  it("authorizes from stored records, passing the offering's term state", async () => {
    const authorize = vi.fn(async () => ({ effect: "deny" as const, reason: "no-matching-grant" as const }));
    const { directory } = directoryFor(NORTHFIELD, { authorizer: { authorize } });
    await rejectsWith(directory.roster(NF.morgan, OfferingId.parse("off_nf-bio-spring-p4")), "not-found");
    expect(authorize).toHaveBeenCalledWith({
      subject: NF.morgan.principal,
      action: "list",
      resource: {
        kind: "enrollment",
        scope: { level: "offering", districtId: "dst_northfield", schoolId: "sch_nf-high", offeringId: "off_nf-bio-spring-p4" },
        classification: "course",
      },
      context: { channel: "http", termState: "completed" },
    });
  });
});

describe("principal lifecycle", () => {
  const AMARA = PrincipalId.parse("prn_nf-student-amara");

  it("graduates a principal without deleting anything, ending the roles they held", async () => {
    const { store, directory } = directoryFor();
    const before = (await store.load()).snapshot;
    const graduated = await directory.setPrincipalStatus(NF.admin, NF.morgan.principal.principalId, "graduated");
    expect(graduated.status).toBe("graduated");

    const after = (await store.load()).snapshot;
    expect(after.principals.find((p) => p.id === graduated.id)).toStrictEqual(graduated);
    // Their enrollments and role assignments stay on record...
    expect(after.enrollments).toStrictEqual(before.enrollments);
    expect(after.roleAssignments).toStrictEqual(before.roleAssignments);
    // ...but grant nothing from the next decision on.
    await rejectsWith(directory.roster(NF.morgan, BIO_FALL), "not-found");
    // Repeating it changes nothing, and inactive is reachable from graduated too.
    const { version } = await store.load();
    await directory.setPrincipalStatus(NF.admin, graduated.id, "graduated");
    expect((await store.load()).version).toBe(version);
    expect((await directory.setPrincipalStatus(NF.admin, graduated.id, "inactive")).status).toBe("inactive");
  });

  it("is a district administrator's decision alone", async () => {
    const { store, directory } = directoryFor();
    const before = await store.load();
    // A school admin, a teacher and the student themselves cannot, and only learn that it exists
    // where they could already see it.
    await rejectsWith(directory.setPrincipalStatus(NF.highPrincipal, AMARA, "graduated"), "not-found");
    await rejectsWith(directory.setPrincipalStatus(NF.morgan, AMARA, "graduated"), "not-found");
    await rejectsWith(directory.setPrincipalStatus(NF.amara, AMARA, "graduated"), "not-found");
    await rejectsWith(directory.setPrincipalStatus(RB_ADMIN, AMARA, "graduated"), "not-found");
    expect(await store.load()).toStrictEqual(before);
  });

  it("leaves principals a roster owns to that roster, and never reactivates", async () => {
    const roster = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    await rejectsWith(roster.directory.setPrincipalStatus(NF.admin, AMARA, "graduated"), "conflict");
    const local = directoryFor();
    await rejectsWith(local.directory.setPrincipalStatus(NF.admin, AMARA, "active" as never), "validation-failed");
    await rejectsWith(local.directory.setPrincipalStatus(NF.admin, PrincipalId.parse("prn_nobody"), "graduated"), "not-found");
  });
});

describe("local authoring (SCHO-186)", () => {
  const ISSUER = NORTHFIELD.district.trustedIssuers[0]!;

  it("archives and restores a course and an offering, refusing new offerings and enrollments while archived", async () => {
    const at = new Date("2026-11-02T10:00:00.000Z");
    const store = InMemoryAcademicStore.seeded(NORTHFIELD);
    const directory = new AcademicDirectory({ store, authority: ALL_LOCAL, authorizer: new RoleTableAuthorizer(storePrincipalFacts(store)), now: () => at });
    const course = NORTHFIELD.courses[0]!;
    const archived = await directory.setCourseArchived(NF.admin, course.id, true);
    expect(archived.archivedAt).toBe(at.toISOString());
    expect(await directory.setCourseArchived(NF.admin, course.id, true)).toStrictEqual(archived);
    const offering = NORTHFIELD.offerings.find((o) => o.courseId === course.id)!;
    await rejectsWith(
      directory.createOffering(NF.admin, { schoolId: offering.schoolId, termId: offering.termId, courseId: course.id, sectionName: "Period 9" }),
      "conflict",
    );
    // Archiving keeps the record readable.
    expect((await directory.getCourse(NF.admin, course.id)).archivedAt).toBe(at.toISOString());
    expect(await directory.setCourseArchived(NF.admin, course.id, false)).toStrictEqual(course);

    await directory.setOfferingArchived(NF.admin, BIO_FALL, true);
    await rejectsWith(
      directory.createEnrollment(NF.admin, { offeringId: BIO_FALL, principalId: PrincipalId.parse("prn_nf-student-felix"), role: "student" }),
      "conflict",
    );
    await directory.setOfferingArchived(NF.admin, BIO_FALL, false);
    await directory.createEnrollment(NF.admin, { offeringId: BIO_FALL, principalId: PrincipalId.parse("prn_nf-student-felix"), role: "student" });
  });

  it("refuses to archive what an external system owns, naming it", async () => {
    const { directory } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const error = await rejectsWith(directory.setOfferingArchived(NF.admin, BIO_FALL, true), "conflict");
    expect(error.message).toContain("external:oneroster");
  });

  it("creates a local principal who can then be enrolled, with an identity from a trusted issuer only", async () => {
    const { directory } = directoryFor(emptyNorthfield());
    const robin = await directory.createPrincipal(NF.admin, { kind: "student", displayName: "Robin Park", identity: { issuer: ISSUER, subject: "co-op-robin" } });
    expect(robin).toMatchObject({ kind: "student", status: "active", externalIdentities: [{ districtId: "dst_northfield", issuer: ISSUER, subject: "co-op-robin" }] });
    await rejectsWith(directory.createPrincipal(NF.admin, { kind: "student", displayName: "Robin Again", identity: { issuer: ISSUER, subject: "co-op-robin" } }), "validation-failed");
    await rejectsWith(directory.createPrincipal(NF.admin, { kind: "staff", displayName: "Elsewhere", identity: { issuer: "https://untrusted.example", subject: "x" } }), "validation-failed");
    await rejectsWith(directory.createPrincipal(NF.admin, { kind: "guardian", displayName: "Parent", identity: { issuer: ISSUER, subject: "p" } } as never), "validation-failed");
  });

  it("leaves principal creation to the roster where it owns principals, and to administrators", async () => {
    const roster = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const error = await rejectsWith(roster.directory.createPrincipal(NF.admin, { kind: "student", displayName: "Robin", identity: { issuer: ISSUER, subject: "r" } }), "conflict");
    expect(error.message).toContain("external:oneroster");
    const local = directoryFor();
    await rejectsWith(local.directory.createPrincipal(NF.morgan, { kind: "student", displayName: "Robin", identity: { issuer: ISSUER, subject: "r" } }), "forbidden");
  });
});

describe("managing people (SCHO-212)", () => {
  const ISSUER = NORTHFIELD.district.trustedIssuers[0]!;
  const ADMIN = NF.admin.principal.principalId;
  const RIVERA = PrincipalId.parse("prn_nf-teacher-rivera");
  const AMARA = PrincipalId.parse("prn_nf-student-amara");
  const admins = async (store: InMemoryAcademicStore) => {
    const { snapshot } = await store.load();
    return snapshot.principals.filter((p) => isDistrictAdmin(snapshot, p.id, new Date())).map((p) => p.id);
  };

  it("corrects a person added as a student into staff, and edits their name and email", async () => {
    const { directory } = directoryFor(emptyNorthfield());
    const added = await directory.createPrincipal(NF.admin, { kind: "student", displayName: "Co-op Admin", email: "a@example.org", identity: { issuer: ISSUER, subject: "co-op-admin" } });
    const fixed = await directory.updatePrincipal(NF.admin, added.id, { kind: "staff", displayName: "Co-op Administrator" });
    expect(fixed).toMatchObject({ kind: "staff", displayName: "Co-op Administrator", email: "a@example.org", status: "active" });
    // The sign-in that finds them never changes.
    expect(fixed.externalIdentities).toStrictEqual(added.externalIdentities);
    const cleared = await directory.updatePrincipal(NF.admin, added.id, { email: null });
    expect(cleared).not.toHaveProperty("email");
    expect(await directory.updatePrincipal(NF.admin, added.id, {})).toStrictEqual(cleared);
  });

  it("refuses a change of kind while the person holds an enrollment or a role, active or not", async () => {
    const { directory } = directoryFor();
    const enrolled = await rejectsWith(directory.updatePrincipal(NF.admin, AMARA, { kind: "staff" }), "conflict");
    expect(enrolled.message).toContain("enrollments");
    // Dropping them from every class still leaves the records their kind is bound to.
    const { snapshot } = await directoryFor().store.load();
    for (const enrollment of snapshot.enrollments.filter((e) => e.principalId === AMARA)) await directory.deactivateEnrollment(NF.admin, enrollment.id);
    await rejectsWith(directory.updatePrincipal(NF.admin, AMARA, { kind: "staff" }), "conflict");
    await rejectsWith(directory.updatePrincipal(NF.admin, ADMIN, { kind: "student" }), "conflict");
    // Changing other fields is still allowed, as is naming the kind they already have.
    expect((await directory.updatePrincipal(NF.admin, AMARA, { kind: "student", displayName: "Amara O." })).displayName).toBe("Amara O.");
  });

  it("leaves editing people to district administrators, and to the roster where it owns them", async () => {
    const { store, directory } = directoryFor();
    const before = await store.load();
    await rejectsWith(directory.updatePrincipal(NF.highPrincipal, AMARA, { displayName: "X" }), "not-found");
    await rejectsWith(directory.updatePrincipal(NF.amara, AMARA, { displayName: "X" }), "not-found");
    await rejectsWith(directory.updatePrincipal(RB_ADMIN, AMARA, { displayName: "X" }), "not-found");
    await rejectsWith(directory.reactivatePrincipal(NF.amara, AMARA), "not-found");
    await rejectsWith(directory.grantDistrictAdmin(NF.morgan, RIVERA), "not-found");
    await rejectsWith(directory.updatePrincipal(NF.admin, AMARA, { districtId: "dst_x" } as never), "validation-failed");
    expect(await store.load()).toStrictEqual(before);
    const roster = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    await rejectsWith(roster.directory.updatePrincipal(NF.admin, AMARA, { displayName: "X" }), "conflict");
    await rejectsWith(roster.directory.reactivatePrincipal(NF.admin, AMARA), "conflict");
  });

  it("reactivates a departed principal, restoring the roles kept on record", async () => {
    const { directory } = directoryFor();
    await directory.setPrincipalStatus(NF.admin, NF.morgan.principal.principalId, "inactive");
    await rejectsWith(directory.roster(NF.morgan, BIO_FALL), "not-found");
    const back = await directory.reactivatePrincipal(NF.admin, NF.morgan.principal.principalId);
    expect(back.status).toBe("active");
    expect((await directory.roster(NF.morgan, BIO_FALL)).length).toBeGreaterThan(0);
    expect(await directory.reactivatePrincipal(NF.admin, back.id)).toStrictEqual(back);
  });

  it("makes staff district administrators, once, and never a student or an inactive person", async () => {
    const { store, directory } = directoryFor(emptyNorthfield());
    const grant = await directory.grantDistrictAdmin(NF.admin, RIVERA);
    expect(grant).toStrictEqual({ principalId: RIVERA, role: "district-admin", scope: { level: "district", districtId: "dst_northfield" }, source: "local-grant" });
    const { version } = await store.load();
    await directory.grantDistrictAdmin(NF.admin, RIVERA);
    expect((await store.load()).version).toBe(version);
    expect(await admins(store)).toEqual([ADMIN, RIVERA]);
    expect((await rejectsWith(directory.grantDistrictAdmin(NF.admin, AMARA), "conflict")).message).toContain("Only staff");
  });

  it("takes administration away, but never the last administrator's or one's own", async () => {
    const { store, directory } = directoryFor(emptyNorthfield());
    expect((await rejectsWith(directory.revokeDistrictAdmin(NF.admin, ADMIN), "conflict")).message).toContain("yourself");
    await directory.grantDistrictAdmin(NF.admin, RIVERA);
    const rivera = nf("prn_nf-teacher-rivera");
    await directory.revokeDistrictAdmin(rivera, ADMIN);
    expect(await admins(store)).toEqual([RIVERA]);
    // Now Rivera is the last one: they cannot remove themself, deactivate themself, or be deactivated.
    await rejectsWith(directory.revokeDistrictAdmin(rivera, RIVERA), "conflict");
    await rejectsWith(directory.setPrincipalStatus(rivera, RIVERA, "inactive"), "conflict");
    // Revoking from someone who is not an administrator changes nothing.
    const { version } = await store.load();
    await directory.revokeDistrictAdmin(rivera, AMARA);
    expect((await store.load()).version).toBe(version);
  });

  it("refuses to take away administration a roster projected", async () => {
    const snapshot = emptyNorthfield();
    const projected = { ...snapshot, roleAssignments: [...snapshot.roleAssignments, { principalId: RIVERA, role: "district-admin" as const, scope: { level: "district" as const, districtId: snapshot.district.id }, source: "roster" as const }] };
    const { directory } = directoryFor(projected);
    expect((await rejectsWith(directory.revokeDistrictAdmin(NF.admin, RIVERA), "conflict")).message).toContain("roster");
  });
});
