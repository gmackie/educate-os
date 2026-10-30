// "Ask AI about this" (SCHO-260): the Learning Home and Teacher Studio link into the AI workspace
// with `/ai/?context=assignment:<id>` or `/ai/?context=submission:<id>`. The reference in the URL is
// only a request. The backend asks the district whether the signed-in person may read that
// assignment or submission, and gets its title, before the Workshop attaches it to a new chat. A
// reference the district refuses or doesn't know is dropped without saying which it was.

/** What a context link may name. */
export type SchoolContextKind = "assignment" | "submission";

/** A context reference as a link carries it, parsed. Unverified. */
export interface SchoolContextRef {
  kind: SchoolContextKind;
  /** A district ID: `asg_…` for an assignment, `sub_…` for a submission. */
  id: string;
}

/** A context the district confirmed the signed-in person may read. */
export interface SchoolContext extends SchoolContextRef {
  /** The district's name for it, as the person may see it. */
  title: string;
}

/**
 * What the backend answers for a reference:
 * - `attached`: the district confirmed it, and this is what to attach.
 * - `refused`: malformed, unknown, or not the person's to read. Which of these is never said.
 * - `unsupported`: the deployment has no district to ask, so the reference is ignored.
 */
export type SchoolContextResolution =
  | { status: "attached"; context: SchoolContext }
  | { status: "refused" }
  | { status: "unsupported" };

// The district's ID grammar: a kind prefix, then a lowercase body (educateos-contracts ids.ts and
// educateos-assessment model.ts).
const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";
const PATTERNS: Record<SchoolContextKind, RegExp> = {
  assignment: new RegExp(`^asg_${ID_BODY}$`),
  submission: new RegExp(`^sub_${ID_BODY}$`),
};

/** The longest reference accepted: the longest kind, a colon and the longest ID. */
export const MAX_SCHOOL_CONTEXT_REF_LENGTH = "submission:".length + 4 + 63;

/** Parses `assignment:<id>` or `submission:<id>`. Anything else, or an ID of the wrong kind, is undefined. */
export function parseSchoolContextRef(value: unknown): SchoolContextRef | undefined {
  if (typeof value !== "string" || value.length > MAX_SCHOOL_CONTEXT_REF_LENGTH) return undefined;
  const separator = value.indexOf(":");
  if (separator < 0) return undefined;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind !== "assignment" && kind !== "submission") return undefined;
  return PATTERNS[kind].test(id) ? { kind, id } : undefined;
}

/** The reference's link form, `kind:id`. */
export function formatSchoolContextRef(ref: SchoolContextRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** How the composer's chip names a kind. */
export const SCHOOL_CONTEXT_LABELS: Record<SchoolContextKind, string> = {
  assignment: "Assignment",
  submission: "Submission",
};

/**
 * The line the Workshop puts before the person's first message when a context is attached, so the
 * model knows what "this" means and which ID to read with the school tools.
 */
export function schoolContextPreamble(context: SchoolContext): string {
  const title = context.title.replace(/["\r\n]/g, " ").trim();
  return `[School context: ${context.kind} ${context.id}, "${title}"]`;
}
