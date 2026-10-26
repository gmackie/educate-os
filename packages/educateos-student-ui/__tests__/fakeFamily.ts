// A scripted district for the family view's tests (ADR-0012): a guardian with two children,
// answering the guardian routes the way the district does where the UI depends on it. A child the
// guardian has no relationship to, or a class the child does not take, is not-found; every other
// route is refused, as the district refuses a guardian everything else. Synthetic `.example` data.
import { DistrictApiError, type DistrictApiClient, type RouteInput, type RouteName, type RouteResponse } from "@educateos/api-client";

const DISTRICT = "dst_northfield";
const NOW = "2026-10-20T15:00:00.000Z";

/** The guardian's children. */
export const AMARA = "prn_nf-student-amara";
export const SAM = "prn_nf-student-sam";

/** Classes. */
export const ENGLISH = "off_nf-eng9-fall-p3";
export const ART_SPRING = "off_nf-art-spring-p2";
export const MATH = "off_nf-math7-fall-p1";

/** Assignments in English. */
export const ESSAY = "asg_essay-later-start";
export const POEM = "asg_poem-analysis";
export const QUIZ = "asg_poetry-quiz";

const notFound = () => new DistrictApiError(404, { code: "not-found", message: "We couldn't find that." });
const forbidden = () => new DistrictApiError(403, { code: "forbidden", message: "This part of EducateOS is not available to your account." });

const term = (id: string, name: string, state: string) => ({ id, districtId: DISTRICT, name, startsOn: "2026-01-12", endsOn: "2027-01-22", state });
const FALL = term("trm_nf-2026-fall", "Fall 2026", "active");
const SPRING = term("trm_nf-2026-spring", "Spring 2026", "completed");

const offering = (id: string, courseId: string, title: string, subject: string, termValue: typeof FALL, sectionName: string) => ({
  offering: { id, districtId: DISTRICT, schoolId: "sch_nf-high", termId: termValue.id, courseId, sectionName },
  course: { id: courseId, districtId: DISTRICT, title, subject, gradeBand: "9" },
  term: termValue,
});

const CLASSES = {
  [AMARA]: [
    offering(ENGLISH, "crs_nf-english-9", "English 9", "english-language-arts", FALL, "Period 3"),
    offering(ART_SPRING, "crs_nf-art", "Art", "arts", SPRING, "Period 2"),
  ],
  [SAM]: [offering(MATH, "crs_nf-math-7", "Math 7", "mathematics", FALL, "Period 1")],
} as const;

const feedback = (submissionId: string, comment: string) => ({
  submissionId,
  state: "shared-with-student",
  comments: [{ id: "fbc_1", body: comment, source: { kind: "teacher" }, enteredBy: "prn_nf-teacher-rivera", enteredAt: NOW }],
  scores: [{ criterionId: "use-of-evidence", points: 3, maxPoints: 4, source: { kind: "teacher" }, enteredBy: "prn_nf-teacher-rivera", enteredAt: NOW }],
  updatedAt: NOW,
});

const assignment = (id: string, offeringId: string, title: string, dueAt: string, kind: "activity" | "quiz" = "activity") => ({ id, offeringId, title, dueAt, kind });

const grade = (assignmentId: string, submissionId: string, points: number, maxPoints: number) => ({
  assignmentId,
  studentPrincipalId: AMARA,
  submissionId,
  version: 1,
  score: { points, maxPoints },
  recordedBy: "prn_nf-teacher-rivera",
  recordedVia: "ui",
  recordedAt: NOW,
});

const LIBRARY = {
  id: "ann_library", districtId: DISTRICT, offeringId: ENGLISH, title: "Library visit", body: "Bring your card.\nWe meet at the door.",
  publishAt: "2026-10-19T13:00:00.000Z", created: { by: "prn_nf-teacher-rivera", at: "2026-10-19T13:00:00.000Z" },
};

