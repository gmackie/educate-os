// The guided journeys: what to try as each persona. A step is done when the persona's UI makes the
// district request that doing it takes, so the checklist follows the real apps rather than
// duplicating their screens. A step about the demo's own simulated tutor is done when it is used.
import type { Persona, PersonaId } from "./districts/index.ts";

/** A district request that shows a step was done, by method and path pattern (`:x` is one segment). */
export interface RequestMatch {
  method: "GET" | "POST";
  paths: readonly string[];
}

/** Something the demo itself shows, rather than the district: a visitor using the simulated tutor. */
export type DemoEvent = "tutor-asked";

/** One thing to try. */
export interface JourneyStep {
  id: string;
  /** What to do, as an instruction. */
  label: string;
  /** The request that shows it was done, or the demo's own event. */
  done: RequestMatch | { event: DemoEvent };
  /** The app screen, by hash route, the request must come from, when other screens make it too. */
  on?: RegExp;
  /** Whether the answer must list something: for a request that answers an empty list when there is nothing to show. */
  listsSomething?: boolean;
}

/** An activity's own page in the Learning Home. */
const ACTIVITY_PAGE = /^#\/courses\/[^/]+\/activities\/[^/]+$/;

// Only the course page reads its announcements; Home lists every course's activities too.
const openCourse = (id: string, label = "Open a class"): JourneyStep =>
  ({ id, label, done: { method: "GET", paths: ["/api/student/offerings/:x/announcements"] } });
// An activity's page lists the feedback released on it, an empty list while there is none, so only
// a listing with some on the activity's own page means it was shown; the course page asks too, to
// badge the activities that have some.
const readFeedback = (id: string, label: string): JourneyStep =>
  ({ id, label, done: { method: "GET", paths: ["/api/student/assignments/:x/feedback"] }, on: ACTIVITY_PAGE, listsSomething: true });
const openActivity = (id: string, label: string): JourneyStep =>
  ({ id, label, done: { method: "GET", paths: ["/api/student/assignments/:x/feedback"] }, on: ACTIVITY_PAGE });
const saveWork = (id: string, label: string): JourneyStep =>
  ({ id, label, done: { method: "POST", paths: ["/api/student/artifacts", "/api/student/artifacts/:x/revisions"] } });
const submit = (id: string, label: string): JourneyStep =>
  ({ id, label, done: { method: "POST", paths: ["/api/student/assignments/:x/submissions"] } });
const askTutor = (id: string, label: string): JourneyStep => ({ id, label, done: { event: "tutor-asked" } });

const gradebook = (id: string, label = "Open a class's gradebook"): JourneyStep =>
  ({ id, label, done: { method: "GET", paths: ["/api/teacher/offerings/:x/gradebook"] } });
const grade = (id: string, label: string): JourneyStep => ({
  id,
  label,
  done: {
    method: "POST",
    paths: ["/api/teacher/submissions/:x/grade", "/api/teacher/submissions/:x/feedback/release", "/api/teacher/grade-proposals/:x/approve"],
  },
});
const release = (id: string, label: string): JourneyStep =>
  ({ id, label, done: { method: "POST", paths: ["/api/teacher/submissions/:x/feedback/release"] } });
const announce = (id: string, label = "Post an announcement"): JourneyStep =>
  ({ id, label, done: { method: "POST", paths: ["/api/teacher/offerings/:x/announcements"] } });

