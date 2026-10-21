import { DistrictDirectorySnapshot, SchoolOsError, checkDirectoryIntegrity } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import { loadExport } from "./fixtures/load.ts";
import { buildExport } from "./fixtures/northfield-export.ts";
import type { Variant } from "./fixtures/northfield-export.ts";

const ISSUER = "https://idp.northfield.example";
const CONFIG: oneroster.OneRosterImportConfig = { issuer: ISSUER, subject: { field: "username" } };
const NOW = new Date("2026-10-20T15:00:00Z");

/** Northfield's district record with an empty directory: the state before any import. */
const EMPTY: oneroster.RosterState = {
  snapshot: DistrictDirectorySnapshot.parse({
    district: NORTHFIELD.district,
    schools: [],
    terms: [],
    courses: [],
    offerings: [],
    principals: [],
    enrollments: [],
    roleAssignments: [],
  }),
  sources: oneroster.EMPTY_SOURCE_MAP,
};

type Files = oneroster.OneRosterCsvFiles;
const exportOf = (variant: Variant): Files => loadExport(variant);

/** Edits the Northfield export: each replacement applies to one file. */
function edited(replacements: Record<string, [string, string][]>): Files {
  const files: Record<string, string> = buildExport("northfield");
  for (const [name, pairs] of Object.entries(replacements)) {
    for (const [from, to] of pairs) {
      const before = files[name]!;
      files[name] = before.replaceAll(from, to);
      if (files[name] === before) throw new Error(`${from} not found in ${name}`);
    }
  }
  return files;
}

async function apply(current: oneroster.RosterState, files: Files, options: Partial<oneroster.OneRosterImportInput> = {}) {
  return oneroster.applyOneRosterImport({ current, files, config: CONFIG, now: NOW, ...options });
}

async function applied(current: oneroster.RosterState, files: Files, options: Partial<oneroster.OneRosterImportInput> = {}) {
  const result = await apply(current, files, options);
  if (!result.applied) throw new Error(JSON.stringify(result.preview, null, 2));
  return result;
}

/** The ID of the principal the roster made for a OneRoster user. */
function principalOf(state: oneroster.RosterState, sourcedId: string) {
  const entry = Object.entries(state.sources.principals).find(([, s]) => s.sourcedId === sourcedId);
  if (!entry) throw new Error(`no principal for ${sourcedId}`);
  const principal = state.snapshot.principals.find((p) => p.id === entry[0]);
  return { id: entry[0], active: principal?.status === "active", principal };
}

function enrollmentOf(state: oneroster.RosterState, sourcedId: string) {
  const id = Object.entries(state.sources.enrollments).find(([, s]) => s === sourcedId)?.[0];
  return state.snapshot.enrollments.find((e) => e.id === id);
}

/**
 * A snapshot in terms both a roster import and the hand-written fixture share (names, titles and
 * subjects, never IDs), so the two can be compared.
 */
function described(snapshot: DistrictDirectorySnapshot) {
  const name = new Map(snapshot.principals.map((p) => [p.id, p.displayName]));
  const offering = new Map(snapshot.offerings.map((o) => {
    const course = snapshot.courses.find((c) => c.id === o.courseId)!;
    const term = snapshot.terms.find((t) => t.id === o.termId)!;
    return [o.id, `${course.title} ${o.sectionName} ${term.name}`];
  }));
  return {
    schools: snapshot.schools.map((s) => s.name).toSorted(),
    terms: snapshot.terms.map((t) => `${t.name} ${t.startsOn} ${t.endsOn} ${t.state}`).toSorted(),
    principals: snapshot.principals.map((p) => `${p.displayName} ${p.kind} ${p.email ?? "-"} ${p.externalIdentities.map((i) => i.subject).join()}`).toSorted(),
    enrollments: snapshot.enrollments.map((e) => `${offering.get(e.offeringId)}: ${name.get(e.principalId)} ${e.role} ${e.status}`).toSorted(),
  };
}

async function stateAt(now: string) {
  const { next } = await applied(EMPTY, exportOf("northfield"), { now: new Date(now) });
  return Object.fromEntries(next.snapshot.terms.map((t) => [t.name, t.state]));
}

