// The shapes the classes screen authors, from the district API's route table.
import type { RouteResponse } from "@educateos/api-client";

/** The directory as an administrator authors it, with who owns each record type. */
export type AuthoringDirectory = RouteResponse<"admin.authoring">;
/** The record types an authority map covers. */
export type DirectoryKind = keyof AuthoringDirectory["authority"];
/** A catalog course. */
export type Course = AuthoringDirectory["courses"][number];
/** A section of a course in one school and term. */
export type Offering = AuthoringDirectory["offerings"][number];
/** An academic term. */
export type Term = AuthoringDirectory["terms"][number];
/** A student or staff member. */
export type Person = AuthoringDirectory["principals"][number];

/** The subjects a course may have, with their names. */
export const SUBJECTS = [
  ["english-language-arts", "English language arts"],
  ["science", "Science"],
  ["history-social-studies", "History and social studies"],
  ["mathematics", "Mathematics"],
  ["arts", "Arts"],
  ["world-languages", "World languages"],
  ["computer-science", "Computer science"],
  ["health-physical-education", "Health and physical education"],
  ["social-emotional-learning", "Social-emotional learning"],
  ["other", "Other"],
] as const;

/** The state a term moves to next, and the button that moves it there. */
export const NEXT_TERM_STATE = {
  planned: { to: "active", label: "Start term" },
  active: { to: "grading", label: "Start grading" },
  grading: { to: "completed", label: "Close term" },
  completed: undefined,
} as const;

/** Whether EducateOS owns `kind` here, so the console may write it. */
export const isLocal = (directory: AuthoringDirectory, kind: DirectoryKind): boolean => directory.authority[kind] === "local";

/** A section's name: its course and section, such as "Nature Studies · Tuesdays". */
export const sectionLabel = (directory: AuthoringDirectory, offering: Offering): string =>
  `${directory.courses.find((c) => c.id === offering.courseId)?.title ?? "Course"} · ${offering.sectionName}`;

/** Each record type's plural name, for saying who owns it. */
export const DIRECTORY_KIND_NAMES: Record<DirectoryKind, string> = {
  school: "Schools",
  term: "Terms",
  course: "Courses",
  offering: "Sections",
  enrollment: "Enrollments",
  principal: "People",
};
