// The read-only "From Google Classroom" panel (SCHO-403): a class's grades as Google Classroom holds
// them, read live through the district's Classroom connection. Nothing is stored in EducateOS and
// nothing is written to Classroom, which stays the record.
//
// The district maps its records to Classroom's through the roster's source map: a Classroom-rostered
// offering's `sourcedId` is its Classroom course ID, and a person's is their Classroom user ID. A
// district whose roster is not Classroom, a deployment with no Classroom connection, and an offering
// or person the roster did not import all answer `not-connected`, and the panel shows nothing.
//
// This module is browser-safe (routes.ts carries its schemas): it imports only schemas and types.
import { OfferingId, PrincipalId, type DistrictDirectorySnapshot } from "@educateos/contracts";
import type { googleclassroom, oneroster } from "@educateos/integrations";
import { z } from "zod";

/**
 * Where the district reads Classroom grades: a `googleclassroom.ClassroomGradeReader` in the
 * district Worker, over the deployment's service account. Any rejection is reported as
 * `unavailable`.
 */
export interface ClassroomGradeSource {
  /** One student's returned submissions in a course, by their Classroom user ID. */
  student(courseId: string, userId: string): Promise<googleclassroom.ClassroomGradeRead>;
  /** Every student's submissions in a course. */
  course(courseId: string): Promise<googleclassroom.ClassroomGradeRead>;
}

const ClassroomId = z.string().regex(/^\d{1,32}$/);
/** A link into Classroom. Only Classroom's own https pages are passed to a browser. */
const ClassroomLink = z.url({ protocol: /^https$/, hostname: /^classroom\.google\.com$/ }).max(2048);
const Points = z.number().finite().nonnegative();

/** Where a student's submission stands in Classroom. */
export const ClassroomSubmissionState = z.enum(["assigned", "turned-in", "returned", "reclaimed"]);
/** A submission's state. */
export type ClassroomSubmissionState = z.infer<typeof ClassroomSubmissionState>;

/** A piece of Classroom coursework, as the panel shows it. */
export const ClassroomCourseWorkColumn = z.strictObject({
  courseWorkId: ClassroomId,
  title: z.string().min(1).max(3000),
  /** The points it is out of. Absent for ungraded coursework. */
  maxPoints: Points.optional(),
  /** Its page in Classroom. */
  link: ClassroomLink.optional(),
});
/** A coursework column. */
export type ClassroomCourseWorkColumn = z.infer<typeof ClassroomCourseWorkColumn>;

/** One returned piece of a student's work: the coursework and the grade Classroom returned with it, if any. */
export const StudentClassroomGrade = ClassroomCourseWorkColumn.extend({ assignedGrade: z.number().finite().optional() });
/** A student's returned grade. */
export type StudentClassroomGrade = z.infer<typeof StudentClassroomGrade>;

/** One student's submission to one piece of coursework, as the class's teachers see it. */
export const ClassroomGradeCell = z.strictObject({
  courseWorkId: ClassroomId,
  state: ClassroomSubmissionState,
  /** The grade the teacher assigned in Classroom, returned or not. */
  assignedGrade: z.number().finite().optional(),
});
/** A teacher's cell. */
export type ClassroomGradeCell = z.infer<typeof ClassroomGradeCell>;

/** One of the class's students, with their Classroom submissions. */
export const ClassroomGradeStudentRow = z.strictObject({
  studentPrincipalId: PrincipalId,
  displayName: z.string().max(200),
  cells: z.array(ClassroomGradeCell),
});

/** The district has no Classroom connection for this class or person: show nothing. */
const NotConnected = z.strictObject({ status: z.literal("not-connected") });
/** Classroom could not be read just now. */
const Unavailable = z.strictObject({ status: z.literal("unavailable") });

/** `student.classroomGrades`: the student's own returned Classroom grades in a class. */
export const StudentClassroomGrades = z.discriminatedUnion("status", [
  NotConnected,
  Unavailable,
  z.strictObject({
    status: z.literal("ready"),
    offeringId: OfferingId,
    courseLink: ClassroomLink.optional(),
    grades: z.array(StudentClassroomGrade),
    /** Whether only the most recent coursework was read. */
    truncated: z.boolean(),
  }),
]);
/** A student's Classroom grades. */
export type StudentClassroomGrades = z.infer<typeof StudentClassroomGrades>;

/** `teacher.classroomGrades`: every actively enrolled student's Classroom submissions in a class. */
export const TeacherClassroomGrades = z.discriminatedUnion("status", [
  NotConnected,
  Unavailable,
  z.strictObject({
    status: z.literal("ready"),
    offeringId: OfferingId,
    courseLink: ClassroomLink.optional(),
    courseWork: z.array(ClassroomCourseWorkColumn),
    rows: z.array(ClassroomGradeStudentRow),
    /** Whether only the most recent coursework or submissions were read. */
    truncated: z.boolean(),
  }),
]);
/** A class's Classroom grades. */
export type TeacherClassroomGrades = z.infer<typeof TeacherClassroomGrades>;