describe("first import", () => {
  it("produces a directory equivalent to the hand-written Northfield fixture", async () => {
    const { next, preview } = await applied(EMPTY, exportOf("northfield"));
    expect(checkDirectoryIntegrity(next.snapshot)).toEqual([]);
    expect(described(next.snapshot)).toEqual(described(NORTHFIELD));
    expect(preview.changes.principals.added).toHaveLength(11);
    expect(preview.changes.enrollments.added).toHaveLength(17);
    expect(oneroster.hasChanges(preview.changes)).toBe(true);
  });

  it("maps only school orgs, with grade bands from their classes, and only term and semester sessions", async () => {
    const { next } = await applied(EMPTY, exportOf("northfield"));
    expect(next.snapshot.schools.map((s) => [s.name, s.gradeBands])).toEqual([
      ["Northfield High School", ["9-11"]],
      ["Northfield Middle School", ["7"]],
    ]);
    expect(Object.values(next.sources.terms).toSorted()).toEqual(["sem-2026-fall", "sem-2026-spring"]);
  });

  it("puts a class named by grading period or school year in its semester", async () => {
    const { next } = await applied(EMPTY, exportOf("northfield"));
    const fall = Object.entries(next.sources.terms).find(([, s]) => s === "sem-2026-fall")![0];
    const termOf = (sourcedId: string) =>
      next.snapshot.offerings.find((o) => next.sources.offerings[o.id] === sourcedId)?.termId;
    expect(termOf("cls-eng9-fall-p3")).toBe(fall);
    expect(termOf("cls-ushist-fall-p5")).toBe(fall);
  });

  it("maps subjects through the explicit tables, falling back to other", async () => {
    const { next } = await applied(EMPTY, exportOf("northfield"));
    expect(Object.fromEntries(next.snapshot.courses.map((c) => [c.title, c.subject]))).toEqual({
      "Biology I": "science",
      "English 9": "english-language-arts",
      "United States History": "history-social-studies",
      "Mathematics 7": "mathematics",
      "Advisory, Grade 9": "other",
    });
    expect(oneroster.subjectFor(["constructor"], [])).toBe("other");
  });

  it("computes term states from the injected time, on the district's calendar", async () => {
    expect(await stateAt("2026-03-01T12:00:00Z")).toEqual({ "Spring 2026": "active", "Fall 2026": "planned" });
    // 03:00 UTC on 31 August is still 30 August in Detroit, the day before Fall starts.
    expect(await stateAt("2026-08-31T03:00:00Z")).toEqual({ "Spring 2026": "completed", "Fall 2026": "planned" });
    expect(await stateAt("2026-08-31T05:00:00Z")).toEqual({ "Spring 2026": "completed", "Fall 2026": "active" });
  });

  it("keeps a term the district moved into grading there after its end date", async () => {
    const first = await applied(EMPTY, exportOf("northfield"), { now: new Date("2026-06-01T12:00:00Z") });
    const grading: oneroster.RosterState = {
      ...first.next,
      snapshot: {
        ...first.next.snapshot,
        terms: first.next.snapshot.terms.map((t) => (t.name === "Spring 2026" ? { ...t, state: "grading" } : t)),
      },
    };
    const { next } = await applied(grading, exportOf("northfield"), { now: new Date("2026-07-01T12:00:00Z") });
    expect(next.snapshot.terms.find((t) => t.name === "Spring 2026")?.state).toBe("grading");
  });

  it("makes a tobedeleted enrollment inactive rather than leaving it out", async () => {
    const { next } = await applied(EMPTY, exportOf("northfield"));
    expect(enrollmentOf(next, "e-10")?.status).toBe("inactive");
  });

  it("derives the same opaque IDs from the same sourcedIds on every import", async () => {
    const [a, b] = await Promise.all([applied(EMPTY, exportOf("northfield")), applied(EMPTY, exportOf("northfield"))]);
    expect(b.next).toEqual(a.next);
    const amara = principalOf(a.next, "u-amara");
    expect(amara.id).toMatch(/^prn_or-[0-9a-f]{32}$/);
    expect(amara.id).toBe(await oneroster.derivedId(NORTHFIELD.district.id, "principals", "u-amara"));
    expect(JSON.stringify(a.next.snapshot)).not.toContain("u-amara");
    expect(Object.keys(a.next.sources.enrollments).every((id) => /^enr_or-[0-9a-f]{32}$/.test(id))).toBe(true);
  });

  it("does not import guardians", async () => {
    const { next, preview } = await applied(EMPTY, exportOf("northfield"));
    expect(next.snapshot.principals.some((p) => p.displayName === "Ngozi Okafor")).toBe(false);
    expect(preview.issues).toContainEqual(expect.objectContaining({ severity: "warning", file: "users.csv", row: 13 }));
  });

  it("grants teaching and school roles from the roster, but never district administration", async () => {
    const { next, preview } = await applied(EMPTY, exportOf("northfield"));
    const name = new Map(next.snapshot.principals.map((p) => [p.id, p.displayName]));
    const roles = next.snapshot.roleAssignments.map((a) => `${name.get(a.principalId)} ${a.role} ${a.scope.level} ${a.source}`);
    expect(roles.toSorted()).toEqual([
      "Casey Patel teacher offering roster",
      "Jordan Principal school-admin school roster",
      "Morgan Lee teacher offering roster",
      "Morgan Lee teacher offering roster",
      "Riley Chen co-teacher offering roster",
      "Riley Chen teacher offering roster",
      "Sam Rivera teacher offering roster",
    ]);
    expect(preview.issues).toContainEqual(expect.objectContaining({ file: "roles.csv", column: "role", message: expect.stringContaining("districtAdministrator") }));
  });

  it("does not modify the state it is given", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const before = structuredClone(first.next);
    await apply(first.next, exportOf("dropped-student"));
    expect(first.next).toEqual(before);
  });
});

