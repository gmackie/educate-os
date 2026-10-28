// What each role finds in the shell's sidebar (the plan's §4 "Navigation by role"). Plain data, so
// the role sets are tested without rendering and every SPA on the origin offers the same places.
//
// The district origin serves several SPAs side by side (scripts/production/assemble-district-ui.ts),
// so an entry is a plain href, and following one into another SPA is an ordinary page load on the
// same origin. The hrefs name the routes that exist today:
//
//   Learning Home (educateos-student-ui, path-routed at `/`, src/router.tsx)
//     Home            /                 the HomePage
//     Classes         /#my-courses      Home's "My courses" section: the SPA has no class index of its
//                                       own; each class is /courses/<offeringId>
//     Calendar        /calendar         CalendarPage
//     Inbox           /notifications    NotificationsPage (the header bell today)
//     Grades          /grades           GradesPage
//     My Space        /my-space         MySpacePage
//     Family          /family           FamilyHomePage, and /family/children/<id>/...
//   Teacher Studio (educateos-teacher-ui, hash-routed under `/teach/`, src/route.ts)
//     Today           /teach/           the class list, its landing screen (no "today" screen yet)
//     Classes         /teach/#/classes  the class list too (parseRoute reads a bare #/classes as it);
//                                       a class is #/classes/<offeringId>/<section>
//     Gradebook       /teach/#/classes  per class only (#/classes/<id>/gradebook); the class list is
//                                       where a teacher picks one
//     Content studio  /teach/#/classes  per class only (#/classes/<id>/resources, the review queue)
//   Admin console (educateos-admin-ui, hash-routed under `/admin/`, src/app/useHashRoute.ts SCREENS)
//     Dashboard #/dashboard · Roster #/roster · All classes #/classes · Guardians #/guardians ·
//     Policies #/policies · AI usage #/ai-usage · AI budgets #/ai-budgets · Term rollover #/term-rollover
//   AI workspace (the Workshop, moving to `/ai` in the one-origin plan)
//     AI workspace    /ai/
//
// Guardians are taken from every non-family path to /family by the Learning Home today, so their
// Calendar and Inbox entries only open once that SPA adopts the shell (a later wave).

/** Who the shell is framing. A school admin is staff who also holds an admin role. */
export type ShellRole = "student" | "teacher" | "guardian" | "school-admin";

/** What the district offers, from its manifest and its policy, that changes the navigation. */
export interface ShellFeatures {
  /** Whether this district has an AI workspace. Off hides every AI entry. */
  ai: boolean;
  /** Whether the district's policy lets guardians use the AI workspace. Off by default. */
  guardianAi?: boolean;
  /** Where the installed operations console is (admin.educateos.io, or the district's own), if any. */
  operationsUrl?: string;
}

/** The icons the navigation names; the shell draws each one. */
export type NavIcon =
  | "home"
  | "classes"
  | "calendar"
  | "inbox"
  | "grades"
  | "ai"
  | "my-space"
  | "today"
  | "gradebook"
  | "studio"
  | "family"
  | "dashboard"
  | "roster"
  | "guardians"
  | "policies"
  | "budgets"
  | "usage"
  | "rollover"
  | "external";

/** Where the browser is, as far as matching a navigation entry goes. */
export interface ShellLocation {
  pathname: string;
  hash: string;
}

/** One sidebar entry. */
export interface NavItem {
  /** Stable across releases: what a badge or a test names. */
  id: string;
  label: string;
  href: string;
  icon: NavIcon;
  /** Whether this entry is the place the browser is at, which marks it `aria-current="page"`. */
  active: (location: ShellLocation) => boolean;
  /** Leaves the district origin (opens in a new tab). */
  external?: boolean;
}

/** A titled run of entries. The first group of a role has no title. */
export interface NavGroup {
  id: string;
  label?: string;
  items: NavItem[];
}

const TEACH = "/teach/";
const ADMIN = "/admin/";

const atPath = (pathname: string) => (location: ShellLocation) => location.pathname === pathname;
const underPath = (prefix: string) => (location: ShellLocation) =>
  location.pathname === prefix || location.pathname.startsWith(`${prefix}/`);
const inSpa = (base: string, location: ShellLocation) => location.pathname === base || location.pathname === base.slice(0, -1);
/** The hash's path segments: `#/classes/a/gradebook` is ["classes", "a", "gradebook"]. */
const hashParts = (hash: string) => hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "");

const learningHome = (location: ShellLocation) => location.pathname === "/" && location.hash !== "#my-courses";
const studentClasses = (location: ShellLocation) =>
  (location.pathname === "/" && location.hash === "#my-courses") || underPath("/courses")(location);

const teacherSection = (location: ShellLocation): string | undefined => {
  if (!inSpa(TEACH, location)) return undefined;
  const [first, , section] = hashParts(location.hash);
  if (first !== "classes") return "today";
  return section === "gradebook" ? "gradebook" : section === "resources" ? "studio" : "classes";
};
const teacherAt = (section: string) => (location: ShellLocation) => teacherSection(location) === section;

const adminAt = (screen: string, isDefault = false) => (location: ShellLocation) => {
  if (!inSpa(ADMIN, location)) return false;
  const [first] = hashParts(location.hash);
  return first === screen || (isDefault && first === undefined);
};

const aiItem: NavItem = { id: "ai", label: "AI workspace", href: "/ai/", icon: "ai", active: underPath("/ai") };
const calendarItem: NavItem = { id: "calendar", label: "Calendar", href: "/calendar", icon: "calendar", active: atPath("/calendar") };
const inboxItem: NavItem = { id: "inbox", label: "Inbox", href: "/notifications", icon: "inbox", active: atPath("/notifications") };

