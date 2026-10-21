// The analysis behind `compare-access-jwts.ts` (SCHO-37): given the Access JWT payloads and
// get-identity responses recorded while following
// `docs/schoolos/runbooks/access-sub-stability.md`, decide whether Access `sub` survives an email
// reassignment, an in-place email rename, and deleting the Access user, and which ADR-0003 outcome
// that is. Pure and offline: it never fetches anything and never verifies a signature, because it
// only ever reads tokens the operator captured from their own test organization.
import { z } from "zod";

/**
 * The runbook's steps, in order. Each names who signs in and what changed in the IdP or in Access
 * just before.
 */
export const StudyStep = z.enum([
  /** Person A signs in for the first time. */
  "s1-baseline",
  /** Person A signs in again after their Access session was revoked. Nothing else changed. */
  "s2-repeat",
  /** Person A's IdP email was renamed in place (same IdP account, new address). A signs in. */
  "s3-rename",
  /** A's original address now belongs to a new IdP account, person B. B signs in. */
  "s4-reassigned",
  /** The Access user record for the original address was deleted. B signs in again. */
  "s5-after-delete",
]);
/** A runbook step. */
export type StudyStep = z.infer<typeof StudyStep>;

/** Which test person signed in: A is the original holder of the address, B the reassigned one. */
export const StudyPerson = z.enum(["a", "b"]);
/** A test person. */
export type StudyPerson = z.infer<typeof StudyPerson>;

/** The person each step must be recorded for. A recording that disagrees is refused. */
export const STEP_PERSON: Readonly<Record<StudyStep, StudyPerson>> = {
  "s1-baseline": "a",
  "s2-repeat": "a",
  "s3-rename": "a",
  "s4-reassigned": "b",
  "s5-after-delete": "b",
};

/**
 * The claims of an Access application token this study reads. Access adds others; they are
 * ignored, which is why this one object is not strict.
 */
export const AccessTokenClaims = z.object({
  iss: z.string().min(1),
  sub: z.string(),
  email: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iat: z.number().optional(),
  identity_nonce: z.string().optional(),
});
/** Access token claims. */
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/**
 * The fields of a `/cdn-cgi/access/get-identity` response this study reads: the Access user
 * record ID and the upstream IdP's own subject. Like the token, the response carries much more, and
 * the rest is ignored.
 */
export const AccessIdentityFields = z.object({
  user_uuid: z.string().optional(),
  idp: z.object({ id: z.string(), type: z.string() }).optional(),
  /** OIDC IdPs put the upstream claims here, including the IdP's `sub`. */
  oidc_fields: z.record(z.string(), z.unknown()).optional(),
  /** SAML IdPs put the asserted attributes here; the NameID is not guaranteed to appear. */
  saml_attributes: z.record(z.string(), z.unknown()).optional(),
});
/** get-identity fields. */
export type AccessIdentityFields = z.infer<typeof AccessIdentityFields>;

/** One decoded observation: a step, who signed in, the token's claims and the identity response. */
export interface StudyObservation {
  readonly step: StudyStep;
  readonly person: StudyPerson;
  readonly claims: AccessTokenClaims;
  readonly identity?: AccessIdentityFields;
}

/** Whether two observations agree on a value, or why the question can't be answered. */
export type Comparison = "same" | "different" | "not-recorded";

/** The study's answers. Each compares one value between two steps. */
export interface StudyFindings {
  /** Control: does `sub` stay put when nothing changed? Anything but `same` invalidates the run. */
  readonly repeatSub: Comparison;
  /** Does an in-place email rename keep A's `sub`? `different` splits one person in two. */
  readonly renameSub: Comparison;
  /** Does B, holding A's old address, get A's `sub`? `same` merges two people into one. */
  readonly reassignedSub: Comparison;
  /** After the Access user is deleted, does B get a `sub` different from A's original? */
  readonly afterDeleteSubVsBaseline: Comparison;
  /** Does the upstream IdP subject tell A and B apart at the reassignment step? */
  readonly upstreamSubjectReassigned: Comparison;
  /** Does the upstream IdP subject stay put across A's rename? */
  readonly upstreamSubjectRename: Comparison;
}

