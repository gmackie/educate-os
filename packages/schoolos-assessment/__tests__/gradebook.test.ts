// SCHO-187: how a gradebook adds up, and how it is exported.
import { describe, expect, it } from "vitest";
import type { OfferingId, PrincipalId } from "@schoolos/contracts";
import {
  computeGradebook,
  csvField,
  DEFAULT_GRADEBOOK_SETTINGS,
  gradebookCsv,
  GradebookSettings,
  GradeScale,
  letterFor,
  type AssignmentBinding,
  type AssignmentId,
  type GradebookGroupId,
  type GradebookInput,
  type GradeMarker,
  type OfficialGradeVersion,
} from "../src/index.ts";

const OFFERING = "off_nf-bio-fall-p2" as OfferingId;
const AMARA = "prn_nf-student-amara" as PrincipalId;
const ELENA = "prn_nf-student-elena" as PrincipalId;
const TEACHER = "prn_nf-morgan-lee" as PrincipalId;
const STUDENTS = [{ principalId: AMARA, displayName: "Amara Okafor" }, { principalId: ELENA, displayName: "Elena Sato" }];

const id = (name: string) => `asg_${name}` as AssignmentId;
const grp = (name: string) => `grp_${name}` as GradebookGroupId;

function assignment(name: string, dueAt: string, title = name, offeringId: string = OFFERING): AssignmentBinding {
  return {
    id: id(name),
    districtId: "dst_northfield",
    offeringId,
    activityId: `act_${name}`,
    title,
    dueAt,
    latePolicy: { kind: "accept" },
    attemptsAllowed: 1,
    permittedArtifactTypes: ["document"],
    feedbackVisibility: "when-shared",
    createdBy: TEACHER,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as AssignmentBinding;
}

function grade(name: string, student: PrincipalId, points: number, maxPoints: number, version = 1): OfficialGradeVersion {
  return {
    format: "schoolos.official-grade.v1",
    districtId: "dst_northfield",
    offeringId: OFFERING,
    assignmentId: id(name),
    studentPrincipalId: student,
    submissionId: `sub_${name}-${student.slice(4)}`,
    submissionDigest: `sha256:${"a".repeat(64)}`,
    version,
    score: { points, maxPoints },
    approval: { approvedBy: TEACHER, approvedAt: "2026-10-01T00:00:00.000Z", channel: "http" },
  } as OfficialGradeVersion;
}

function marker(name: string, student: PrincipalId, kind: GradeMarker) {
  return { assignmentId: id(name), studentPrincipalId: student, marker: kind, setBy: TEACHER, setAt: "2026-10-02T00:00:00.000Z" };
}

const HW1 = assignment("hw1", "2026-09-10T00:00:00.000Z", "Homework 1");
const HW2 = assignment("hw2", "2026-09-17T00:00:00.000Z", "Homework 2");
const HW3 = assignment("hw3", "2026-09-24T00:00:00.000Z", "Homework 3");
const TEST = assignment("test", "2026-09-30T00:00:00.000Z", "Unit test");

function input(overrides: Partial<GradebookInput> = {}): GradebookInput {
  return {
    offeringId: OFFERING,
    assignments: [TEST, HW3, HW1, HW2],
    versions: [],
    settings: DEFAULT_GRADEBOOK_SETTINGS,
    markers: [],
    students: STUDENTS,
    ...overrides,
  };
}

const settings = (overrides: Partial<GradebookSettings>): GradebookSettings => GradebookSettings.parse({ ...DEFAULT_GRADEBOOK_SETTINGS, ...overrides });
const rowOf = (result: ReturnType<typeof computeGradebook>, student: PrincipalId) => result.rows.find((r) => r.studentPrincipalId === student)!;

describe("gradebook columns", () => {
  it("are the offering's assignments by due date, then title, then ID, keyed by offering and assignment", () => {
    const tie = assignment("hw0", HW1.dueAt, "Homework 1");
    const other = assignment("elsewhere", "2026-09-01T00:00:00.000Z", "Not this class", "off_nf-eng9-fall-p3");
    const { columns } = computeGradebook(input({ assignments: [TEST, tie, HW2, other, HW1, HW3], versions: [grade("hw1", AMARA, 8, 10), grade("hw1", ELENA, 15, 20)] }));
    expect(columns.map((c) => c.assignmentId)).toStrictEqual([id("hw0"), id("hw1"), id("hw2"), id("hw3"), id("test")]);
    expect(columns[1]).toStrictEqual({ offeringId: OFFERING, assignmentId: id("hw1"), title: "Homework 1", dueAt: HW1.dueAt, pointsPossible: 20 });
    expect(columns[2]!.pointsPossible).toBeNull();
  });
});

describe("gradebook cells", () => {
  it("show only the latest official version of each grade", () => {
    const result = computeGradebook(input({ versions: [grade("hw1", AMARA, 4, 10, 1), grade("hw1", AMARA, 9, 10, 2)] }));
    expect(rowOf(result, AMARA).cells[0]).toStrictEqual({ assignmentId: id("hw1"), score: { points: 9, maxPoints: 10 }, version: 2, percent: 90, counted: true, dropped: false });
  });

  it("never show a proposal or a suggested score: an ungraded cell stays empty and uncounted", () => {
    // Proposals and AI or CI suggestions are not official grade versions, so they never reach the input.
    const result = computeGradebook(input({ versions: [grade("hw1", AMARA, 10, 10)] }));
    expect(rowOf(result, ELENA).cells[0]).toStrictEqual({ assignmentId: id("hw1"), percent: null, counted: false, dropped: false });
    expect(rowOf(result, ELENA).totals).toStrictEqual({ points: { earned: 0, possible: 0 }, unweighted: null, weighted: null, final: null, letter: null });
  });
});

describe("gradebook totals", () => {
  const versions = [grade("hw1", AMARA, 8, 10), grade("hw2", AMARA, 5, 10), grade("hw3", AMARA, 10, 10), grade("test", AMARA, 30, 50)];

  it("add up points earned over points possible by default", () => {
    const { totals } = rowOf(computeGradebook(input({ versions })), AMARA);
    expect(totals).toStrictEqual({ points: { earned: 53, possible: 80 }, unweighted: 66.25, weighted: null, final: 66.25, letter: "D" });
  });

  it("count each assignment equally when combining by percent", () => {
    const { totals } = rowOf(computeGradebook(input({ versions, settings: settings({ calculation: "percent" }) })), AMARA);
    // (80 + 50 + 100 + 60) / 4
    expect(totals.unweighted).toBe(72.5);
    expect(totals.letter).toBe("C");
  });

  it("weight groups by their share, scaling weights over the groups that count something", () => {
    const groups = [
      { id: grp("homework"), name: "Homework", weight: 40, dropLowest: 0, assignmentIds: [id("hw1"), id("hw2"), id("hw3")] },
      { id: grp("tests"), name: "Tests", weight: 60, dropLowest: 0, assignmentIds: [id("test")] },
      { id: grp("projects"), name: "Projects", weight: 20, dropLowest: 0, assignmentIds: [] },
    ];
    const result = computeGradebook(input({ versions, settings: settings({ weighting: "group-weights", groups }) }));
    const row = rowOf(result, AMARA);
    // Homework 23/30, tests 30/50; the empty projects group is left out rather than counted as zero.
    expect(row.groups).toStrictEqual([{ groupId: grp("homework"), percent: 76.67 }, { groupId: grp("tests"), percent: 60 }, { groupId: grp("projects"), percent: null }]);
    expect(row.totals.weighted).toBe(66.67);
    expect(row.totals.unweighted).toBe(66.25);
    expect(row.totals.final).toBe(66.67);
    expect(result.columns.map((c) => c.groupId)).toStrictEqual([grp("homework"), grp("homework"), grp("homework"), grp("tests")]);
  });

  it("drop each group's lowest scores, never its last one", () => {
    const groups = [
      { id: grp("homework"), name: "Homework", weight: 50, dropLowest: 1, assignmentIds: [id("hw1"), id("hw2"), id("hw3")] },
      { id: grp("tests"), name: "Tests", weight: 50, dropLowest: 3, assignmentIds: [id("test")] },
    ];
    const row = rowOf(computeGradebook(input({ versions, settings: settings({ weighting: "group-weights", groups }) })), AMARA);
    expect(row.cells.map((c) => [c.assignmentId, c.counted, c.dropped])).toStrictEqual([
      [id("hw1"), true, false],
      [id("hw2"), false, true],
      [id("hw3"), true, false],
      [id("test"), true, false],
    ]);
    expect(row.groups).toStrictEqual([{ groupId: grp("homework"), percent: 90 }, { groupId: grp("tests"), percent: 60 }]);
    expect(row.totals).toMatchObject({ points: { earned: 48, possible: 70 }, weighted: 75, unweighted: 68.57 });
  });

  it("leave excused work out, graded or not", () => {
    const row = rowOf(computeGradebook(input({ versions, markers: [marker("hw2", AMARA, "excused"), marker("hw1", ELENA, "excused")] })), AMARA);
    expect(row.cells[1]).toStrictEqual({ assignmentId: id("hw2"), score: { points: 5, maxPoints: 10 }, version: 1, marker: "excused", percent: 50, counted: false, dropped: false });
    expect(row.totals.points).toStrictEqual({ earned: 48, possible: 70 });
  });

  it("count work marked missing as zero out of the column's points possible, or leave it out, as the setting says", () => {
    const graded = [grade("hw1", AMARA, 8, 10), grade("hw2", ELENA, 10, 10)];
    const missing = [marker("hw2", AMARA, "missing"), marker("hw3", AMARA, "missing")];
    const zero = rowOf(computeGradebook(input({ versions: graded, markers: missing })), AMARA);
    // hw2 is out of 10 (Elena's grade says so); hw3 has no grade yet to say what it is out of.
    expect(zero.cells.slice(1, 3)).toStrictEqual([
      { assignmentId: id("hw2"), marker: "missing", percent: 0, counted: true, dropped: false },
      { assignmentId: id("hw3"), marker: "missing", percent: null, counted: false, dropped: false },
    ]);
    expect(zero.totals).toMatchObject({ points: { earned: 8, possible: 20 }, unweighted: 40 });
    // Combining by percent, missing work is 0% whatever it is out of.
    expect(rowOf(computeGradebook(input({ versions: graded, markers: missing, settings: settings({ calculation: "percent" }) })), AMARA).totals.unweighted).toBe(26.67);
    const excluded = rowOf(computeGradebook(input({ versions: graded, markers: missing, settings: settings({ missing: "exclude" }) })), AMARA);
    expect(excluded.totals).toMatchObject({ points: { earned: 8, possible: 10 }, unweighted: 80 });
  });

  it("count a late grade as it stands, and a late mark alone as nothing", () => {
    const row = rowOf(computeGradebook(input({ versions: [grade("hw1", AMARA, 7, 10)], markers: [marker("hw1", AMARA, "late"), marker("hw2", AMARA, "late")] })), AMARA);
    expect(row.cells[0]).toMatchObject({ marker: "late", counted: true, percent: 70 });
    expect(row.cells[1]).toMatchObject({ marker: "late", counted: false, percent: null });
    expect(row.totals.unweighted).toBe(70);
  });

  it("give no weighted total when no weighted group counts anything", () => {
    const groups = [{ id: grp("tests"), name: "Tests", weight: 100, dropLowest: 0, assignmentIds: [id("test")] }];
    const row = rowOf(computeGradebook(input({ versions: [grade("hw1", AMARA, 9, 10)], settings: settings({ weighting: "group-weights", groups }) })), AMARA);
    expect(row.totals).toMatchObject({ unweighted: 90, weighted: null, final: null, letter: null });
  });
});

describe("grade scale", () => {
  it("gives the first letter whose cutoff the rounded percentage reaches", () => {
    const scale = GradeScale.parse([{ letter: "P", minPercent: 65 }, { letter: "NP", minPercent: 0 }]);
    expect(letterFor(64.995, scale)).toBe("P");
    expect(letterFor(64.99, scale)).toBe("NP");
    expect(letterFor(null, scale)).toBeNull();
  });

  it("must run from the highest cutoff down to 0, each letter once", () => {
    expect(GradeScale.safeParse([{ letter: "A", minPercent: 90 }, { letter: "B", minPercent: 95 }, { letter: "F", minPercent: 0 }]).success).toBe(false);
    expect(GradeScale.safeParse([{ letter: "A", minPercent: 90 }, { letter: "B", minPercent: 50 }]).success).toBe(false);
    expect(GradeScale.safeParse([{ letter: "A", minPercent: 50 }, { letter: "A", minPercent: 0 }]).success).toBe(false);
  });

  it("keeps an assignment in at most one group", () => {
    const groups = [
      { id: grp("a"), name: "A", weight: 50, dropLowest: 0, assignmentIds: [id("hw1")] },
      { id: grp("b"), name: "B", weight: 50, dropLowest: 0, assignmentIds: [id("hw1")] },
    ];
    expect(GradebookSettings.safeParse({ ...DEFAULT_GRADEBOOK_SETTINGS, groups }).success).toBe(false);
  });
});

describe("gradebook CSV", () => {
  it("has a fixed column order, RFC 4180 quoting and formula-safe cells", () => {
    const formula = assignment("hw1", HW1.dueAt, '=HYPERLINK("http://evil.example","Click")');
    const quoted = assignment("hw2", HW2.dueAt, 'Lab, "part 2"');
    const groups = [{ id: grp("homework"), name: "+Homework", weight: 100, dropLowest: 0, assignmentIds: [id("hw1"), id("hw2")] }];
    const result = computeGradebook({
      offeringId: OFFERING,
      assignments: [quoted, formula],
      versions: [grade("hw1", AMARA, 8, 10), grade("hw2", AMARA, 4.5, 5)],
      settings: settings({ weighting: "group-weights", groups }),
      markers: [marker("hw1", ELENA, "excused"), marker("hw2", ELENA, "missing")],
      students: [{ principalId: AMARA, displayName: "@Amara\nOkafor" }, { principalId: ELENA, displayName: "-Elena Sato" }],
    });
    expect(gradebookCsv(result, settings({ weighting: "group-weights", groups }))).toBe(
      [
        `Student,Student ID,"'=HYPERLINK(""http://evil.example"",""Click"") (10 pts)","Lab, ""part 2"" (5 pts)",'+Homework %,Points earned,Points possible,Unweighted %,Weighted %,Final %,Letter`,
        `"'@Amara\nOkafor",prn_nf-student-amara,8,4.5,83.33,12.5,15,83.33,83.33,83.33,B`,
        `'-Elena Sato,prn_nf-student-elena,EX,MISSING,0.00,0,5,0.00,0.00,0.00,F`,
        "",
      ].join("\r\n"),
    );
  });

  it("guards every field that a spreadsheet would run", () => {
    expect(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "plain", "a,b", 'say "hi"'].map(csvField)).toStrictEqual([
      "'=1+1", "'+1", "'-1", "'@SUM(A1)", "'\tx", "\"'\rx\"", "plain", '"a,b"', '"say ""hi"""',
    ]);
  });
});
