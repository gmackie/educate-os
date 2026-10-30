// The guided journeys: what to try as each persona. A step is done when the persona's UI makes the
// district request that doing it takes, so the checklist follows the real apps rather than
// duplicating their screens.
import type { PersonaId } from "./districts/index.ts";

/** One thing to try. */
export interface JourneyStep {
  id: string;
  /** What to do, as an instruction. */
  label: string;
  /** The request that shows it was done, by method and path pattern (`:x` is one segment). */
  done: { method: "GET" | "POST"; paths: readonly string[] };
  /** The app screen, by hash route, the request must come from, when other screens make it too. */
  on?: RegExp;
}

/** What to try as each persona. */
export const JOURNEYS: Readonly<Record<PersonaId, readonly JourneyStep[]>> = {
  student: [
    // Only the course page reads its announcements; Home lists every course's activities too.
    { id: "student.open-course", label: "Open a course", done: { method: "GET", paths: ["/api/student/offerings/:x/announcements"] } },
    { id: "student.submit", label: "Work on an assignment and submit it", done: { method: "POST", paths: ["/api/student/assignments/:x/submissions"] } },
    // Feedback the teacher has not released answers not-found, so a success on an activity's own
    // page means it was shown; the course page asks too, to badge the activities that have some.
    {
      id: "student.feedback",
      label: "Read your teacher's released feedback",
      done: { method: "GET", paths: ["/api/student/submissions/:x/feedback"] },
      on: /^#\/courses\/[^/]+\/activities\/[^/]+$/,
    },
  ],
  teacher: [
    { id: "teacher.gradebook", label: "Open a class's gradebook", done: { method: "GET", paths: ["/api/teacher/offerings/:x/gradebook"] } },
    {
      id: "teacher.grade",
      label: "Grade a submission or release its feedback",
      done: {
        method: "POST",
        paths: ["/api/teacher/submissions/:x/grade", "/api/teacher/submissions/:x/feedback/release", "/api/teacher/grade-proposals/:x/approve"],
      },
    },
    { id: "teacher.announce", label: "Post an announcement", done: { method: "POST", paths: ["/api/teacher/offerings/:x/announcements"] } },
  ],
  guardian: [
    { id: "guardian.child", label: "Open your child's page", done: { method: "GET", paths: ["/api/guardian/children/:x/offerings"] } },
    { id: "guardian.course", label: "Look at one of their classes", done: { method: "GET", paths: ["/api/guardian/children/:x/offerings/:x"] } },
  ],
  admin: [
    { id: "admin.classes", label: "Look over all classes", done: { method: "GET", paths: ["/api/admin/offerings"] } },
    { id: "admin.roster", label: "Open a class roster", done: { method: "GET", paths: ["/api/admin/offerings/:x/roster"] } },
  ],
};

const matches = (pattern: string, path: string): boolean => {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((segment, i) => segment === ":x" ? got[i] !== "" : segment === got[i]);
};

/**
 * The steps of `persona`'s journey that `request`, answered with `status`, completes, made from the
 * app screen whose hash route is `screen`.
 */
export function stepsDoneBy(persona: PersonaId, request: Pick<Request, "method" | "url">, status: number, screen: string): string[] {
  if (status < 200 || status > 299) return [];
  const path = new URL(request.url).pathname;
  return JOURNEYS[persona]
    .filter(({ done, on }) => done.method === request.method && done.paths.some((pattern) => matches(pattern, path)) && (on === undefined || on.test(screen)))
    .map((step) => step.id);
}
