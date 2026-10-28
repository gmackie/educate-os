import { describe, expect, it } from "vitest";
import { activeItemId, navigationFor, safeExternalUrl, shellRoleOf, type NavGroup, type ShellRole } from "./navigation.ts";

const labels = (groups: NavGroup[]) => groups.map((group) => [group.label ?? "", group.items.map((item) => item.label)]);
const ids = (groups: NavGroup[]) => groups.flatMap((group) => group.items.map((item) => item.id));
const at = (pathname: string, hash = "") => ({ pathname, hash });
const hrefs = (role: ShellRole) => Object.fromEntries(navigationFor(role, { ai: true }).flatMap((group) => group.items).map((item) => [item.id, item.href]));

describe("navigationFor", () => {
  it("gives a student their places and the workspace group", () => {
    expect(labels(navigationFor("student", { ai: true }))).toEqual([
      ["", ["Home", "Classes", "Calendar", "Inbox", "Grades"]],
      ["Workspace", ["AI workspace", "My Space"]],
    ]);
  });

  it("gives a teacher Teacher Studio's places and the content studio", () => {
    expect(labels(navigationFor("teacher", { ai: true }))).toEqual([
      ["", ["Today", "Classes", "Gradebook", "Calendar", "Inbox"]],
      ["Workspace", ["AI workspace", "Content studio"]],
    ]);
  });

  it("gives a guardian the family view, with AI only where the district's policy allows it", () => {
    expect(labels(navigationFor("guardian", { ai: true }))).toEqual([["", ["Family", "Calendar", "Inbox"]]]);
    expect(labels(navigationFor("guardian", { ai: false, guardianAi: true }))).toEqual([["", ["Family", "Calendar", "Inbox"]]]);
    expect(labels(navigationFor("guardian", { ai: true, guardianAi: true }))).toEqual([
      ["", ["Family", "Calendar", "Inbox"]],
      ["Workspace", ["AI workspace"]],
    ]);
  });

  it("gives a school admin the teacher's places plus the admin console's screens", () => {
    const groups = navigationFor("school-admin", { ai: true });
    expect(groups.map((group) => group.id)).toEqual(["main", "workspace", "admin"]);
    expect(labels(groups)[2]).toEqual(["Admin", ["Dashboard", "Roster", "All classes", "Guardians", "Policies", "AI usage", "AI budgets", "Term rollover"]]);
    expect(groups[2]?.items.every((item) => item.href.startsWith("/admin/#/"))).toBe(true);
  });

  it("adds an Operations link, opening in a new tab, only when an operations console is configured", () => {
    expect(ids(navigationFor("school-admin", { ai: true }))).not.toContain("operations");
    const operations = navigationFor("school-admin", { ai: true, operationsUrl: "https://admin.educateos.io/w/northfield" })
      .flatMap((group) => group.items)
      .find((item) => item.id === "operations");
    expect(operations).toMatchObject({ label: "Operations", href: "https://admin.educateos.io/w/northfield", external: true });
    expect(ids(navigationFor("school-admin", { ai: true, operationsUrl: "javascript:alert(1)" }))).not.toContain("operations");
  });

  it.each<ShellRole>(["student", "teacher", "guardian", "school-admin"])("hides every AI entry from a %s when the district has no AI", (role) => {
    const items = navigationFor(role, { ai: false, guardianAi: true }).flatMap((group) => group.items);
    expect(items.filter((item) => item.href.startsWith("/ai") || item.label.startsWith("AI "))).toEqual([]);
  });

  it("points at the routes each SPA serves today", () => {
    expect(hrefs("student")).toEqual({
      home: "/", classes: "/#my-courses", calendar: "/calendar", inbox: "/notifications", grades: "/grades", ai: "/ai/", "my-space": "/my-space",
    });
    expect(hrefs("teacher")).toEqual({
      today: "/teach/", classes: "/teach/#/classes", gradebook: "/teach/#/classes", calendar: "/calendar", inbox: "/notifications", ai: "/ai/", studio: "/teach/#/classes",
    });
    expect(hrefs("guardian")).toEqual({ family: "/family", calendar: "/calendar", inbox: "/notifications" });
  });
});

describe("activeItemId", () => {
  const student = navigationFor("student", { ai: true });
  const teacher = navigationFor("school-admin", { ai: true });

  it("marks the Learning Home's place, a class under Classes and the AI workspace anywhere under /ai", () => {
    expect(activeItemId(student, at("/"))).toBe("home");
    expect(activeItemId(student, at("/", "#my-courses"))).toBe("classes");
    expect(activeItemId(student, at("/courses/bio-9/activities/lab"))).toBe("classes");
    expect(activeItemId(student, at("/grades"))).toBe("grades");
    expect(activeItemId(student, at("/ai/threads/t1"))).toBe("ai");
    expect(activeItemId(student, at("/air"))).toBeUndefined();
    expect(activeItemId(student, at("/settings"))).toBeUndefined();
  });

  it("follows Teacher Studio's and the admin console's hash routes", () => {
    expect(activeItemId(teacher, at("/teach/"))).toBe("today");
    expect(activeItemId(teacher, at("/teach", "#/"))).toBe("today");
    expect(activeItemId(teacher, at("/teach/", "#/classes"))).toBe("classes");
    expect(activeItemId(teacher, at("/teach/", "#/classes/bio-9/roster"))).toBe("classes");
    expect(activeItemId(teacher, at("/teach/", "#/classes/bio-9/gradebook"))).toBe("gradebook");
    expect(activeItemId(teacher, at("/teach/", "#/classes/bio-9/resources/r1"))).toBe("studio");
    expect(activeItemId(teacher, at("/admin/"))).toBe("admin-dashboard");
    expect(activeItemId(teacher, at("/admin/", "#/ai-budgets"))).toBe("admin-ai-budgets");
    expect(activeItemId(teacher, at("/admin/", "#/classes"))).toBe("admin-classes");
  });

  it("marks nothing for a guardian outside the family view's places", () => {
    const guardian = navigationFor("guardian", { ai: false });
    expect(activeItemId(guardian, at("/family/children/s1"))).toBe("family");
    expect(activeItemId(guardian, at("/familyx"))).toBeUndefined();
  });
});

describe("shellRoleOf", () => {
  it("maps the district directory's principal onto a shell role", () => {
    expect(shellRoleOf({ kind: "student", roles: [{ role: "student" }] })).toBe("student");
    expect(shellRoleOf({ kind: "guardian", roles: [] })).toBe("guardian");
    expect(shellRoleOf({ kind: "staff", roles: [{ role: "teacher" }] })).toBe("teacher");
    expect(shellRoleOf({ kind: "staff", roles: [{ role: "teacher" }, { role: "school-admin" }] })).toBe("school-admin");
    expect(shellRoleOf({ kind: "staff", roles: [{ role: "district-admin" }] })).toBe("school-admin");
  });
});

describe("safeExternalUrl", () => {
  it("accepts https, and http only on a local host", () => {
    expect(safeExternalUrl("https://admin.educateos.io")).toBe("https://admin.educateos.io/");
    expect(safeExternalUrl("http://localhost:5190/")).toBe("http://localhost:5190/");
    expect(safeExternalUrl("http://admin.example.org")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,hi")).toBeUndefined();
    expect(safeExternalUrl("/admin")).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
  });
});
