// Snapshot of the owning gatekeeper contract; structural compatibility is checked in repo tests.
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

/** A resource attached to Google Classroom coursework. The original Google ACL still applies. */
export type ClassroomCourseWorkMaterial =
  | { kind: "driveFile" | "link" | "youtubeVideo" | "form"; title: string; url?: string; mimeType?: string };

/** Coursework fields exposed by the teacher and student Classroom capabilities. */
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
  /** Published resources attached to the coursework. Opening each Google file still checks its ACL. */
  materials?: ClassroomCourseWorkMaterial[];
  /** When Classroom last changed it. */
  updateTime?: Date;
  /** True if this is a submitted creation that has not yet been approved and committed. */
  pending?: true;
};

/** Read-only slice of the teacher course session; verified against its owning contract in tests. */
export interface GoogleClassroomCourseSession {
  getCourse(): Promise<ClassroomCourse>;
  listCourseWork(): Promise<ClassroomCourseWork[]>;
}
