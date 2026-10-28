// "Ask AI about this" (SCHO-260): checks a context reference from a link with the district before
// the Workshop attaches it to a chat. See workshop-shared's school-context.ts for the contract.
//
// The district is reached through `EDUCATEOS_DISTRICT_API`, the release's binding to the district
// Worker's `/api` surface (DistrictApi). Holding that binding grants nothing: each request carries
// the signed-in person's own Cloudflare Access assertion, which the district verifies and resolves
// to its principal, so the district answers exactly what that person could read in the LMS. The
// reference is read through the same routes the Learning Home and Teacher Studio use, the student
// one first and then the teacher one; the first that answers decides.

import {
  parseSchoolContextRef,
  type SchoolContext,
  type SchoolContextRef,
  type SchoolContextResolution,
} from "@gadgets/workshop-shared/school-context";

/** The header the district reads the Access assertion from (educateos-district-worker access.ts). */
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/**
 * Any origin will do: a service binding delivers the request to the district Worker whatever its
 * URL says, and the district routes on the path alone.
 */
const DISTRICT_ORIGIN = "https://district.internal";

/** How long the district has to answer each read. */
const READ_TIMEOUT_MS = 5000;

/** The longest title passed on, matching the district's own limit for an assignment's. */
const MAX_TITLE_LENGTH = 200;

/** The district's `/api` surface, as the backend is bound to it. */
export type DistrictApiBinding = Pick<Fetcher, "fetch">;

const REFUSED: SchoolContextResolution = { status: "refused" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A title as it may be shown: control characters dropped, trimmed, at most 200 characters. */
function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = [...value].filter((char) => char.charCodeAt(0) > 0x1f && char !== "\u007f").join("").trim();
  return text === "" ? undefined : text.slice(0, MAX_TITLE_LENGTH);
}

/** Reads one district route as the person, or undefined unless it answers 200 with JSON. */
async function readAsPerson(district: DistrictApiBinding, jwt: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await district.fetch(new Request(DISTRICT_ORIGIN + path, {
      method: "GET",
      headers: { [ACCESS_ASSERTION_HEADER]: jwt, accept: "application/json" },
      // workerd refuses "error"; a redirect is not an answer either way.
      redirect: "manual",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }));
  } catch {
    return undefined;
  }
  // Every body is read, so a refusal never leaves a stream open on the binding.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (response.status !== 200) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The assignment's title from an AssignmentViewBody naming exactly `id`. */
function assignmentTitle(body: unknown, id: string): string | undefined {
  if (!isRecord(body) || !isRecord(body.assignment) || body.assignment.id !== id) return undefined;
  return cleanTitle(body.assignment.title);
}

/**
 * Whether a FeedbackRecord answers for `id`. A submission's feedback is readable by exactly the
 * people who may read the submission: the student who made it and the teachers of its class. The
 * district has no route that names a submission's assignment, so a submission is titled by kind.
 */
function submissionTitle(body: unknown, id: string): string | undefined {
  return isRecord(body) && body.submissionId === id ? "Submission" : undefined;
}

const READS: Record<SchoolContextRef["kind"], {
  paths: (id: string) => string[];
  title: (body: unknown, id: string) => string | undefined;
}> = {
  assignment: {
    paths: (id) => [`/api/student/assignments/${id}`, `/api/teacher/assignments/${id}`],
    title: assignmentTitle,
  },
  submission: {
    paths: (id) => [`/api/student/submissions/${id}/feedback`, `/api/teacher/submissions/${id}/feedback`],
    title: submissionTitle,
  },
};

/**
 * Resolves a context reference for the signed-in person. `district` is the backend's
 * `EDUCATEOS_DISTRICT_API` binding and `jwt` the person's Access assertion. Without a district
 * the reference is `unsupported`; without an assertion (a password or gatekeeper sign-in, which
 * the district cannot verify) it is `refused`, as is anything the district does not confirm.
 */
export async function resolveSchoolContext(
  district: DistrictApiBinding | undefined,
  jwt: string | undefined,
  value: unknown,
): Promise<SchoolContextResolution> {
  if (district === undefined) return { status: "unsupported" };
  const ref = parseSchoolContextRef(value);
  if (ref === undefined || jwt === undefined || jwt === "") return REFUSED;
  const read = READS[ref.kind];
  for (const path of read.paths(ref.id)) {
    const title = read.title(await readAsPerson(district, jwt, path), ref.id);
    if (title !== undefined) {
      const context: SchoolContext = { kind: ref.kind, id: ref.id, title };
      return { status: "attached", context };
    }
  }
  return REFUSED;
}
