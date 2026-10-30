// What the demo shows about grade passback (SCHO-278): where each class's approved grades go, and
// what each one did when it got there. Types only, so the main chunk can name them while the
// gradebooks themselves arrive with the district that has them.

/** The two ways a Cedar Valley class's grades can reach its gradebook. */
export type GradeRouteKind = "google-classroom" | "clever-lms-connect";

/** One class, and where its approved grades go. */
export interface GradeClass {
  offeringId: string;
  /** Its course title, such as "Earth Science 8". */
  title: string;
  /** Its section name, such as "Period 2". */
  section: string;
  /** Its teachers, by name. */
  teachers: readonly string[];
  route: GradeRouteKind;
}

/** A grade as it landed in Google Classroom, read back from the Classroom fake. */
export interface ClassroomLanding {
  via: "google-classroom";
  courseId: string;
  courseName: string;
  courseWorkId: string;
  courseWorkTitle: string;
  /** The student's `assignedGrade` on the coursework. */
  assignedGrade: number | undefined;
  maxPoints: number | undefined;
}

/** A grade as it landed in Clever LMS Connect, read back from the Clever fake. */
export interface CleverLanding {
  via: "clever-lms-connect";
  sectionId: string;
  sectionName: string;
  assignmentId: string;
  assignmentTitle: string;
  /** The student's `grade_points` on the assignment. */
  gradePoints: number | undefined;
  pointsPossible: number | null;
}

/** What the passback gate was asked to send. */
interface GradeAttempt {
  /** Unique within the page, in the order the attempts were made. */
  id: string;
  /** When the attempt was made (ISO 8601). */
  at: string;
  offeringId: string;
  /** The class, such as "Earth Science 8". */
  className: string;
  studentName: string;
  assignmentTitle: string;
  scoreGiven: number;
  scoreMaximum: number;
  gradeVersion: number;
  /** The route the class had when the attempt was made. */
  via: GradeRouteKind;
}

/**
 * A grade the gate accepted. `posted` sent it; `already-posted` found this version already sent,
 * so nothing went out again.
 */
export interface DeliveredGrade extends GradeAttempt {
  outcome: "posted" | "already-posted";
  landed: ClassroomLanding | CleverLanding;
}

/** A grade the gate, or the gradebook behind it, refused. Nothing was written. */
export interface RefusedGrade extends GradeAttempt {
  outcome: "refused";
  /** The refusal's error code, such as `policy-violation`. */
  code: string;
  /** The refusal, as the gate or the gradebook gave it. */
  reason: string;
}

/** One passback attempt and its outcome. */
export type GradeEvent = DeliveredGrade | RefusedGrade;

/**
 * A district's grade passback, as the demo drives and shows it. Every approved grade a teacher
 * makes is handed to the passback gate once the request that made it returns; a guided tour can
 * follow along with {@link subscribe}.
 */
export interface DemoGradebooks {
  /** Every class with a grade route, once the roster has brought them in. */
  classes(): Promise<GradeClass[]>;
  /** Sends a class's grades from now on by `route`. Grades already sent stay where they landed. */
  setRoute(offeringId: string, route: GradeRouteKind): void;
  /** Every attempt so far, oldest first. The same array until the next attempt. */
  events(): readonly GradeEvent[];
  /** Calls `listener` after each attempt (and each route change, with no event). Returns an unsubscribe. */
  subscribe(listener: (event?: GradeEvent) => void): () => void;
  /** Asks the gate to send a delivered grade again, as a retry would. */
  resend(eventId: string): Promise<GradeEvent>;
  /**
   * Asks the gate to send full marks to a student in the class that no teacher approved, as an
   * unreviewed AI-suggested score would be. The gate refuses it.
   */
  tryUnapproved(offeringId: string): Promise<GradeEvent>;
}
