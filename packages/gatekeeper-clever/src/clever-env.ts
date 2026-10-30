// The Clever gatekeeper's configuration, resource types and resource URL grammar.

import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";
import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** Vendor id: the GATEKEEPER_<NAME> binding suffix, lowercased. */
export const VENDOR_ID = "clever";

/**
 * The gatekeeper Worker's environment. Every setting is optional in the type, since a deployment
 * may leave any of them unset; a missing one is refused where it is needed.
 */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** Where this gatekeeper is served, e.g. `https://district.example/gatekeeper/clever`. */
  BASE_URL?: string;
  /** The Clever app's OAuth client ID, which signs users in. */
  CLIENT_ID?: string;
  /** The Clever app's OAuth client secret. */
  CLIENT_SECRET?: string;
  /**
   * A JSON object mapping each Clever district ID to that district's district-app bearer token.
   * Every data read and LMS Connect write is made with it; agents never see it.
   */
  CLEVER_DISTRICT_TOKENS?: string;
  /** The Data API's base, default `https://api.clever.com`. Requests go to `<base>/v3.1/…`. */
  CLEVER_API_BASE?: string;
  /** Clever sign-in's base, default `https://clever.com`: `<base>/oauth/authorize` and `/oauth/tokens`. */
  CLEVER_OAUTH_BASE?: string;
  /**
   * `"true"` asks who to sign in as before going to Clever, and passes it as `login_hint`. Only the
   * demo's fake Clever, which has no sign-in page of its own, needs it; Clever ignores the hint.
   */
  CLEVER_LOGIN_HINT_FORM?: string;
};

export const DEFAULT_API_BASE = "https://api.clever.com";
export const DEFAULT_OAUTH_BASE = "https://clever.com";

/** The Data API base with no trailing slash. */
export function apiBase(env: Env): string {
  return stripTrailingSlashes(env.CLEVER_API_BASE || DEFAULT_API_BASE);
}

/** Clever sign-in's base with no trailing slash. */
export function oauthBase(env: Env): string {
  return stripTrailingSlashes(env.CLEVER_OAUTH_BASE || DEFAULT_OAUTH_BASE);
}

export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/clever");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** The OAuth redirect URI registered with the Clever app. */
export function getOAuthCallbackUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/**
 * The district-app token for a Clever district, or undefined when the deployment holds none. A
 * malformed `CLEVER_DISTRICT_TOKENS` holds none for any district.
 */
export function districtToken(env: Env, districtId: string): string | undefined {
  const raw = env.CLEVER_DISTRICT_TOKENS;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (!Object.hasOwn(parsed, districtId)) return undefined;
  const token = (parsed as Record<string, unknown>)[districtId];
  return typeof token === "string" && token !== "" ? token : undefined;
}

// ---------------------------------------------------------------------------------------------
// Resource types. None is separately grantable: every one needs only the Clever sign-in, and what
// each reaches is decided against the district's records on every call.

export const PROFILE_PATTERN = "https://api.clever.com/me";
export const TEACHER_PATTERN = "https://api.clever.com/me/sections";
export const SECTION_PATTERN = "https://api.clever.com/sections/:sectionId";
export const STUDENT_PATTERN = "https://api.clever.com/me/enrolled-sections";
export const STUDENT_SECTION_PATTERN = "https://api.clever.com/enrolled-sections/:sectionId";
export const DISTRICT_PATTERN = "https://api.clever.com/district/sections";

export const PROFILE_RESOURCE: SupportedResource = {
  urlPattern: PROFILE_PATTERN,
  title: "Clever profile",
  description: "Who you are in Clever: your name, roles, district and schools.",
};

export const SECTION_RESOURCE: SupportedResource = {
  urlPattern: SECTION_PATTERN,
  title: "One section you teach",
  description: "One class you teach: its roster, and assignments and grades in its learning management system.",
  groupedWith: TEACHER_PATTERN,
};

