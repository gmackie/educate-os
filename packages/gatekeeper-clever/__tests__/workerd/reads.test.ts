// What each binding reaches, against the Data API fake over the sample district: a teacher only
// the sections they teach, a student only their own, an administrator the district, re-checked on
// every call; rosters by ID, name and grade only, whatever else the records hold; and every read
// authorized as an observation before it returns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binding, failure, FakeClever, hooks, unwrap } from "./fake-clever";

const fake = new FakeClever();

beforeEach(() => {
  fake.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BIO_P2 = () => fake.section("mw-bio-p2");
const ENG9 = () => fake.section("mw-eng9-p1");

describe("a teacher's sections", () => {
  it("lists only the sections the teacher teaches", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "teacher" });
    const sections = unwrap(await hooks().run(name, props, [["listSections"]])) as { id: string; name: string; school: unknown; term: unknown }[];
    expect(sections.map(section => section.id).toSorted()).toEqual([BIO_P2(), fake.section("mw-bio-p4")].toSorted());
    expect(sections[0]).toMatchObject({
      courseName: "Biology", school: { id: fake.school("mw-hs"), name: "Maplewood High School" },
      term: { name: "Fall 2026", startDate: "2026-08-17", endDate: "2026-12-18" },
    });
    const { observations } = await hooks().queueLog(name);
    expect(observations.map(o => o.title)).toEqual(["List Clever sections"]);
  });

  it("refuses a section another teacher teaches, as if it did not exist", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "teacher" });
    const refused = failure(await hooks().run(name, props, [["section", ENG9()]]));
    const missing = failure(await hooks().run(name, props, [["section", "0123456789abcdef01234567"]]));
    expect(refused).toBe(missing);
    expect(refused).toMatch(/No such section/);
  });

  it("refuses a one-section binding of another teacher's section from describe on", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: ENG9() });
    expect(failure(await hooks().describe(name, props))).toMatch(/No such section/);
    expect(failure(await hooks().run(name, props, [["getRoster"]]))).toMatch(/No such section/);
  });

  it("stops reaching a section once the teacher leaves its roster", async () => {
    const { name, props } = await binding(fake, "mw-t-quill", { kind: "section", sectionId: ENG9() });
    unwrap(await hooks().run(name, props, [["getSection"]]));
    fake.data.updateSection("mw-eng9-p1", { teacherIds: ["mw-t-reyes"] });
    try {
      expect(failure(await hooks().run(name, props, [["getSection"]]))).toMatch(/No such section/);
    } finally {
      fake.data.updateSection("mw-eng9-p1", { teacherIds: ["mw-t-quill", "mw-t-reyes"] });
    }
  });

  it("reads the roster by ID, name and grade only, never contact details", async () => {
    // Every user record the fake serves carries an email address.
    fake.data.updatePerson("mw-s-01", { email: "ada.brightwater@maplewood.example", middleName: "Q" });
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    const roster = unwrap(await hooks().run(name, props, [["getRoster"]])) as { teachers: object[]; students: { id: string }[] };
    expect(roster.teachers).toEqual([{ id: fake.user("mw-t-okafor"), name: "Nia Okafor" }]);
    expect(roster.students).toHaveLength(6);
    expect(roster.students.find(student => student.id === fake.user("mw-s-01"))).toEqual({ id: fake.user("mw-s-01"), name: "Ada Brightwater", grade: "9" });
    for (const member of [...roster.teachers, ...roster.students]) {
      expect(Object.keys(member).every(key => ["id", "name", "grade"].includes(key))).toBe(true);
    }
    expect(JSON.stringify(roster)).not.toMatch(/@|maplewood\.example|S100/);
    expect((await hooks().queueLog(name)).observations.map(o => o.title)).toEqual(["Read Clever roster"]);
  });

  it("returns nothing whose observation the approval queue refused", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    await hooks().refuseObservations(name, true);
    expect(failure(await hooks().run(name, props, [["getRoster"]]))).toMatch(/refused this observation/);
  });
});

