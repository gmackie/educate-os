// Extracted from PlayTrek `packages/lti/src/nrps/client.ts` at commit 7258e4347, then rewritten
// for SchoolOS. PlayTrek defaulted malformed fields with `.catch` (a member with no `user_id` became
// `""`, an unknown status became `Active`), followed `rel="next"` to any host with the bearer token
// and without a page limit, and decided `isInstructor` by substring-matching role strings. Here every
// member is validated or the roster is refused, paging stays on the membership URL's origin and is
// capped, names and emails are never read, and roles are carried only as untrusted metadata.
import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { offeringForContext, type PlatformRegistrationStore } from "./registration.ts";
import { RosterProjection, type ProjectedMemberStatus } from "./roster-projection.ts";
import {
  LTI_SCOPES,
  nextPageUrl,
  readJson,
  serviceOrigin,
  type LtiContextServices,
  type LtiServiceClient,
} from "./service-client.ts";
import type { Clock } from "./stores.ts";

/** The NRPS 2.0 membership container media type. */
export const NRPS_MEMBERSHIP_MEDIA_TYPE = "application/vnd.ims.lti-nrps.v2.membershipcontainer+json";

/** How much of a roster the client reads before refusing it. */
export interface NrpsLimits {
  /** The most members a context may have. Default 10,000. */
  readonly maxMembers: number;
  /** The most pages followed. Default 200. */
  readonly maxPages: number;
}

const DEFAULT_LIMITS: NrpsLimits = { maxMembers: 10_000, maxPages: 200 };

/**
 * One NRPS member. A stripping `z.object`: Canvas and others send `name`, `email`, `picture` and
 * `lis_person_sourcedid` depending on the tool's privacy level, and those are dropped here unread.
 * What is read is required and checked. An absent `status` means `Active` (NRPS 2.0 §2.2); any
 * other value is an error rather than a guess.
 */
const NrpsMember = z.object({
  user_id: z.string().min(1).max(255),
  roles: z.array(z.string().max(512)).max(64),
  status: z.enum(["Active", "Inactive", "Deleted"]).optional(),
});

const NrpsContainer = z.object({
  context: z.object({ id: z.string().min(1).max(255) }),
  members: z.array(z.unknown()),
});

const STATUS: Record<"Active" | "Inactive" | "Deleted", ProjectedMemberStatus> = {
  Active: "active",
  Inactive: "inactive",
  Deleted: "deleted",
};

/** What {@link NrpsClient} is built from. */
export interface NrpsClientOptions {
  readonly services: LtiServiceClient;
  readonly registrations: PlatformRegistrationStore;
  readonly limits?: Partial<NrpsLimits>;
  readonly now?: Clock;
}

/**
 * Reads a context's membership through NRPS 2.0 and projects it into a {@link RosterProjection}.
 * It never writes the directory.
 */
export class NrpsClient {
  readonly #services: LtiServiceClient;
  readonly #registrations: PlatformRegistrationStore;
  readonly #limits: NrpsLimits;
  readonly #now: Clock;

  constructor(options: NrpsClientOptions) {
    this.#services = options.services;
    this.#registrations = options.registrations;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
  }

  /**
   * The roster of the context `services` describes, for the offering the registration maps that
   * context to. Refuses (`forbidden`) a context the registration does not map, and
   * (`validation-failed`) a malformed page, a container for another context, a duplicated member,
   * a paging loop, or a roster over the limits; a partial roster is never returned.
   */
  async rosterProjection(services: LtiContextServices): Promise<RosterProjection> {
    const registration = await this.#registrations.get(services.registration);
    if (registration === undefined) throw new SchoolOsError("not-found", "No such LTI registration.");
    const offeringId = offeringForContext(registration, services.contextId);
    if (offeringId === undefined) throw new SchoolOsError("forbidden", "This course is not connected to a SchoolOS offering.");
    if (services.nrps === undefined) throw new SchoolOsError("conflict", "The platform offers no roster service in this course.");

    const origin = serviceOrigin(services.nrps.membershipsUrl);
    const scopes = [LTI_SCOPES.contextMembershipReadonly];
    const members = new Map<string, { status: ProjectedMemberStatus; roles: string[] }>();
    const visited = new Set<string>();
    let url: string | undefined = services.nrps.membershipsUrl;
    while (url !== undefined) {
      if (visited.has(url)) throw invalid("The roster's pages link back to an earlier page.");
      if (visited.size >= this.#limits.maxPages) throw invalid("The roster has more pages than SchoolOS reads.");
      visited.add(url);

      const response = await this.#services.call(registration, scopes, origin, url, { method: "GET", accept: NRPS_MEMBERSHIP_MEDIA_TYPE });
      if (!response.ok) throw new SchoolOsError("unavailable", `The platform refused the roster request (${response.status}).`);
      let body: unknown;
      try {
        body = await readJson(response);
      } catch {
        throw invalid("The roster page is not readable JSON.");
      }
      const container = NrpsContainer.safeParse(body);
      if (!container.success) throw invalid("The roster page is malformed.");
      if (container.data.context.id !== services.contextId) throw invalid("The roster belongs to another course.");

      for (const candidate of container.data.members) {
        const member = NrpsMember.safeParse(candidate);
        if (!member.success) throw invalid("A roster member is malformed.");
        if (members.has(member.data.user_id)) throw invalid("The roster lists a member twice.");
        if (members.size >= this.#limits.maxMembers) throw invalid("The roster has more members than SchoolOS reads.");
        members.set(member.data.user_id, { status: STATUS[member.data.status ?? "Active"], roles: member.data.roles });
      }
      url = nextPageUrl(response.headers.get("link"), url);
    }

    return RosterProjection.parse({
      districtId: registration.districtId,
      offeringId,
      source: { kind: "lti-nrps", issuer: registration.issuer, clientId: registration.clientId, contextId: services.contextId },
      observedAt: new Date(this.#now()).toISOString(),
      members: [...members].map(([subject, member]) => ({
        identity: { districtId: registration.districtId, issuer: registration.issuer, subject },
        status: member.status,
        untrustedPlatformRoles: member.roles,
      })),
    });
  }
}

const invalid = (message: string): SchoolOsError => new SchoolOsError("validation-failed", message);
