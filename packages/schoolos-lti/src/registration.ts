import { z } from "zod";
import { ActivityId, DistrictId, ExternalIdentity, OfferingId, ProviderName } from "@schoolos/contracts";

const LtiId = z.string().min(1).max(255);
const HttpsUrl = z.url({ protocol: /^https$/ });

/** Maps one LTI context (a course in the platform) to the SchoolOS offering it launches into. */
export const OfferingMapping = z.strictObject({
  /** The platform's `context.id`. */
  contextId: LtiId,
  offeringId: OfferingId,
});
/** An offering mapping. */
export type OfferingMapping = z.infer<typeof OfferingMapping>;

/**
 * Maps one link in one offering to a SchoolOS activity. `linkId` is either the platform's
 * `resource_link.id` (configured by an administrator) or the link ID SchoolOS wrote into a
 * deep-linked content item's `schoolos_link` custom parameter. Either way the mapping is SchoolOS
 * configuration: nothing in a launch names an activity by itself, and a link only ever resolves
 * inside the offering it was configured for.
 */
export const ActivityLink = z.strictObject({
  offeringId: OfferingId,
  linkId: LtiId,
  activityId: ActivityId,
});
/** An activity link. */
export type ActivityLink = z.infer<typeof ActivityLink>;

/**
 * One LTI platform registration: a tool `client_id` issued by one platform `issuer`, owned by one
 * district. A launch is accepted only through a registration, only from one of its deployments,
 * and only into an offering its mappings name.
 *
 * A platform like Canvas Cloud uses a single issuer for every customer, so the issuer alone does
 * not identify a district; `(issuer, clientId)` does.
 */
export const PlatformRegistration = z
  .strictObject({
    districtId: DistrictId,
    /**
     * The system this platform is in the district's authority map (`external:<provider>`) and grade
     * authorities (`lms:<provider>`), such as `canvas`. An administrator names it at approval.
     */
    provider: ProviderName,
    /** The platform's `iss`, exactly as its tokens carry it. The district must trust it. */
    issuer: ExternalIdentity.shape.issuer,
    /** The tool's client ID at the platform; launches carry it as `aud`. */
    clientId: LtiId,
    /** The tool deployments launches may come through. */
    deploymentIds: z.array(LtiId).min(1),
    /** The platform's OIDC authorization endpoint. */
    authLoginUrl: HttpsUrl,
    /** The platform's OAuth 2 token endpoint (used by the AGS and NRPS services, I02). */
    authTokenUrl: HttpsUrl,
    /** The platform's JWKS, which signs its id_tokens. */
    jwksUrl: HttpsUrl,
    offerings: z.array(OfferingMapping),
    activityLinks: z.array(ActivityLink),
  })
  .superRefine((registration, ctx) => {
    const contexts = registration.offerings.map((mapping) => mapping.contextId);
    if (new Set(contexts).size !== contexts.length) {
      ctx.addIssue({ code: "custom", path: ["offerings"], message: "each LTI context maps to one offering" });
    }
    if (new Set(registration.deploymentIds).size !== registration.deploymentIds.length) {
      ctx.addIssue({ code: "custom", path: ["deploymentIds"], message: "deployment IDs must be unique" });
    }
    const links = registration.activityLinks.map((link) => JSON.stringify([link.offeringId, link.linkId]));
    if (new Set(links).size !== links.length) {
      ctx.addIssue({ code: "custom", path: ["activityLinks"], message: "a link maps to one activity per offering" });
    }
    const offerings = new Set(registration.offerings.map((mapping) => mapping.offeringId));
    if (registration.activityLinks.some((link) => !offerings.has(link.offeringId))) {
      ctx.addIssue({ code: "custom", path: ["activityLinks"], message: "a link belongs to an offering this registration maps" });
    }
  });
/** A platform registration. */
export type PlatformRegistration = z.infer<typeof PlatformRegistration>;

/** Identifies a registration: the platform issuer and the tool's client ID there. */
export interface RegistrationKey {
  readonly issuer: string;
  readonly clientId: string;
}

/**
 * Where the broker reads registrations. Lookups are exact: an issuer that differs by a trailing
 * slash or letter case is a different issuer.
 */
export interface PlatformRegistrationStore {
  /** The registration for `key`, or `undefined` if there is none. */
  get(key: RegistrationKey): Promise<PlatformRegistration | undefined>;
  /** Every registration for `issuer`, for login requests that omit `client_id`. */
  listByIssuer(issuer: string): Promise<readonly PlatformRegistration[]>;
  /**
   * Records an activity link created by deep linking. Throws `SchoolOsError("conflict")` if the
   * offering already maps that link ID.
   */
  addActivityLink(key: RegistrationKey, link: ActivityLink): Promise<void>;
}

/** The offering an LTI context maps to, or `undefined` if the registration does not map it. */
export function offeringForContext(registration: PlatformRegistration, contextId: string): OfferingId | undefined {
  return registration.offerings.find((mapping) => mapping.contextId === contextId)?.offeringId;
}

/** The activity a link maps to inside `offeringId`, or `undefined`. */
export function activityForLink(
  registration: PlatformRegistration,
  offeringId: OfferingId,
  linkId: string,
): ActivityId | undefined {
  return registration.activityLinks.find((link) => link.offeringId === offeringId && link.linkId === linkId)?.activityId;
}