describe("identity linking", () => {
  it.each<[oneroster.IdpSubjectField, string]>([
    [{ field: "username" }, "nf-s-2001"],
    [{ field: "identifier" }, "2001"],
    [{ field: "userIds", type: "idp" }, "nf-s-2001"],
    [{ field: "userIds", type: "sis" }, "2001"],
  ])("reads the IdP subject from %j", async (subject, expected) => {
    const { next } = await applied(EMPTY, exportOf("northfield"), { config: { issuer: ISSUER, subject } });
    expect(principalOf(next, "u-amara").principal?.externalIdentities).toEqual([
      { districtId: NORTHFIELD.district.id, issuer: ISSUER, subject: expected },
    ]);
  });

  it("quarantines a user with no subject and holds back their enrollments", async () => {
    const files = edited({ "users.csv": [["u-felix,,,true,nf-s-2005,", "u-felix,,,true,,"]] });
    const { next, preview } = await applied(EMPTY, files);
    expect(preview.quarantined).toEqual([
      { sourcedId: "u-felix", row: 12, reason: "missing-subject", message: "has no username", heldEnrollments: 1 },
    ]);
    expect(next.snapshot.principals.some((p) => p.displayName === "Felix Brandt")).toBe(false);
    expect(enrollmentOf(next, "e-17")).toBeUndefined();
  });

  it("quarantines every user that shares a subject, and imports the rest", async () => {
    const { next, preview } = await applied(EMPTY, exportOf("duplicate-username"));
    expect(preview.quarantined.map(({ sourcedId, reason, heldEnrollments }) => [sourcedId, reason, heldEnrollments])).toEqual([
      ["u-dmitri", "duplicate-subject", 3],
      ["u-elena", "duplicate-subject", 3],
    ]);
    expect(next.snapshot.principals).toHaveLength(9);
    expect(next.snapshot.enrollments).toHaveLength(11);
    expect(preview.canApply).toBe(true);
  });

  it("never treats email as identity: siblings sharing an address stay two principals", async () => {
    const { next } = await applied(EMPTY, exportOf("northfield"));
    const okafors = next.snapshot.principals.filter((p) => p.email === "family.okafor@northfield.example");
    expect(okafors.map((p) => p.displayName).toSorted()).toEqual(["Amara Okafor", "Chidi Okafor"]);
  });

  it("does not link a user to an existing principal that only shares their email", async () => {
    const local = { ...EMPTY.snapshot.district, id: NORTHFIELD.district.id };
    const current: oneroster.RosterState = {
      sources: oneroster.EMPTY_SOURCE_MAP,
      snapshot: {
        ...EMPTY.snapshot,
        district: local,
        principals: [{
          id: "prn_local-okafor" as never,
          districtId: local.id,
          kind: "student",
          status: "active",
          displayName: "A. Okafor",
          email: "family.okafor@northfield.example",
          externalIdentities: [{ districtId: local.id, issuer: ISSUER, subject: "someone-else" }],
        }],
      },
    };
    const { next, preview } = await applied(current, exportOf("northfield"));
    expect(preview.linked).toEqual([]);
    expect(principalOf(next, "u-amara").id).not.toBe("prn_local-okafor");
  });

  it("links roster users to existing principals with the same issuer and subject, keeping their IDs", async () => {
    const { next, preview } = await applied({ snapshot: NORTHFIELD, sources: oneroster.EMPTY_SOURCE_MAP }, exportOf("northfield"));
    expect(preview.linked).toHaveLength(11);
    expect(preview.changes.principals.added).toEqual([]);
    expect(principalOf(next, "u-amara").id).toBe("prn_nf-student-amara");
    // The hand-made district admin grant survives; roster roles are re-derived from the feed.
    expect(next.snapshot.roleAssignments).toContainEqual(NORTHFIELD.roleAssignments[0]);
    expect(checkDirectoryIntegrity(next.snapshot)).toEqual([]);
  });
});