export const TEACHER_RESOURCE: SupportedResource = {
  urlPattern: TEACHER_PATTERN,
  title: "Sections you teach",
  description: "Every class you teach: rosters, and assignments and grades in their learning management systems.",
};

export const STUDENT_SECTION_RESOURCE: SupportedResource = {
  urlPattern: STUDENT_SECTION_PATTERN,
  title: "One class you are in",
  description: "One class you are enrolled in: its teachers, the assignments posted to it, and your own work.",
  groupedWith: STUDENT_PATTERN,
};

export const STUDENT_RESOURCE: SupportedResource = {
  urlPattern: STUDENT_PATTERN,
  title: "Your classes",
  description: "Every class you are enrolled in: teachers, assignments posted to them, and your own work.",
};

export const DISTRICT_RESOURCE: SupportedResource = {
  urlPattern: DISTRICT_PATTERN,
  title: "Every section in your district",
  description:
    "For district administrators: every section in the district, as a teacher's connection reaches one. " +
    "Each read and change is recorded in the district's audit log.",
};

/**
 * In declaration order. No pattern here matches another's URLs, but a narrower type still comes
 * before the broader one on its card.
 */
export const SUPPORTED_RESOURCES: SupportedResource[] = [
  PROFILE_RESOURCE,
  SECTION_RESOURCE,
  TEACHER_RESOURCE,
  STUDENT_SECTION_RESOURCE,
  STUDENT_RESOURCE,
  DISTRICT_RESOURCE,
];

/** What a resource URL names. */
export type CleverTarget =
  | { kind: "profile" }
  | { kind: "teacher" }
  | { kind: "section"; sectionId: string }
  | { kind: "student" }
  | { kind: "studentSection"; sectionId: string }
  | { kind: "district" };

export type CleverTargetKind = CleverTarget["kind"];

/** Clever IDs are ObjectIds; anything else could name another path, so it is refused. */
export const CLEVER_ID = /^[0-9a-f]{24}$/;

export const RESOURCE_BY_KIND: Record<CleverTargetKind, SupportedResource> = {
  profile: PROFILE_RESOURCE,
  teacher: TEACHER_RESOURCE,
  section: SECTION_RESOURCE,
  student: STUDENT_RESOURCE,
  studentSection: STUDENT_SECTION_RESOURCE,
  district: DISTRICT_RESOURCE,
};

/** Parses a resource URL. A trailing slash is tolerated, as the Workshop's matching is. */
export function parseResourceUrl(url: string): CleverTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That is not a Clever resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.host !== "api.clever.com" || parsed.search || parsed.hash) {
    throw new Error("That is not a Clever resource URL.");
  }
  const path = stripTrailingSlashes(parsed.pathname);
  if (path === "/me") return { kind: "profile" };
  if (path === "/me/sections") return { kind: "teacher" };
  if (path === "/me/enrolled-sections") return { kind: "student" };
  if (path === "/district/sections") return { kind: "district" };
  const section = /^\/(sections|enrolled-sections)\/([^/]+)$/.exec(path);
  if (section && CLEVER_ID.test(section[2]!)) {
    return section[1] === "sections"
      ? { kind: "section", sectionId: section[2]! }
      : { kind: "studentSection", sectionId: section[2]! };
  }
  throw new Error("That is not a Clever resource URL.");
}

/** The canonical URL of a target. */
export function resourceUrlOf(target: CleverTarget): string {
  switch (target.kind) {
    case "profile": return "https://api.clever.com/me";
    case "teacher": return "https://api.clever.com/me/sections";
    case "section": return `https://api.clever.com/sections/${target.sectionId}`;
    case "student": return "https://api.clever.com/me/enrolled-sections";
    case "studentSection": return `https://api.clever.com/enrolled-sections/${target.sectionId}`;
    case "district": return "https://api.clever.com/district/sections";
  }
}
