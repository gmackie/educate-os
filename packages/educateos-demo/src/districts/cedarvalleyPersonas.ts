// Who a visitor can be in Cedar Valley. Kept apart from the district's boot, which is loaded only
// when a visitor opens Cedar Valley, so the picker can offer them before it arrives.
import type { Persona } from "./shared.ts";

/** Where each persona is in the Cedar Valley fixture, for checking their subjects against the fake. */
export const CEDARVALLEY_PRINCIPALS = {
  student: "prn_cv-student-rowan",
  teacher: "prn_cv-teacher-whitaker",
  admin: "prn_cv-district-admin",
} as const;

/**
 * Who a visitor can be in Cedar Valley, in the order the picker offers them. Each subject is the
 * person's Clever user ID at the in-page Clever district (`CleverDataFake.userId` of their fixture
 * principal, written out so the picker need not load the fake), as Clever SSO would assert it.
 * Only the administrator is local: the teacher and the student exist once the district's first
 * Clever sync has run, and `bootCedarValley`'s tests check each subject against the fake.
 */
export const CEDARVALLEY_PERSONAS: readonly Persona[] = [
  {
    id: "student",
    name: "Rowan Ellis",
    role: "Grade 8 student",
    description: "Open Earth Science 8, write and submit an assignment, and see the classes Clever rostered you into.",
    subject: "a8032d428138945ca8032e42",
    rostered: true,
  },
  {
    id: "teacher",
    name: "Dana Whitaker",
    role: "Earth Science and Algebra teacher",
    description: "See the classes Clever rostered for you, grade work and post an announcement.",
    subject: "7186e6cb7e423ae77186e5cb",
    rostered: true,
  },
  {
    id: "admin",
    name: "Elaine Park",
    role: "District administrator",
    description: "Run the district's first Clever roster sync, then look over the people and classes it brought in.",
    subject: "26c04a9db351d58f26c0499d",
  },
];
