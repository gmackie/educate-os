// The district validation suite's scenario registry (SCHO-205): every integration scenario, and for
// each demo district whether it runs, is blocked by an unmerged issue, or is not part of the
// district's integration profile. `__tests__/districts.<slug>.test.ts` register their tests from this
// table (a cell that runs needs a body, a blocked cell is an `it.todo` naming its issues), and the
// per-district gate report joins it with a run. The pilot gate's criteria (`criteria.ts`) are the
// roadmap's rows; these are the integration profiles' scenarios, district by district.
import { DEMO_DISTRICTS, type DemoDistrict, type DemoDistrictSlug, type IntegrationProfile } from "@educateos/fixtures";
import { IssueId } from "./criteria.ts";

/** How a scenario applies to one district. */
export type Applicability =
  /** It runs, in process, against the provider fakes. `direct` says why it calls a domain package rather than the district app over HTTP. */
  | { readonly kind: "runs"; readonly direct?: string }
  /** It applies to the district, but needs an issue that has not merged. Reported NOT YET APPLICABLE. */
  | { readonly kind: "blocked"; readonly blockedBy: readonly string[]; readonly reason: string }
  /** The district's profile has no such integration. Reported as not in profile. */
  | { readonly kind: "not-in-profile" };

/** The scenario groups, in report order. */
export type ScenarioGroup = "identity" | "roster" | "lms" | "operations" | "rfc0002";

/** One scenario: what it checks, and how it applies to a district's integration profile. */
export interface Scenario {
  /** Kebab-case, unique. */
  readonly id: string;
  readonly group: ScenarioGroup;
  /** What the scenario checks. */
  readonly title: string;
  /** How it applies to a demo district, from its integration profile (and, rarely, its data). */
  applies(demo: DemoDistrict): Applicability;
}

const runs = (direct?: string): Applicability => (direct === undefined ? { kind: "runs" } : { kind: "runs", direct });
const blocked = (reason: string, ...blockedBy: string[]): Applicability => ({ kind: "blocked", blockedBy: blockedBy.map((id) => IssueId.parse(id)), reason });
const notInProfile: Applicability = { kind: "not-in-profile" };

const GOOGLE_SIGN_IN = "SCHO-215";
const PROVIDER_HOLD = "SCHO-180";
const REST_APPLY = "SCHO-242";

const NO_CSV_HOLD = "The CSV upload (admin.applyRoster) applies a feed that drops most students in full: the removal hold (SCHO-203) is in the sync runner, which the upload does not use.";
const NO_SYNC_APPLY = "The district app applies only uploaded CSV rosters; nothing applies a OneRoster REST, Clever or Google Classroom sync to a running district, so a drop or a term's end at the source never reaches it.";
const CLEVER_DIRECT = "The district app has no Clever sync route, so the sync runs through `runRosterSync` over the Clever connector (`cleverRosterSource`) and the Clever Data API fake.";
const REST_DIRECT = "The district app has no OneRoster REST sync route, so the sync runs through `runRosterSync` over the OneRoster fake (for a ClassLink district, through `classLinkRosterSource` and its Roster Server).";
const CLASSROOM_DIRECT = "The district app has no Classroom sync route, so the sync runs through `runRosterSync` over the Classroom connector (`classroomRosterSource`, domain-wide delegation) and the Google Classroom fake.";
const CLASSROOM_LMS_DIRECT = "The district app routes no Classroom grade sync, so coursework and grades go through `GoogleClassroomProvider` and `GradePassback`'s Classroom sink against the Google Classroom fake, over the directory the Classroom sync made. Where another source rosters the district, they run over its directory linked to Classroom: courses by alias, and accounts by name only (the Workspace accounts share no email with the directory), so every name link is accepted in bulk where production needs an administrator to confirm each one.";
const LTI_DIRECT = "The district app has no LTI routes; the district Worker serves `@educateos/lti`'s handler, which is driven here over the app's directory.";