describe("re-import", () => {
  it("is idempotent: the same feed applied twice changes nothing the second time", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const second = await applied(first.next, exportOf("northfield"));
    expect(oneroster.hasChanges(second.preview.changes)).toBe(false);
    expect(second.next).toEqual(first.next);
  });

  it("deactivates a dropped student and their enrollments, and deletes nothing", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const felix = principalOf(first.next, "u-felix");
    const { next, preview } = await applied(first.next, exportOf("dropped-student"));

    expect(preview.changes.principals).toEqual({ added: [], updated: [], deactivated: [felix.id], retained: [] });
    expect(preview.changes.enrollments.deactivated).toEqual([enrollmentOf(first.next, "e-17")!.id]);
    expect(principalOf(next, "u-felix")).toEqual({ ...felix, active: false, principal: { ...felix.principal, status: "inactive" } });
    expect(enrollmentOf(next, "e-17")?.status).toBe("inactive");
    for (const kind of ["schools", "terms", "courses", "offerings", "principals", "enrollments"] as const) {
      expect(next.snapshot[kind].map((r) => r.id)).toEqual(first.next.snapshot[kind].map((r) => r.id));
    }

    const again = await applied(next, exportOf("dropped-student"));
    expect(oneroster.hasChanges(again.preview.changes)).toBe(false);
    expect(again.preview.changes.principals.retained).toEqual([felix.id]);

    const back = await applied(again.next, exportOf("northfield"));
    expect(back.preview.changes.principals.updated).toEqual([felix.id]);
    expect(back.next).toEqual(first.next);
  });

  it("deactivates a user marked tobedeleted or disabled", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const { next } = await applied(first.next, edited({ "users.csv": [["u-chidi,,,true,", "u-chidi,tobedeleted,,true,"], ["u-felix,,,true,", "u-felix,,,false,"]] }));
    expect(principalOf(next, "u-chidi").active).toBe(false);
    expect(principalOf(next, "u-felix").active).toBe(false);
    expect([enrollmentOf(next, "e-16")?.status, enrollmentOf(next, "e-17")?.status]).toEqual(["inactive", "inactive"]);
  });

  it("quarantines a principal whose subject changed instead of remapping it, and holds its records", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const amara = principalOf(first.next, "u-amara");
    const { next, preview } = await applied(first.next, exportOf("changed-username"));

    expect(preview.quarantined).toEqual([{
      sourcedId: "u-amara",
      row: 8,
      principalId: amara.id,
      reason: "subject-changed",
      message: "was linked to nf-s-2001 and is now nf-s-2001-renamed; SchoolOS will not remap a principal",
      heldEnrollments: 3,
    }]);
    expect(oneroster.hasChanges(preview.changes)).toBe(false);
    expect(principalOf(next, "u-amara")).toEqual(amara);
    expect(["e-02", "e-06", "e-09"].map((e) => enrollmentOf(next, e)?.status)).toEqual(["active", "active", "active"]);
  });

  it("quarantines a re-keyed user rather than handing them the old user's principal", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const amara = principalOf(first.next, "u-amara");
    const rekey: [string, string][] = [["u-amara,", "u-amara-2,"]];
    const { next, preview } = await applied(first.next, edited({ "users.csv": rekey, "roles.csv": [["r-u-amara,,,u-amara,", "r-u-amara-2,,,u-amara-2,"]], "enrollments.csv": rekey }));
    expect(preview.quarantined).toEqual([expect.objectContaining({ sourcedId: "u-amara-2", reason: "subject-in-use" })]);
    expect(preview.changes.principals.deactivated).toEqual([amara.id]);
    expect(principalOf(next, "u-amara").principal).toEqual({ ...amara.principal, status: "inactive" });
  });

  it("quarantines a user whose roles turn a student into staff", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const files = edited({ "roles.csv": [["u-chidi,primary,student", "u-chidi,primary,teacher"]], "enrollments.csv": [["u-chidi,student", "u-chidi,teacher"]] });
    const { preview } = await applied(first.next, files);
    expect(preview.quarantined).toEqual([expect.objectContaining({ sourcedId: "u-chidi", reason: "kind-changed" })]);
  });

  it("refuses to move an enrollment to a different user", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const result = await apply(first.next, edited({ "enrollments.csv": [["e-02,,,cls-bio-fall-p2,org-nf-high,u-amara", "e-02,,,cls-bio-fall-p2,org-nf-high,u-felix"]] }));
    expect(result.applied).toBe(false);
    expect(result.preview.issues).toContainEqual(expect.objectContaining({ file: "enrollments.csv", row: 3, column: "sourcedId" }));
  });
});