/**
 * Which ADR-0003 outcome the findings support (see the runbook's "Outcomes" section):
 *
 * - `invalid-run`: the control failed or a required step is missing; repeat the study.
 * - `sub-follows-idp-account`: `sub` survives a rename and is not handed to a reassigned address.
 *   Access `sub` is safe as the subject; the caveat can be removed.
 * - `sub-keyed-by-email-delete-resets`: a reassigned address inherits `sub` until the Access user
 *   is deleted, after which it gets a new one. Offboarding must delete the Access user.
 * - `sub-keyed-by-email-sticky`: a reassigned address inherits `sub` even after deletion. Access
 *   `sub` must not be the subject; use the upstream IdP subject.
 * - `sub-splits-on-rename`: `sub` is not handed to a reassigned address but changes on a rename.
 *   Safe against merging; renames need an administrator relink.
 */
export type StudyOutcome =
  | "invalid-run"
  | "sub-follows-idp-account"
  | "sub-keyed-by-email-delete-resets"
  | "sub-keyed-by-email-sticky"
  | "sub-splits-on-rename";

/** The report the CLI prints. It names no email address and carries no token. */
export interface StudyReport {
  readonly issuer: string;
  readonly findings: StudyFindings;
  readonly outcome: StudyOutcome;
  /** Every reason the run is invalid, or empty. */
  readonly problems: readonly string[];
}

/**
 * The upstream IdP's subject from a get-identity response: `oidc_fields.sub` for an OIDC IdP, or
 * undefined where the response does not carry it (SAML without a NameID attribute, or no
 * response recorded).
 */
export function upstreamSubject(identity: AccessIdentityFields | undefined): string | undefined {
  const sub = identity?.oidc_fields?.["sub"];
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

function compare(left: string | undefined, right: string | undefined): Comparison {
  if (left === undefined || right === undefined) return "not-recorded";
  return left === right ? "same" : "different";
}

/**
 * Compares the observations and picks an outcome. Refuses (`invalid-run`, with reasons) when a
 * step is recorded twice or for the wrong person, when tokens come from more than one issuer, when
 * a token has an empty `sub`, or when the repeat-sign-in control shows `sub` moving on its own.
 */
export function analyzeStudy(observations: readonly StudyObservation[]): StudyReport {
  const problems: string[] = [];
  const byStep = new Map<StudyStep, StudyObservation>();
  for (const observation of observations) {
    if (byStep.has(observation.step)) problems.push(`${observation.step} is recorded more than once.`);
    if (STEP_PERSON[observation.step] !== observation.person) {
      problems.push(`${observation.step} must be person ${STEP_PERSON[observation.step]}'s sign-in.`);
    }
    if (observation.claims.sub.length === 0) problems.push(`${observation.step}'s token has an empty sub (a service token?).`);
    byStep.set(observation.step, observation);
  }
  const issuers = new Set(observations.map((o) => o.claims.iss));
  if (issuers.size > 1) problems.push("The tokens come from more than one Access team domain.");

  const sub = (step: StudyStep) => byStep.get(step)?.claims.sub || undefined;
  const upstream = (step: StudyStep) => upstreamSubject(byStep.get(step)?.identity);
  const findings: StudyFindings = {
    repeatSub: compare(sub("s1-baseline"), sub("s2-repeat")),
    renameSub: compare(sub("s1-baseline"), sub("s3-rename")),
    reassignedSub: compare(sub("s1-baseline"), sub("s4-reassigned")),
    afterDeleteSubVsBaseline: compare(sub("s1-baseline"), sub("s5-after-delete")),
    upstreamSubjectReassigned: compare(upstream("s1-baseline"), upstream("s4-reassigned")),
    upstreamSubjectRename: compare(upstream("s1-baseline"), upstream("s3-rename")),
  };
  for (const step of StudyStep.options) if (!byStep.has(step)) problems.push(`${step} is not recorded.`);
  if (findings.repeatSub === "different") problems.push("sub changed with nothing changed (s1 vs s2); the control failed.");

  return { issuer: [...issuers][0] ?? "", findings, outcome: problems.length > 0 ? "invalid-run" : outcomeOf(findings), problems };
}

function outcomeOf(findings: StudyFindings): StudyOutcome {
  if (findings.reassignedSub === "same") {
    return findings.afterDeleteSubVsBaseline === "different" ? "sub-keyed-by-email-delete-resets" : "sub-keyed-by-email-sticky";
  }
  return findings.renameSub === "same" ? "sub-follows-idp-account" : "sub-splits-on-rename";
}