/** A roster scenario: by the district's roster source. */
function byRoster(profile: IntegrationProfile, rules: { local?: Applicability; csv: Applicability; rest: Applicability; clever?: Applicability; classroom?: Applicability }): Applicability {
  // The Clever connector (SCHO-203) and Classroom sync (SCHO-77) run through the same runner as
  // OneRoster REST, so a rule for REST applies to them too unless the scenario says otherwise.
  switch (profile.roster) {
    case "local": return rules.local ?? notInProfile;
    case "oneroster-csv": return rules.csv;
    // ClassLink's Roster Server is OneRoster REST under OAuth2, read through SCHO-204's `classLinkRosterSource`.
    case "oneroster-rest": return rules.rest;
    case "clever": return rules.clever ?? (rules.rest.kind === "runs" ? runs(CLEVER_DIRECT) : rules.rest);
    case "google-classroom": return rules.classroom ?? (rules.rest.kind === "runs" ? runs(CLASSROOM_DIRECT) : rules.rest);
  }
}

/** An LMS scenario: by where the district teaches. */
function byLms(profile: IntegrationProfile, lti: Applicability, classroom: Applicability = notInProfile): Applicability {
  switch (profile.lms) {
    case "canvas-lti":
    case "schoology-lti": return lti;
    case "google-classroom": return classroom;
    case "lms-lite": return notInProfile;
  }
}

const everywhere = (direct?: string) => (): Applicability => runs(direct);