/** What a Classroom grade read is given, once the caller has been authorized. */
export interface ClassroomGradesInput {
  /** The deployment's Classroom grade source, if it has a Classroom connection. */
  source: ClassroomGradeSource | undefined;
  /** Whether the head configuration revision's roster is Google Classroom. */
  classroomRostered: boolean;
  /** The roster's source map. */
  sources: Pick<oneroster.OneRosterSourceMap, "offerings" | "principals">;
  /** Told why a read was unavailable, for the Worker to log. */
  onUnavailable?: ((failure: { surface: "student" | "teacher"; error: unknown }) => void) | undefined;
}

/** The Classroom course behind an offering, when the roster is Classroom and imported it. */
function courseOf(input: ClassroomGradesInput, offeringId: OfferingId): string | undefined {
  if (input.source === undefined || !input.classroomRostered) return undefined;
  return classroomId(input.sources.offerings[offeringId]);
}

function classroomId(sourcedId: string | undefined): string | undefined {
  return sourcedId !== undefined && ClassroomId.safeParse(sourcedId).success ? sourcedId : undefined;
}

function column(work: googleclassroom.ClassroomCourseWorkRecord): ClassroomCourseWorkColumn {
  const link = ClassroomLink.safeParse(work.alternateLink);
  return {
    courseWorkId: work.id,
    title: work.title,
    // Google reports ungraded coursework as having no points (or zero).
    ...(work.maxPoints === undefined || work.maxPoints === 0 ? {} : { maxPoints: work.maxPoints }),
    ...(link.success ? { link: link.data } : {}),
  };
}

function courseLink(read: googleclassroom.ClassroomGradeRead): { courseLink?: string } {
  const link = ClassroomLink.safeParse(read.courseLink);
  return link.success ? { courseLink: link.data } : {};
}

const STATES: Record<string, ClassroomSubmissionState> = {
  TURNED_IN: "turned-in",
  RETURNED: "returned",
  RECLAIMED_BY_STUDENT: "reclaimed",
};

/**
 * A student's own returned Classroom grades in an offering they are authorized to read their row
 * of. Classroom is asked only for this student's returned work.
 */
export async function studentClassroomGrades(input: ClassroomGradesInput, offeringId: OfferingId, studentPrincipalId: PrincipalId): Promise<StudentClassroomGrades> {
  const courseId = courseOf(input, offeringId);
  const userId = classroomId(input.sources.principals[studentPrincipalId]?.sourcedId);
  if (courseId === undefined || userId === undefined) return { status: "not-connected" };
  let read: googleclassroom.ClassroomGradeRead;
  try {
    read = await input.source!.student(courseId, userId);
  } catch (error) {
    input.onUnavailable?.({ surface: "student", error });
    return { status: "unavailable" };
  }
  const work = new Map(read.courseWork.map((w) => [w.id, w]));
  const grades: StudentClassroomGrade[] = [];
  for (const submission of read.submissions) {
    const piece = submission.courseWorkId === undefined ? undefined : work.get(submission.courseWorkId);
    // Only work returned to this student: a grade not yet returned is the teacher's alone.
    if (piece === undefined || submission.userId !== userId || submission.state !== "RETURNED") continue;
    grades.push({ ...column(piece), ...(submission.assignedGrade === undefined ? {} : { assignedGrade: submission.assignedGrade }) });
  }
  const order = new Map(read.courseWork.map((w, i) => [w.id, i]));
  grades.sort((a, b) => order.get(a.courseWorkId)! - order.get(b.courseWorkId)!);
  return { status: "ready", offeringId, ...courseLink(read), grades, truncated: read.truncated };
}

/**
 * A class's Classroom grades for a caller authorized to read its grid: a row for each actively
 * enrolled student the roster imported, by name. Submissions from anyone else are left out.
 */
export async function teacherClassroomGrades(input: ClassroomGradesInput, offeringId: OfferingId, directory: DistrictDirectorySnapshot): Promise<TeacherClassroomGrades> {
  const courseId = courseOf(input, offeringId);
  if (courseId === undefined) return { status: "not-connected" };
  let read: googleclassroom.ClassroomGradeRead;
  try {
    read = await input.source!.course(courseId);
  } catch (error) {
    input.onUnavailable?.({ surface: "teacher", error });
    return { status: "unavailable" };
  }
  const names = new Map(directory.principals.map((p) => [p.id as string, p.displayName]));
  const students = new Map<string, z.infer<typeof ClassroomGradeStudentRow>>();
  for (const e of directory.enrollments) {
    if (e.offeringId !== offeringId || e.role !== "student" || e.status !== "active") continue;
    const userId = classroomId(input.sources.principals[e.principalId]?.sourcedId);
    if (userId !== undefined && !students.has(userId)) {
      students.set(userId, { studentPrincipalId: e.principalId, displayName: names.get(e.principalId) ?? "", cells: [] });
    }
  }
  const work = new Set(read.courseWork.map((w) => w.id));
  for (const submission of read.submissions) {
    const row = students.get(submission.userId);
    if (row === undefined || submission.courseWorkId === undefined || !work.has(submission.courseWorkId)) continue;
    row.cells.push({
      courseWorkId: submission.courseWorkId,
      state: STATES[submission.state] ?? "assigned",
      ...(submission.assignedGrade === undefined ? {} : { assignedGrade: submission.assignedGrade }),
    });
  }
  const rows = [...students.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName, "en") || (a.studentPrincipalId < b.studentPrincipalId ? -1 : 1));
  return { status: "ready", offeringId, ...courseLink(read), courseWork: read.courseWork.map(column), rows, truncated: read.truncated };
}
