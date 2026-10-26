// Where the School app is, as the Workshop URL names it (`/gatekeepers/educateos?path=<path>`), and
// what that is in the district screen showing it. The admin console and Teacher Studio keep their
// routes in a hash, the Learning Home in a path; each lives under a prefix of its own here. A
// school's page is the admin console's, but has a prefix of its own, `/schools/<id>`.

/** A place in the School app. */
export type Place =
  | { app: "home" }
  | { app: "admin"; hash: string }
  | { app: "teach"; hash: string }
  | { app: "learn"; path: string };

/** A district screen's app, by its prefix in the School app's paths. */
type HashApp = "admin" | "teach";

const rest = (path: string, prefix: string): string | undefined =>
  path === prefix ? "" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1).replace(/\/+$/, "") : undefined;

/** The place `path` names. Anything unknown is the home page. */
export function placeOf(path: string): Place {
  const school = rest(path, "/schools");
  if (school !== undefined && school !== "") return { app: "admin", hash: `#/schools/${school}` };
  for (const app of ["admin", "teach"] as const) {
    const tail = rest(path, `/${app}`);
    if (tail !== undefined) return { app, hash: `#/${tail}` };
  }
  const learning = rest(path, "/learn");
  if (learning !== undefined) return { app: "learn", path: `/${learning}` };
  return { app: "home" };
}

/** The School app path of `place`. */
export function pathOf(place: Place): string {
  switch (place.app) {
    case "home":
      return "/";
    case "admin":
    case "teach": {
      const tail = place.hash.replace(/^#\/?/, "").replace(/\/+$/, "");
      if (place.app === "admin" && tail.startsWith("schools/")) return `/${tail}`;
      return tail === "" ? `/${place.app}` : `/${place.app}/${tail}`;
    }
    case "learn":
      return place.path === "/" ? "/learn" : `/learn${place.path.replace(/\/+$/, "")}`;
  }
}

/** What a click on a link inside the frame does instead of navigating the frame. */
export type LinkAction =
  | { kind: "route"; hash: string }
  | { kind: "place"; path: string }
  | { kind: "focus"; id: string }
  | { kind: "none" };

/**
 * What following `href` from `app` means. The frame must never navigate itself: a fragment would add
 * to the Workshop's history and anything else would replace the app. Hash routes move the screen's
 * route; the district's own addresses for its screens (`/teach/`, `/` for the Learning Home) move to
 * that screen's place; a `#id` focuses its target. Undefined leaves the click to the screen, as the
 * Learning Home's router links are, and downloads.
 */
export function linkAction(href: string, app: Place["app"]): LinkAction | undefined {
  if (/^(blob|data):/i.test(href)) return undefined;
  if (href.startsWith("#/") && (app === "admin" || app === "teach")) return { kind: "route", hash: href };
  if (href.startsWith("#") && href.length > 1 && !href.startsWith("#/")) return { kind: "focus", id: decodeURIComponent(href.slice(1)) };
  if (app === "learn" && href.startsWith("/") && !href.startsWith("//")) return undefined;
  if (href.startsWith("/") && !href.startsWith("//")) {
    const path = href.split(/[?#]/)[0]!.replace(/\/+$/, "");
    const screen = (["admin", "teach"] as HashApp[]).find((prefix) => path === `/${prefix}` || path.startsWith(`/${prefix}/`));
    if (screen !== undefined) return { kind: "place", path: `/${screen}` };
    if (path === "") return { kind: "place", path: "/learn" };
  }
  return { kind: "none" };
}