const studentGroups = (features: ShellFeatures): NavGroup[] => [
  {
    id: "main",
    items: [
      { id: "home", label: "Home", href: "/", icon: "home", active: learningHome },
      { id: "classes", label: "Classes", href: "/#my-courses", icon: "classes", active: studentClasses },
      calendarItem,
      inboxItem,
      { id: "grades", label: "Grades", href: "/grades", icon: "grades", active: atPath("/grades") },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      ...(features.ai ? [aiItem] : []),
      { id: "my-space", label: "My Space", href: "/my-space", icon: "my-space", active: atPath("/my-space") },
    ],
  },
];

const teacherGroups = (features: ShellFeatures): NavGroup[] => [
  {
    id: "main",
    items: [
      { id: "today", label: "Today", href: TEACH, icon: "today", active: teacherAt("today") },
      { id: "classes", label: "Classes", href: `${TEACH}#/classes`, icon: "classes", active: teacherAt("classes") },
      { id: "gradebook", label: "Gradebook", href: `${TEACH}#/classes`, icon: "gradebook", active: teacherAt("gradebook") },
      calendarItem,
      inboxItem,
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      ...(features.ai ? [aiItem] : []),
      { id: "studio", label: "Content studio", href: `${TEACH}#/classes`, icon: "studio", active: teacherAt("studio") },
    ],
  },
];

const guardianGroups = (features: ShellFeatures): NavGroup[] => [
  {
    id: "main",
    items: [
      { id: "family", label: "Family", href: "/family", icon: "family", active: underPath("/family") },
      calendarItem,
      inboxItem,
    ],
  },
  ...(features.ai && features.guardianAi === true ? [{ id: "workspace", label: "Workspace", items: [aiItem] }] : []),
];

const adminGroup = (features: ShellFeatures): NavGroup => {
  const operations = safeExternalUrl(features.operationsUrl);
  return {
    id: "admin",
    label: "Admin",
    items: [
      { id: "admin-dashboard", label: "Dashboard", href: `${ADMIN}#/dashboard`, icon: "dashboard", active: adminAt("dashboard", true) },
      { id: "admin-roster", label: "Roster", href: `${ADMIN}#/roster`, icon: "roster", active: adminAt("roster") },
      { id: "admin-classes", label: "All classes", href: `${ADMIN}#/classes`, icon: "classes", active: adminAt("classes") },
      { id: "admin-guardians", label: "Guardians", href: `${ADMIN}#/guardians`, icon: "guardians", active: adminAt("guardians") },
      { id: "admin-policies", label: "Policies", href: `${ADMIN}#/policies`, icon: "policies", active: adminAt("policies") },
      ...(features.ai
        ? [
            { id: "admin-ai-usage", label: "AI usage", href: `${ADMIN}#/ai-usage`, icon: "usage", active: adminAt("ai-usage") } satisfies NavItem,
            { id: "admin-ai-budgets", label: "AI budgets", href: `${ADMIN}#/ai-budgets`, icon: "budgets", active: adminAt("ai-budgets") } satisfies NavItem,
          ]
        : []),
      { id: "admin-rollover", label: "Term rollover", href: `${ADMIN}#/term-rollover`, icon: "rollover", active: adminAt("term-rollover") },
      ...(operations === undefined
        ? []
        : [{ id: "operations", label: "Operations", href: operations, icon: "external", active: () => false, external: true } satisfies NavItem]),
    ],
  };
};

/** The sidebar's groups for `role`, with AI entries only where the district offers them. */
export const navigationFor = (role: ShellRole, features: ShellFeatures): NavGroup[] => {
  switch (role) {
    case "student":
      return studentGroups(features);
    case "teacher":
      return teacherGroups(features);
    case "guardian":
      return guardianGroups(features);
    case "school-admin":
      return [...teacherGroups(features), adminGroup(features)];
  }
};

/** The entry the browser is at, if any: the first match, so overlapping hrefs never mark two. */
export const activeItemId = (groups: readonly NavGroup[], location: ShellLocation): string | undefined =>
  groups.flatMap((group) => group.items).find((item) => item.active(location))?.id;

/** An absolute https URL (http only for a local host), or undefined: never a script or data URL. */
export const safeExternalUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname))) return url.href;
  return undefined;
};

/** A host only this machine reaches, where plain http is acceptable for development. */
export const isLocalHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");

/** What the district directory says about the signed-in principal, as `me.get` returns it. */
export interface ShellPrincipal {
  kind: "student" | "staff" | "guardian" | "service";
  roles: readonly { role: string }[];
}

const ADMIN_ROLES = new Set(["district-admin", "school-admin", "curriculum-admin"]);

/** The shell role for a principal: staff holding an admin role are school admins, other staff teach. */
export const shellRoleOf = (principal: ShellPrincipal): ShellRole => {
  switch (principal.kind) {
    case "student":
      return "student";
    case "guardian":
      return "guardian";
    case "staff":
    case "service":
      return principal.roles.some((assignment) => ADMIN_ROLES.has(assignment.role)) ? "school-admin" : "teacher";
  }
};

/** How the user menu names each role. */
export const ROLE_LABELS: Record<ShellRole, string> = {
  student: "Student",
  teacher: "Teacher",
  guardian: "Parent or guardian",
  "school-admin": "School admin",
};