/** Every scenario, in report order. */
export const SCENARIOS: readonly Scenario[] = [
  // Identity.
  {
    id: "sso-roles",
    group: "identity",
    title: "each role (student, teacher, administrator, and a guardian where the district has a confirmed one) signs in through the district's trusted issuer and resolves to its own principal; an expired, foreign or unknown credential resolves to no one",
    applies: everywhere(),
  },
  {
    id: "vendor-sso",
    group: "identity",
    title: "the vendor's OIDC sign-in (Clever, ClassLink, Google) resolves to the directory principal through (district, issuer, subject)",
    applies: ({ profile: p }) => {
      switch (p.sso) {
        case "clever": return runs("Cloudflare Access passes Clever's claims to the district Worker, which reads them with `identityFromCleverClaims`; here the claims come from the Clever OIDC fake's userinfo, and resolve against the directory the Clever roster sync made.");
        case "classlink": return runs("The district Worker has no ClassLink sign-in route yet (SCHO-248), so each role signs in through `classLinkSignIn` (authorization code with PKCE, id_token verified, `preferred_username` as the subject) against the ClassLink OIDC fake, and resolves against the directory the ClassLink roster sync made.");
        case "google": return blocked("Google Workspace sign-in for a district is not built yet.", GOOGLE_SIGN_IN);
        default: return notInProfile;
      }
    },
  },
  {
    id: "tenant-isolation",
    group: "identity",
    title: "the district refuses every other demo district's tokens, a subject two districts share resolves to each district's own principal, and no other district's record is reachable by ID",
    applies: everywhere(),
  },
  // Rostering.
  {
    id: "roster-first-sync",
    group: "roster",
    title: "a first sync from the roster source builds the district's directory: every person by (issuer, subject) and every class's active roster",
    applies: ({ profile: p }) => byRoster(p, { local: runs(), csv: runs(), rest: runs(REST_DIRECT) }),
  },
  {
    id: "roster-delta",
    group: "roster",
    title: "a later sync applies only what changed at the source",
    // Classroom has no change feed: every Classroom sync is complete.
    applies: ({ profile: p }) => byRoster(p, { csv: runs(), rest: runs(REST_DIRECT), classroom: notInProfile }),
  },
  {
    id: "drop",
    group: "roster",
    title: "a student dropped at the source loses the class on the next request, and keeps their workspace and work",
    applies: ({ profile: p }) => byRoster(p, { local: runs(), csv: runs(), rest: blocked(NO_SYNC_APPLY, REST_APPLY) }),
  },
  {
    id: "large-removal-hold",
    group: "roster",
    title: "a sync that would remove most of the students is held for an administrator's review, and nothing is deactivated",
    applies: ({ profile: p }) => byRoster(p, {
      csv: blocked(NO_CSV_HOLD, PROVIDER_HOLD),
      rest: runs(REST_DIRECT),
    }),
  },
  {
    id: "roster-outage",
    group: "roster",
    title: "a roster provider outage fails the sync visibly, leaves the directory unchanged, and the next sync after recovery succeeds",
    // A CSV upload has no provider to be down.
    applies: ({ profile: p }) => byRoster(p, { csv: notInProfile, rest: runs(REST_DIRECT) }),
  },
  // LMS.
  {
    id: "lti-launch",
    group: "lms",
    title: "an LTI 1.3 launch from the district's LMS signs the student in to their own principal and class",
    applies: ({ profile: p }) => byLms(p, runs(LTI_DIRECT)),
  },
  {
    id: "lti-deep-link",
    group: "lms",
    title: "a teacher places an activity through Deep Linking, the platform verifies the response, and the placed link launches that activity",
    applies: ({ profile: p }) => byLms(p, runs(LTI_DIRECT)),
  },
  {
    id: "lti-ags",
    group: "lms",
    title: "a teacher-approved grade passes back to the LMS gradebook through AGS, and an unapproved one does not",
    applies: ({ profile: p }) => byLms(p, runs(LTI_DIRECT)),
  },
  {
    id: "lms-outage",
    group: "lms",
    title: "while the LMS is down, grade passback fails without being recorded as posted, and posts once after recovery",
    applies: ({ profile: p }) => byLms(p, runs(LTI_DIRECT), runs(CLASSROOM_LMS_DIRECT)),
  },
  {
    id: "classroom-coursework",
    group: "lms",
    title: "Google Classroom coursework is created and its teacher-approved grades are synced back",
    applies: ({ profile: p }) => byLms(p, notInProfile, runs(CLASSROOM_LMS_DIRECT)),
  },
  // Operations.
  {
    id: "term-rollover",
    group: "operations",
    title: "a term the source of record ends can be closed, which revokes its class grants and course AI funding and keeps the students' work",
    // Who ends a term is the source of record: the administrator in a local district, the next roster sync otherwise.
    applies: ({ profile: p }) => byRoster(p, { local: runs(), csv: runs(), rest: blocked(NO_SYNC_APPLY, REST_APPLY) }),
  },
  {
    id: "export-restore",
    group: "operations",
    title: "a student's archive carries only their own work, and the district restored from a backup serves the same views",
    applies: everywhere("The district app has no export or backup route, so the P01 exporter and the stores' backup are driven directly; views are read over HTTP."),
  },
  {
    id: "root-offline",
    group: "operations",
    title: "with educateos.io unreachable, the entitlement holds and students and teachers keep working",
    applies: everywhere("The root client and entitlement cache are fleet components with no district route; they are driven directly."),
  },
  // RFC 0002 §10 explicit test matrix rows, over the district app's REST surface.
  {
    id: "rfc-wrong-course",
    group: "rfc0002",
    title: "RFC 0002 §10 wrong course: a teacher cannot read or grade a class they do not teach",
    applies: everywhere(),
  },
  {
    id: "rfc-expired-role",
    group: "rfc0002",
    title: "RFC 0002 §10 expired role: an inactive enrollment grants nothing, nor (where the district has one) a completed term's class",
    applies: everywhere(),
  },
  {
    id: "rfc-guardian-other-family",
    group: "rfc0002",
    title: "RFC 0002 §10 guardian from another family: a guardian reads only the children their confirmed relationships open, never another family's, and a pending relationship opens none",
    applies: (demo) => (demo.guardians.length > 0 ? runs() : notInProfile),
  },
  {
    id: "rfc-duplicate-write",
    group: "rfc0002",
    title: "RFC 0002 §10 duplicate write: a repeated submit records one submission",
    applies: everywhere(),
  },
];

/** The scenario with this ID. Throws if there is none. */
export function scenarioById(id: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no district scenario ${id}`);
  return scenario;
}

/** The describe-block title a district's scenarios are registered under. */
export function districtTitle(demo: DemoDistrict): string {
  return `district ${demo.slug}`;
}

/** The name a scenario's test is registered under in a district. A blocked one carries its issues. */
export function scenarioTestName(scenario: Scenario, applicability: Applicability): string {
  return applicability.kind === "blocked" ? `${scenario.id}: ${scenario.title} [not yet applicable: ${applicability.blockedBy.join(", ")}]` : `${scenario.id}: ${scenario.title}`;
}

/** The full name Vitest reports a district's scenario under. */
export function scenarioFullName(demo: DemoDistrict, scenario: Scenario): string {
  return `${districtTitle(demo)} > ${scenarioTestName(scenario, scenario.applies(demo))}`;
}

/** Every (district, scenario) cell, districts in harness order. */
export function cells(): { demo: DemoDistrict; scenario: Scenario; applicability: Applicability }[] {
  return DEMO_DISTRICTS.flatMap((demo) => SCENARIOS.map((scenario) => ({ demo, scenario, applicability: scenario.applies(demo) })));
}

export type { DemoDistrictSlug };
