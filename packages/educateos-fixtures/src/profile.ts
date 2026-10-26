import type { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";

/**
 * How a district's people sign in: EducateOS's own `local` accounts, the district's own OIDC IdP,
 * or a vendor's sign-in (Clever SSO, ClassLink SSO, Google Workspace).
 */
export type SsoKind = "local" | "district-oidc" | "clever" | "classlink" | "google";

/** Where a district's directory comes from. `local` means an administrator keeps it by hand. */
export type RosterSourceKind = "local" | "oneroster-csv" | "oneroster-rest" | "clever" | "google-classroom";

/** Where a district's classes are taught: EducateOS's LMS-lite, or an LMS it connects to. */
export type LmsKind = "lms-lite" | "canvas-lti" | "schoology-lti" | "google-classroom";

/** Which system's gradebook holds the grade of record. */
export type GradeAuthority = "educateos" | "canvas" | "schoology" | "google-classroom";

/** The integrations a demo district runs with. */
export interface IntegrationProfile {
  /** How people sign in. Its issuer is the district's only trusted issuer. */
  sso: SsoKind;
  /** Where the directory comes from. */
  roster: RosterSourceKind;
  /** Where classes are taught. */
  lms: LmsKind;
  /** Where the grade of record lives. */
  gradeAuthority: GradeAuthority;
}

/** The slugs of the six demo districts, as served at `<slug>.educateos.io`. */
export type DemoDistrictSlug = "northfield" | "riverbend" | "prairie" | "cedarvalley" | "lakeshore" | "harbor";

/** A synthetic demo district: its directory and everything needed to stand it up. */
export interface DemoDistrict {
  /** The district's slug. */
  slug: DemoDistrictSlug;
  /** The directory, which passes `checkDirectoryIntegrity`. */
  directory: DistrictDirectorySnapshot;
  /** Its guardian relationships, which the directory snapshot does not carry. */
  guardians: readonly GuardianRelationship[];
  /** Its integrations. */
  profile: IntegrationProfile;
  /** The local port `pnpm educateos:harness` serves it on. */
  harnessPort: number;
  /**
   * For a district with Google accounts, the name of its top-level organizational unit in the
   * Google demo tenant. Staff go in `/<name>/Staff` and students in `/<name>/Students`.
   */
  googleOrgUnit?: string;
}