describe("safe apply", () => {
  it("refuses a feed with a malformed row, so the row's user is not read as gone", async () => {
    const first = await applied(EMPTY, exportOf("northfield"));
    const result = await apply(first.next, exportOf("malformed-row"));
    expect(result.applied).toBe(false);
    expect(result.preview.canApply).toBe(false);
    expect(result.preview.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "enrollments.csv", row: 6, column: "role" }));
    expect("next" in result).toBe(false);
  });

  it("refuses a result that fails checkDirectoryIntegrity", async () => {
    const result = await apply(EMPTY, exportOf("northfield"), { config: { issuer: "https://other-idp.example", subject: { field: "username" } } });
    expect(result.applied).toBe(false);
    expect(result.preview.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.preview.integrity[0]?.message).toContain("is not trusted");
  });

  it("previews without applying", async () => {
    const preview = await oneroster.previewOneRosterImport({ current: EMPTY, files: exportOf("northfield"), config: CONFIG, now: NOW });
    expect(preview.canApply).toBe(true);
    expect(preview.changes.offerings.added).toHaveLength(5);
  });

  it("rejects an invalid config or source map outright", async () => {
    await expect(apply(EMPTY, exportOf("northfield"), { config: { issuer: "http://idp.example", subject: { field: "email" } } as never }))
      .rejects.toBeInstanceOf(SchoolOsError);
    const twice = { ...oneroster.EMPTY_SOURCE_MAP, schools: { "sch_or-a": "org-1", "sch_or-b": "org-1" } } as never;
    await expect(apply({ snapshot: EMPTY.snapshot, sources: twice }, exportOf("northfield"))).rejects.toThrow("two IDs");
  });
});
