// What each Learning Home route is called before its screen has loaded what it shows: the document
// title while it loads, fails or is refused. The screen's heading then names it fully (a class's
// name, a quiz's title), WCAG 2.4.2 (SCHO-382).

/** Route patterns, most specific first, with `*` for one path segment. */
const NAMES: readonly (readonly [pattern: string, name: string])[] = [
  ["/", "Home"],
  ["/my-space", "My space"],
  ["/grades", "My grades"],
  ["/calendar", "Calendar"],
  ["/notifications", "Notifications"],
  ["/settings", "Settings"],
  ["/courses/*", "Class"],
  ["/courses/*/activities/*", "Activity"],
  ["/courses/*/quizzes/*", "Quiz"],
  ["/courses/*/quizzes/*/attempts/*", "Quiz results"],
  ["/family", "My children"],
  ["/family/settings", "Family settings"],
  ["/family/invitation", "Family invitation"],
  ["/family/children/*", "Child's classes"],
  ["/family/children/*/courses/*", "Child's class"],
  ["/devices", "Your devices"],
  ["/devices/connect", "Connect your phone"],
];

const segments = (path: string) => path.split("/").filter((part) => part !== "");

/** The name of the route at `pathname`, or "Page not found" for a path the Learning Home doesn't route. */
export const routeName = (pathname: string): string => {
  const parts = segments(pathname);
  for (const [pattern, name] of NAMES) {
    const want = segments(pattern);
    if (want.length === parts.length && want.every((part, i) => part === "*" || part === parts[i])) return name;
  }
  return "Page not found";
};
