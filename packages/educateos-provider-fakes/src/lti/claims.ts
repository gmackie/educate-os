// The LTI 1.3 vocabulary a platform fake speaks: claim URIs, OAuth 2 scopes, media types and LIS
// role URIs. Taken from 1EdTech LTI Core 1.3 §5 (message claims) and Appendix A (role vocabularies),
// Deep Linking 2.0 §4, AGS 2.0 §3 (media types, scopes, the endpoint claim), NRPS 2.0 §2 and
// Dynamic Registration 1.0 §3. Defined here rather than imported from `@educateos/lti`, which tests
// against these fakes: importing it would make a dependency cycle.

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const LTI_DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const LTI_AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/";
const LTI_NRPS = "https://purl.imsglobal.org/spec/lti-nrps/claim/";

/** The claim URIs of LTI 1.3 messages, Deep Linking 2.0, AGS 2.0 and NRPS 2.0. */
export const LTI_CLAIMS = {
  messageType: `${LTI}message_type`,
  version: `${LTI}version`,
  deploymentId: `${LTI}deployment_id`,
  targetLinkUri: `${LTI}target_link_uri`,
  resourceLink: `${LTI}resource_link`,
  context: `${LTI}context`,
  roles: `${LTI}roles`,
  roleScopeMentor: `${LTI}role_scope_mentor`,
  custom: `${LTI}custom`,
  toolPlatform: `${LTI}tool_platform`,
  launchPresentation: `${LTI}launch_presentation`,
  lis: `${LTI}lis`,
  lti11LegacyUserId: `${LTI}lti11_legacy_user_id`,
  lti1p1: `${LTI}lti1p1`,
  deepLinkingSettings: `${LTI_DL}deep_linking_settings`,
  contentItems: `${LTI_DL}content_items`,
  data: `${LTI_DL}data`,
  message: `${LTI_DL}msg`,
  log: `${LTI_DL}log`,
  errorMessage: `${LTI_DL}errormsg`,
  errorLog: `${LTI_DL}errorlog`,
  agsEndpoint: `${LTI_AGS}endpoint`,
  nrpsService: `${LTI_NRPS}namesroleservice`,
} as const;

/** The only LTI version 1.3 platforms send. */
export const LTI_VERSION = "1.3.0";

/** The LTI Advantage OAuth 2 scopes (AGS 2.0 §3.1, NRPS 2.0 §2.4). */
export const LTI_SCOPES = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  lineItemReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  resultReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  contextMembershipReadonly: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
} as const;

/** Every LTI Advantage scope a platform fake can grant. */
export const ALL_LTI_SCOPES: readonly string[] = Object.values(LTI_SCOPES);

/** The AGS scopes. */
export const AGS_SCOPES: readonly string[] = [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score];

/** The media types of AGS 2.0 §3.2–3.4 and NRPS 2.0 §2.1. */
export const LTI_MEDIA_TYPES = {
  lineItem: "application/vnd.ims.lis.v2.lineitem+json",
  lineItemContainer: "application/vnd.ims.lis.v2.lineitemcontainer+json",
  score: "application/vnd.ims.lis.v1.score+json",
  resultContainer: "application/vnd.ims.lis.v2.resultcontainer+json",
  membershipContainer: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
} as const;

const LIS = "http://purl.imsglobal.org/vocab/lis/v2/";

/** LIS v2 role URIs (LTI Core 1.3 Appendix A). */
export const LIS_ROLES = {
  /** Context (membership) roles. */
  learner: `${LIS}membership#Learner`,
  instructor: `${LIS}membership#Instructor`,
  contentDeveloper: `${LIS}membership#ContentDeveloper`,
  mentor: `${LIS}membership#Mentor`,
  /** Institution roles. */
  institutionStudent: `${LIS}institution/person#Student`,
  institutionInstructor: `${LIS}institution/person#Instructor`,
  institutionStaff: `${LIS}institution/person#Staff`,
  institutionAdministrator: `${LIS}institution/person#Administrator`,
  institutionMentor: `${LIS}institution/person#Mentor`,
  /** System roles. */
  systemUser: `${LIS}system/person#User`,
  systemAdministrator: `${LIS}system/person#Administrator`,
} as const;

/** The context type of a course section (LTI Core 1.3 Appendix A.1). */
export const COURSE_OFFERING_TYPE = `${LIS}course#CourseOffering`;

/** Claims a caller may set or override on a launch. `undefined` removes a claim. */
export type ClaimOverrides = Readonly<Record<string, unknown>>;

/** Applies `overrides` to `claims` in place: `undefined` deletes, anything else replaces. */
export function applyClaimOverrides(claims: Record<string, unknown>, overrides: ClaimOverrides | undefined): Record<string, unknown> {
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete claims[name];
    else claims[name] = value;
  }
  return claims;
}

/**
 * Whether a membership role URI (or its short form, which NRPS 2.0 §2.3 lets a `role` filter use)
 * names `role`.
 */
export function roleMatches(roles: readonly string[], filter: string): boolean {
  const wanted = filter.includes("#") || filter.includes("/") ? filter : `${LIS}membership#${filter}`;
  return roles.includes(wanted);
}