const COURSES: Record<string, { assignments: unknown[]; announcements: unknown[] }> = {
  [`${AMARA}:${ENGLISH}`]: {
    assignments: [
      {
        assignment: assignment(ESSAY, ENGLISH, "Should the school day start later?", "2026-11-03T21:00:00.000Z"),
        feedback: [feedback("sub_amara-essay", "Strong claim; add a counterclaim.")],
        grades: [grade(ESSAY, "sub_amara-essay", 8, 10)],
      },
      // A quiz is scored automatically: a grade, never written feedback.
      { assignment: assignment(QUIZ, ENGLISH, "Poetry terms", "2026-11-06T20:00:00.000Z", "quiz"), feedback: [], grades: [grade(QUIZ, "sub_amara-quiz", 3, 3)] },
      { assignment: assignment(POEM, ENGLISH, "Analyse a poem", "2026-11-10T21:00:00.000Z"), feedback: [], grades: [] },
    ],
    announcements: [LIBRARY],
  },
  [`${AMARA}:${ART_SPRING}`]: { assignments: [], announcements: [] },
  [`${SAM}:${MATH}`]: { assignments: [], announcements: [] },
};

type Handlers = { [N in RouteName]?: (input: RouteInput<N>) => unknown };

/** What the tests can do to the fake. */
export interface FakeFamily extends DistrictApiClient {
  /** Every call, in order. */
  calls: { name: RouteName; input: unknown }[];
  /** Makes the next call to `name` fail with `error`. */
  failNext(name: RouteName, error: DistrictApiError): void;
}

/** A guardian of Amara and Sam, or, with `children: []`, one the school has not confirmed yet. */
export function fakeFamily(options: { children?: readonly string[]; emailEnabled?: boolean } = {}): FakeFamily {
  let preferences = { email: { announcements: true, assignments: true, feedback: true, grades: true, digest: true }, hasEmailAddress: true, emailEnabled: options.emailEnabled ?? true };
  const mine = new Set(options.children ?? [AMARA, SAM]);
  const names: Record<string, string> = { [AMARA]: "Amara Okafor", [SAM]: "Sam Okafor" };
  const calls: FakeFamily["calls"] = [];
  const failures = new Map<RouteName, DistrictApiError>();
  const child = (studentId: string) => {
    if (!mine.has(studentId)) throw notFound();
    return studentId as keyof typeof CLASSES;
  };

  const handlers: Handlers = {
    "me.get": () => ({ principalId: "prn_g-gina", districtId: DISTRICT, kind: "guardian", displayName: "Gina Okafor", roles: [], enrollments: [] }),
    "guardian.listChildren": () => [...mine].map((id) => ({ studentPrincipalId: id, displayName: names[id]! })),
    "guardian.childOfferings": ({ params }) => CLASSES[child(params.studentId)],
    "guardian.childCourse": ({ params }) => {
      const found = CLASSES[child(params.studentId)].find((c) => c.offering.id === params.offeringId);
      const course = COURSES[`${params.studentId}:${params.offeringId}`];
      if (found === undefined || course === undefined) throw notFound();
      return { ...found, ...course };
    },
    "me.preferences": () => preferences,
    "me.updatePreferences": ({ body }) => (preferences = { ...preferences, email: { ...preferences.email, ...body.email } }),
    "onboarding.previewGuardianInvitation": ({ body }) => {
      if (body.token !== "tok_valid") throw new DistrictApiError(404, { code: "not-found", message: "This invitation link can't be used. Ask the school for a new one." });
      return { studentDisplayName: "Amara Okafor", schoolName: "Northfield High School" };
    },
    "onboarding.redeemGuardianInvitation": ({ body }) => {
      if (body.token !== "tok_valid") throw new DistrictApiError(404, { code: "not-found", message: "This invitation link can't be used. Ask the school for a new one." });
      return { outcome: "awaiting-approval" };
    },
  };

  return {
    calls,
    failNext: (name, error) => void failures.set(name, error),
    async call<N extends RouteName>(name: N, ...args: [RouteInput<N>?]): Promise<RouteResponse<N>> {
      const input = (args[0] ?? {}) as RouteInput<N>;
      calls.push({ name, input });
      await Promise.resolve();
      const failure = failures.get(name);
      if (failure !== undefined) {
        failures.delete(name);
        throw failure;
      }
      const handler = handlers[name] as ((input: RouteInput<N>) => unknown) | undefined;
      if (handler === undefined) throw forbidden();
      return structuredClone(handler(input)) as RouteResponse<N>;
    },
  };
}
