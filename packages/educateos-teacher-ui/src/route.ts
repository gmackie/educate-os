import { useSyncExternalStore } from "react";
import { assignHash, readHash, subscribeToHash } from "@gadgets/ui/hash-location";

/** A Teacher Studio screen and the identifiers it shows. */
export type Route =
  | { screen: "classes" }
  | { screen: "roster"; offeringId: string }
  | { screen: "modules"; offeringId: string }
  | { screen: "resources"; offeringId: string }
  | { screen: "resource"; offeringId: string; itemId: string }
  | { screen: "create"; offeringId: string }
  | { screen: "submissions"; offeringId: string; assignmentId?: string }
  | { screen: "review"; offeringId: string; assignmentId: string; submissionId: string }
  // Gradebook (SCHO-187)
  | { screen: "gradebook"; offeringId: string }
  | { screen: "announcements"; offeringId: string }
  // Discussions (SCHO-190).
  | { screen: "discussions"; offeringId: string }
  // Quizzes (SCHO-191).
  | { screen: "quizzes"; offeringId: string }
  | { screen: "quiz"; offeringId: string; quizId: string }
  | { screen: "quiz-results"; offeringId: string; quizId: string };

/** The sections of a class, in navigation order. */
export const CLASS_SECTIONS = [
  { screen: "roster", label: "Roster" },
  { screen: "modules", label: "Modules" },
  { screen: "resources", label: "Resources" },
  { screen: "create", label: "Create activity" },
  { screen: "submissions", label: "Submissions" },
  // Gradebook (SCHO-187)
  { screen: "gradebook", label: "Gradebook" },
  { screen: "announcements", label: "Announcements" },
  // Discussions (SCHO-190).
  { screen: "discussions", label: "Discussions" },
  // Quizzes (SCHO-191).
  { screen: "quizzes", label: "Quizzes" },
] as const;

/** The hash a route lives at. */
export const routeHref = (route: Route): string => {
  switch (route.screen) {
    case "classes":
      return "#/";
    case "roster":
    case "modules":
    case "resources":
    case "create":
    case "gradebook":
    case "announcements":
    case "discussions":
    case "quizzes":
      return `#/classes/${encodeURIComponent(route.offeringId)}/${route.screen}`;
    // Quizzes (SCHO-191).
    case "quiz":
      return `#/classes/${encodeURIComponent(route.offeringId)}/quizzes/${encodeURIComponent(route.quizId)}`;
    case "quiz-results":
      return `#/classes/${encodeURIComponent(route.offeringId)}/quizzes/${encodeURIComponent(route.quizId)}/results`;
    case "resource":
      return `#/classes/${encodeURIComponent(route.offeringId)}/resources/${encodeURIComponent(route.itemId)}`;
    case "submissions":
      return route.assignmentId === undefined
        ? `#/classes/${encodeURIComponent(route.offeringId)}/submissions`
        : `#/classes/${encodeURIComponent(route.offeringId)}/assignments/${encodeURIComponent(route.assignmentId)}`;
    case "review":
      return `#/classes/${encodeURIComponent(route.offeringId)}/assignments/${encodeURIComponent(route.assignmentId)}/submissions/${encodeURIComponent(route.submissionId)}`;
  }
};

/** The route a hash names. Anything unrecognized is the class list. */
export const parseRoute = (hash: string): Route => {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "").map(decodeURIComponent);
  if (parts[0] !== "classes" || parts[1] === undefined) return { screen: "classes" };
  const offeringId = parts[1];
  const [section, id, child, childId] = parts.slice(2);
  if (section === "roster" || section === "modules" || section === "create" || section === "gradebook" || section === "announcements" || section === "discussions") return { screen: section, offeringId };
  // Quizzes (SCHO-191).
  if (section === "quizzes") {
    if (id === undefined) return { screen: "quizzes", offeringId };
    return child === "results" ? { screen: "quiz-results", offeringId, quizId: id } : { screen: "quiz", offeringId, quizId: id };
  }
  if (section === "resources") return id === undefined ? { screen: "resources", offeringId } : { screen: "resource", offeringId, itemId: id };
  if (section === "submissions") return { screen: "submissions", offeringId };
  if (section === "assignments" && id !== undefined) {
    return child === "submissions" && childId !== undefined
      ? { screen: "review", offeringId, assignmentId: id, submissionId: childId }
      : { screen: "submissions", offeringId, assignmentId: id };
  }
  return { screen: "roster", offeringId };
};


/** The current route, kept in the URL hash so the back button and bookmarks work. */
export const useRoute = (): Route => parseRoute(useSyncExternalStore(subscribeToHash, readHash));

/** Moves to `route`. */
export const navigate = (route: Route): void => {
  assignHash(routeHref(route));
};
