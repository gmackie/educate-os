/** Published coursework visible to the signed-in student. */
export type ClassroomStudentCourseWork = {
  /** Classroom's coursework ID. */
  id: string;
  /** Assignment title. */
  title: string;
  /** Assignment instructions. */
  description?: string;
  /** Published student work only. */
  state: "PUBLISHED";
  /** Points the work is graded out of. */
  maxPoints?: number;
  /** Resources the instructor attached to this published work; Google still enforces each file's ACL. */
  materials?: { kind: "driveFile" | "link" | "youtubeVideo" | "form"; title: string; url?: string; mimeType?: string }[];
  /** Link to the coursework in Classroom. */
  alternateLink?: string;
  /** When Classroom last changed it. */
  updateTime?: Date;
};

/** The signed-in student's submission for one coursework item. */
export type ClassroomStudentSubmission = {
  /** Classroom's coursework ID. */
  courseWorkId: string;
  /** The signed-in student's submission state. */
  state: "NEW" | "CREATED" | "TURNED_IN" | "RETURNED" | "RECLAIMED_BY_STUDENT" | "SUBMISSION_STATE_UNSPECIFIED";
  /** Whether it was turned in after the due date. */
  late?: boolean;
  /** Link to the student's submission in Classroom. */
  alternateLink?: string;
  /** Text the student submitted. */
  answer?: string;
  /** Files the student attached. */
  attachments?: { title: string; url?: string; mimeType?: string }[];
};

/** Student-only Google Classroom access for one course. */
export interface GoogleClassroomStudentSession {
  /** List published work visible to the signed-in student. Drafts are never returned. */
  listCourseWork(): Promise<ClassroomStudentCourseWork[]>;

  /** Read only the signed-in student's submission for one coursework item. */
  getMySubmission(courseWorkId: string): Promise<ClassroomStudentSubmission | null>;

  /** Turn in the signed-in student's existing submission after approval. */
  turnIn(courseWorkId: string): Promise<void>;
}