/** What to try as each persona, by persona ID. Cedar Valley's three keep the original journeys. */
export const JOURNEYS: Readonly<Record<PersonaId, readonly JourneyStep[]>> = {
  // Cedar Valley.
  student: [
    openCourse("student.open-course", "Open a course"),
    submit("student.submit", "Work on an assignment and submit it"),
    readFeedback("student.feedback", "Read your teacher's released feedback"),
  ],
  teacher: [
    gradebook("teacher.gradebook"),
    grade("teacher.grade", "Grade a submission or release its feedback"),
    announce("teacher.announce"),
  ],
  // Northfield, a grade band at a time.
  "k2-student": [
    openActivity("k2-student.open", "Open “Retell The Little Seed” and listen to the story"),
    saveWork("k2-student.record", "Record what happened, then draw the ending"),
    submit("k2-student.hand-in", "Hand it in"),
    readFeedback("k2-student.feedback", "Find Mr. Yazzie's feedback on Word Builders"),
    askTutor("k2-student.tutor", "Ask Reading Buddy for help (simulated)"),
  ],
  "k2-teacher": [
    {
      id: "k2-teacher.listen",
      label: "Open Retell The Little Seed in Submissions and play Priya's recording",
      done: { method: "GET", paths: ["/api/teacher/submissions/:x/artifacts/:x"] },
    },
    release("k2-teacher.release", "Release Jonah's feedback on Apple Orchard Story Problems (Grade 1 Mathematics), so he and his family see it"),
    gradebook("k2-teacher.gradebook", "Open the Grade 1 Reading gradebook"),
    {
      id: "k2-teacher.add-course",
      label: "In Grade 1 Reading's Modules, open Add a course and preview Grade 1 Reading Foundations, the course package units 3 to 6 came from",
      done: { method: "POST", paths: ["/api/teacher/offerings/:x/course-install/preview"] },
    },
  ],
  "g35-student": [
    openActivity("g35-student.open", "Open “Should Recess Be Longer?”"),
    askTutor("g35-student.tutor", "Ask the Homework Helper for a hint (simulated)"),
    saveWork("g35-student.save", "Keep writing your opinion piece and save it"),
    readFeedback("g35-student.feedback", "Read Ms. Al-Sayed's feedback on the kite story"),
  ],
  "g35-teacher": [
    grade("g35-teacher.grade", "Score Hana's theme essay on the rubric and record a grade"),
    gradebook("g35-teacher.gradebook", "Open the Grade 4 ELA gradebook"),
    announce("g35-teacher.announce", "Post an announcement to the class"),
  ],
  "g68-student": [
    readFeedback("g68-student.feedback", "Read Mr. Ortega's feedback on Hammurabi's laws"),
    { id: "g68-student.discuss", label: "Reply in the class discussion", done: { method: "POST", paths: ["/api/student/offerings/:x/discussions/:x/posts"] } },
    askTutor("g68-student.tutor", "Ask the Study Coach about your draft (simulated)"),
  ],
  "g68-teacher": [
    grade("g68-teacher.grade", "Grade Felix's primary-source analysis"),
    { id: "g68-teacher.discuss", label: "Reply in your class's discussion", done: { method: "POST", paths: ["/api/teacher/offerings/:x/discussions/:x/posts"] } },
    gradebook("g68-teacher.gradebook", "Open the World History 7 gradebook"),
  ],
  "g912-student": [
    readFeedback("g912-student.feedback", "Read Mr. Rivera's feedback and official grade on your argument essay"),
    askTutor("g912-student.tutor", "Plan “What Changes a Character?” with the Research & Essay Coach (simulated)"),
    saveWork("g912-student.save", "Work on your draft and save it"),
  ],
  "g912-teacher": [
    grade("g912-teacher.grade", "Grade Elena's argument essay and release the feedback"),
    gradebook("g912-teacher.gradebook", "Open the English 9 gradebook"),
    announce("g912-teacher.announce"),
  ],
  guardian: [
    { id: "guardian.child", label: "Open one of your children's pages", done: { method: "GET", paths: ["/api/guardian/children/:x/offerings"] } },
    // The child's page reads each class too, for its grade summary.
    {
      id: "guardian.course",
      label: "Look at one of their classes",
      done: { method: "GET", paths: ["/api/guardian/children/:x/offerings/:x"] },
      on: /^#\/family\/children\/[^/]+\/courses\/[^/]+$/,
    },
  ],
  admin: [
    { id: "admin.classes", label: "Look over all the district's classes", done: { method: "GET", paths: ["/api/admin/offerings"] } },
    { id: "admin.roster", label: "Open a class's roster from All classes", done: { method: "GET", paths: ["/api/admin/offerings/:x/roster"] } },
  ],
};

/** What to try as `persona`. */
export const journeyOf = (persona: Pick<Persona, "id">): readonly JourneyStep[] => JOURNEYS[persona.id] ?? [];

const matches = (pattern: string, path: string): boolean => {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((segment, i) => segment === ":x" ? got[i] !== "" : segment === got[i]);
};

/**
 * Whether `request`, answered with `status`, is one that `done` names: a success of its method on
 * one of its paths. The Clever tour (`src/tour/`) follows its steps' requests the same way.
 */
export function requestDoes(done: RequestMatch, request: Pick<Request, "method" | "url">, status: number): boolean {
  if (status < 200 || status > 299 || done.method !== request.method) return false;
  const path = new URL(request.url).pathname;
  return done.paths.some((pattern) => matches(pattern, path));
}

/**
 * The steps of `persona`'s journey that `request`, answered with `response`, completes, made from the
 * app screen whose hash route is `screen`. Call it before the app reads the response: a step that
 * must list something reads a copy of its body.
 */
export async function stepsDoneBy(
  persona: PersonaId,
  request: Pick<Request, "method" | "url">,
  response: Pick<Response, "status" | "clone">,
  screen: string,
): Promise<string[]> {
  const steps = (JOURNEYS[persona] ?? []).filter(({ done, on }) =>
    "method" in done && requestDoes(done, request, response.status) && (on === undefined || on.test(screen)));
  if (!steps.some((step) => step.listsSomething === true)) return steps.map((step) => step.id);
  const body: unknown = await response.clone().json().catch(() => undefined);
  const listed = Array.isArray(body) && body.length > 0;
  return steps.filter((step) => step.listsSomething !== true || listed).map((step) => step.id);
}

/** The steps of `persona`'s journey that the demo's own `event` completes. */
export const stepsDoneByEvent = (persona: PersonaId, event: DemoEvent): string[] =>
  (JOURNEYS[persona] ?? []).filter(({ done }) => "event" in done && done.event === event).map((step) => step.id);