describe("a student's classes", () => {
  it("lists only the student's own sections", async () => {
    const { name, props } = await binding(fake, "mw-s-01", { kind: "student" });
    const sections = unwrap(await hooks().run(name, props, [["listSections"]])) as { id: string }[];
    expect(sections.map(section => section.id).toSorted()).toEqual([BIO_P2(), ENG9()].toSorted());
  });

  it("shows a section's teachers and never its classmates", async () => {
    const { name, props } = await binding(fake, "mw-s-01", { kind: "studentSection", sectionId: BIO_P2() });
    expect(unwrap(await hooks().run(name, props, [["getTeachers"]]))).toEqual([{ id: fake.user("mw-t-okafor"), name: "Nia Okafor" }]);
    // The student binding has no roster at all.
    expect(failure(await hooks().run(name, props, [["getRoster"]]))).toMatch(/getRoster|not a function|does not exist|not found/i);
  });

  it("refuses a section the student is not enrolled in", async () => {
    const { name, props } = await binding(fake, "mw-s-01", { kind: "student" });
    expect(failure(await hooks().run(name, props, [["section", fake.section("mw-alg-p3")]]))).toMatch(/No such section/);
    const one = await binding(fake, "mw-s-01", { kind: "studentSection", sectionId: fake.section("mw-alg-p3") });
    expect(failure(await hooks().describe(one.name, one.props))).toMatch(/No such section/);
  });
});

describe("a profile", () => {
  it("says who the user is, their roles, district and schools, and nothing else", async () => {
    const { name, props } = await binding(fake, "mw-t-reyes", { kind: "profile" });
    expect(unwrap(await hooks().run(name, props, [["getProfile"]]))).toEqual({
      id: fake.user("mw-t-reyes"),
      name: "Marisol Reyes",
      roles: ["teacher"],
      districtName: "Maplewood Unified (synthetic)",
      schools: [
        { id: fake.school("mw-hs"), name: "Maplewood High School" },
        { id: fake.school("mw-ms"), name: "Maplewood Middle School" },
      ],
    });
  });
});

describe("the district-wide connection", () => {
  it("can be granted only by a district administrator", async () => {
    const teacher = await binding(fake, "mw-t-okafor", { kind: "district" });
    expect(failure(await hooks().describe(teacher.name, teacher.props))).toMatch(/Only a Clever district administrator/);
    expect(failure(await hooks().run(teacher.name, teacher.props, [["listSchools"]]))).toMatch(/Only a Clever district administrator/);
    const staff = await binding(fake, "mw-staff-lund", { kind: "district" });
    expect(failure(await hooks().describe(staff.name, staff.props))).toMatch(/Only a Clever district administrator/);
    const admin = await binding(fake, "mw-admin-varga", { kind: "district" });
    expect(unwrap(await hooks().describe(admin.name, admin.props))).toMatchObject({ tsType: "CleverDistrictSession" });
  });

  it("reaches every section, in one school or all", async () => {
    const { name, props } = await binding(fake, "mw-admin-varga", { kind: "district" });
    const all = unwrap(await hooks().run(name, props, [["listSections"]])) as { id: string }[];
    expect(all).toHaveLength(4);
    const schools = unwrap(await hooks().run(name, props, [["listSchools"]])) as { id: string; name: string }[];
    expect(schools.map(school => school.name).toSorted()).toEqual(["Maplewood High School", "Maplewood Middle School"]);
    const ms = unwrap(await hooks().run(name, props, [["listSections", { schoolId: fake.school("mw-ms") }]]));
    expect(ms).toEqual([]);
    const roster = unwrap(await hooks().run(name, props, [["section", ENG9()], ["getRoster"]])) as { students: unknown[] };
    expect(roster.students).toHaveLength(5);
  });

  it("re-checks the administrator role on every call", async () => {
    const { name, props } = await binding(fake, "mw-admin-varga", { kind: "district" });
    unwrap(await hooks().run(name, props, [["listSchools"]]));
    // The role is read through a cache of at most a minute: move past it.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    fake.data.updatePerson("mw-admin-varga", { role: "staff" });
    try {
      vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
      expect(failure(await hooks().run(name, props, [["listSchools"]]))).toMatch(/Only a Clever district administrator/);
    } finally {
      vi.restoreAllMocks();
      fake.data.updatePerson("mw-admin-varga", { role: "administrator" });
    }
  });
});
