/** A Google Classroom course. */
export type ClassroomCourse = {
  /** Classroom's course ID. */
  id: string;
  /** Course name, e.g. `Biology`. */
  name: string;
  /** Section, e.g. `Period 2`. */
  section?: string;
  /** Description shown to the class. */
  description?: string;
  /** Room the class meets in. */
  room?: string;
  /** Whether the course is active, archived, or still being set up. */
  courseState: "ACTIVE" | "ARCHIVED" | "PROVISIONED" | "DECLINED" | "SUSPENDED" | "COURSE_STATE_UNSPECIFIED";
  /** Link to the course in Classroom. */
  alternateLink?: string;
};

/** One teacher or student on a course's roster. */
export type ClassroomRosterMember = {
  /** Classroom's user ID, which submissions name the student by and `listSubmissions` filters on. */
  userId: string;
  /** Full name, when Classroom shares it. Email addresses are not read. */
  name?: string;
};

/** A course's roster. */
export type ClassroomRoster = {
  teachers: ClassroomRosterMember[];
  students: ClassroomRosterMember[];
};

/** A coursework item (an assignment) created through this Google connection. */
export type ClassroomCourseWork = {
  /**
   * Classroom's coursework ID. Coursework whose creation is still awaiting approval has a
   * temporary ID of the form `pending:create:{n}`.
   */
  id: string;
  title: string;
  description?: string;
  state: "PUBLISHED" | "DRAFT" | "DELETED" | "COURSE_WORK_STATE_UNSPECIFIED";
  /** Points the work is graded out of. Absent for ungraded work. */
  maxPoints?: number;
  /** Link to the coursework in Classroom. */
  alternateLink?: string;
  /** When Classroom last changed it. */
  updateTime?: Date;
  /** True if this is a submitted creation that has not yet been approved and committed. */
  pending?: true;
};

/** The coursework `createCourseWork` creates: always an assignment. */
export type ClassroomCourseWorkDraft = {
  title: string;
  description?: string;
  /** Points the work is graded out of. Omit for ungraded work. */
  maxPoints?: number;
  /**
   * `DRAFT` (the default) is visible only to the course's teachers; `PUBLISHED` posts it to the
   * class.
   */
  state?: "PUBLISHED" | "DRAFT";
};

/** A student's submission for one coursework item. */
export type ClassroomSubmission = {
  /** Classroom's submission ID, which `setGrade` takes. */
  id: string;
  courseWorkId: string;
  /** The student's Classroom user ID. */
  userId: string;
  state: "NEW" | "CREATED" | "TURNED_IN" | "RETURNED" | "RECLAIMED_BY_STUDENT" | "SUBMISSION_STATE_UNSPECIFIED";
  /** Whether it was turned in after the due date. */
  late?: boolean;
  /** The grade the student sees. */
  assignedGrade?: number;
  /** The teacher's draft grade, which students do not see. */
  draftGrade?: number;
  /** Link to the submission in Classroom. */
  alternateLink?: string;
  /** True if a submitted grade for it has not yet been approved and committed. */
  pending?: true;
};

/** A Classroom rubric level. API rubric scores are read-only; publish the approved total separately. */
export type ClassroomRubricLevel = { id?: string; title: string; description?: string; points?: number };

/** One rubric criterion and its ordered levels. */
export type ClassroomRubricCriterion = { id?: string; title: string; description?: string; levels: ClassroomRubricLevel[] };

/** A rubric attached to app-owned coursework. Requires an eligible teacher license. */
export type ClassroomRubric = { id: string; criteria: ClassroomRubricCriterion[] };

/** The rubric to create. IDs are assigned by Google. */
export type ClassroomRubricDraft = { criteria: { title: string; description?: string; levels: { title: string; description?: string; points?: number }[] }[] };

/** Calendar date in the course's grading-period configuration. */
export type ClassroomDate = { year: number; month: number; day: number };

/** A course grading period. */
export type ClassroomGradingPeriod = { id: string; title: string; startDate: ClassroomDate; endDate: ClassroomDate };

/** The bound course's grading periods. Empty when none are configured. */
export type ClassroomGradingPeriodSettings = { gradingPeriods: ClassroomGradingPeriod[]; applyToExistingCoursework?: boolean };

/**
 * Session interface for one Google Classroom course.
 *
 * Classroom lets an app change only the coursework it created itself, so this session shows only
 * that coursework: what `createCourseWork` made through this Google connection. Assignments made in
 * the Classroom UI or by other apps are never listed, read, or graded.
 */
export interface GoogleClassroomCourseSession {
  /** Read the bound course's grading periods. No cross-course lookup is accepted. */
  getGradingPeriodSettings(): Promise<ClassroomGradingPeriodSettings>;

  /** List rubrics of app-owned coursework. Google enforces the teacher's license eligibility. */
  listRubrics(courseWorkId: string): Promise<ClassroomRubric[]>;

  /**
   * Create a rubric for app-owned coursework after approval. Requires an eligible teacher license;
   * Google refuses unavailable capabilities. Waits for the decision; no provisional rubric is shown.
   * The API cannot publish rubric-level grades. Use setGrade for the teacher-approved total.
   */
  createRubric(courseWorkId: string, draft: ClassroomRubricDraft): Promise<void>;

  /** Return the course's details. */
  getCourse(): Promise<ClassroomCourse>;

  /** Return the course's teachers and students. The whole roster is returned. */
  getRoster(): Promise<ClassroomRoster>;

  /**
   * List the published and draft coursework created through this connection, including creations
   * submitted but not yet approved, shown as if they had already been applied.
   */
  listCourseWork(): Promise<ClassroomCourseWork[]>;

  /** Return one coursework item created through this connection. */
  getCourseWork(courseWorkId: string): Promise<ClassroomCourseWork>;

  /**
   * Submit an assignment for creation. It is created once the user approves it; until then it is
   * listed with a `pending:create:{n}` ID.
   */
  createCourseWork(draft: ClassroomCourseWorkDraft): Promise<void>;

  /**
   * List the submissions for one coursework item created through this connection, optionally only
   * one student's. Grades submitted but not yet approved are shown as already assigned and
   * returned.
   */
  listSubmissions(courseWorkId: string, options?: { userId?: string }): Promise<ClassroomSubmission[]>;

  /**
   * Submit a grade for approval after the student has turned in the work. Already returned work
   * can be regraded. Once approved, it is set as the submission's `assignedGrade` and
   * the submission is returned to the student, who then sees the grade.
   *
   * `assignedGrade` must be non-negative with at most two decimal places: a grade Classroom would
   * round is refused instead. Coursework this connection did not create cannot be graded.
   */
  setGrade(courseWorkId: string, submissionId: string, assignedGrade: number): Promise<void>;
}
