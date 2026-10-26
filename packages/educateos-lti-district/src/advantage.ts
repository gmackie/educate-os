import { z } from "zod";
import {
  externalIdentityKey,
  OfferingId,
  PrincipalId,
  EducateOsError,
  type Authorizer,
  type Caller,
  type DistrictId,
  type RosterProjection,
} from "@educateos/contracts";
import { validateDirectory, type AcademicStore } from "@educateos/academics";
import type { PendingIdentityLink } from "@educateos/identity";
import {
  offeringForContext,
  type GradeApprovalStore,
  type LineItem,
  type LtiContextServices,
  type NewLineItem,
  type PendingRegistrationStore,
  type PassbackResult,
} from "@educateos/lti";
import { authorizeLti, authorizeLtiOffering, districtResource } from "./authorize.ts";
import { PlatformGradeRouteInput } from "./admin.ts";
import type { ContextServicesStore, DistrictRegistrationStore } from "./stores.ts";
import type { TableToolKeyStore, ToolKeyRotation } from "./tool-keys.ts";

const HttpsIssuer = z.url({ protocol: /^https$/ }).max(2048);

/** A platform context an offering is connected to: the services a launch from it reported. */
export const PlatformContextInput = PlatformGradeRouteInput;
/** A platform context. */
export type PlatformContextInput = z.infer<typeof PlatformContextInput>;

/** A gradebook column to create in a platform context, through AGS. */
export const LineItemInput = PlatformContextInput.extend({
  label: z.string().trim().min(1).max(255),
  scoreMaximum: z.number().positive().finite().max(1_000_000),
  /** The platform resource link the column belongs to, if any. */
  resourceLinkId: z.string().min(1).max(255).optional(),
  /** An EducateOS identifier for the column, such as the assignment ID. */
  resourceId: z.string().min(1).max(255).optional(),
});
/** A line item request. */
export type LineItemInput = z.infer<typeof LineItemInput>;

/** One teacher-approved grade version to publish. The score is read from the approval, never sent. */
export const GradePublishInput = z.strictObject({
  offeringId: OfferingId,
  studentId: PrincipalId,
  column: z.string().min(1).max(2048),
  gradeVersion: z.int().positive(),
  comment: z.string().max(10_000).optional(),
});
/** A grade publish request. */
export type GradePublishInput = z.infer<typeof GradePublishInput>;

/** Which platform subject should sign in as which principal, for an administrator to approve. */
export const IdentityLinkInput = z.strictObject({
  issuer: HttpsIssuer,
  subject: z.string().min(1).max(255),
  principalId: PrincipalId,
});
/** An identity link request. */
export type IdentityLinkInput = z.infer<typeof IdentityLinkInput>;

/** One NRPS member as an administrator sees it: the platform subject and who it is linked to. */
export interface RosterMemberView {
  readonly subject: string;
  readonly status: RosterProjection["members"][number]["status"];
  /** The principal the subject's identity link names, or `null` if it is not linked. */
  readonly principalId: PrincipalId | null;
  /** The platform's role strings, verbatim. They grant nothing. */
  readonly untrustedPlatformRoles: readonly string[];
}

/** An NRPS roster read: what the platform lists, matched to identity links, and nothing written. */
export interface RosterRead {
  readonly offeringId: OfferingId;
  readonly contextId: string;
  readonly observedAt: string;
  readonly members: readonly RosterMemberView[];
}

/** What {@link LtiAdvantageService} is built from. */
export interface LtiAdvantageServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine (A02). Every method is decided by it. */
  readonly authorizer: Authorizer;
  /** The district directory's store: read on every call, written only to trust a platform issuer. */
  readonly directory: AcademicStore;
  readonly registrations: DistrictRegistrationStore;
  readonly pending: PendingRegistrationStore;
  readonly contextServices: ContextServicesStore;
  /** AGS line items (`AgsClient`). */
  readonly lineItems: { createLineItem(services: LtiContextServices, input: NewLineItem): Promise<LineItem> };
  /** NRPS rosters (`NrpsClient`). */
  readonly roster: { rosterProjection(services: LtiContextServices): Promise<RosterProjection> };
  /** The passback gate (`GradePassback`), the only path to a platform gradebook. */
  readonly passback: { publish(input: unknown): Promise<PassbackResult> };
  /** The teacher approvals the gate reads (`OfficialGradeApprovals`). */
  readonly approvals: GradeApprovalStore;
  readonly toolKeys: TableToolKeyStore;
  /** Records a pending identity link for an administrator to decide (`recordPendingIdentityLink`). */
  readonly requestIdentityLink: (link: PendingIdentityLink) => Promise<string>;
  readonly now?: () => Date;
}

/**
 * The district's LTI Advantage operations around an approved registration (SCHO-177): trusting a
 * platform's issuer, asking for a platform subject to be linked to a principal, creating AGS line
 * items, reading NRPS rosters, publishing a teacher's approved grade, and rotating the tool's keys.
 * Each call is authorized by the policy engine, as `LtiAdminService`'s are:
 *
 * - the issuer, identity links and tool keys are district configuration: `update` on the district;
 * - line items and roster reads are offering configuration: `update` on the offering;
 * - a grade is published only by the teacher who approved that exact version. The passback gate
 *   then checks everything again (route, approval, score, enrollment, ledger).
 *
 * A refusal is `forbidden`, whatever the reason; the policy audit trail records which rule decided.
 */
export class LtiAdvantageService {
  readonly #options: LtiAdvantageServiceOptions;
  readonly #now: () => Date;

  constructor(options: LtiAdvantageServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Adds a platform's issuer to the district's trusted issuers, which a registration needs before
   * it can be approved and an identity link before it can resolve. Only an issuer some pending or
   * approved registration names can be trusted here; trusting it again changes nothing.
   */
  async trustPlatformIssuer(caller: Caller, rawIssuer: unknown): Promise<readonly string[]> {
    await this.#authorizeDistrict(caller);
    const issuer = HttpsIssuer.safeParse(rawIssuer);
    if (!issuer.success) throw new EducateOsError("validation-failed", "The issuer must be an https URL.");
    const named = [...(await this.#options.registrations.list()), ...(await this.#options.pending.list())];
    if (!named.some((registration) => registration.issuer === issuer.data)) throw new EducateOsError("not-found", "No registration names that platform.");
    const { version, snapshot } = await this.#options.directory.load();
    if (snapshot.district.trustedIssuers.includes(issuer.data)) return snapshot.district.trustedIssuers;
    const next = validateDirectory({ ...snapshot, district: { ...snapshot.district, trustedIssuers: [...snapshot.district.trustedIssuers, issuer.data] } });
    await this.#options.directory.commit(next, version);
    return next.district.trustedIssuers;
  }

  /**
   * Asks for a platform subject to sign in as a principal: records a pending identity link, which a
   * district administrator then approves or rejects through the identity requests. The platform must
   * be registered. Returns the request's ID.
   */
  async requestIdentityLink(caller: Caller, rawInput: unknown): Promise<string> {
    await this.#authorizeDistrict(caller);
    const input = IdentityLinkInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The identity link request is malformed.");
    if (!(await this.#options.registrations.list()).some((registration) => registration.issuer === input.data.issuer)) {
      throw new EducateOsError("not-found", "No registration names that platform.");
    }
    const { districtId } = this.#options;
    return this.#options.requestIdentityLink({
      districtId,
      principalId: input.data.principalId,
      identity: { districtId, issuer: input.data.issuer, subject: input.data.subject },
      credential: "person",
      requestedAt: this.#now().toISOString(),
    });
  }

  /** Creates a gradebook column in a connected platform context, through AGS. */
  async createLineItem(caller: Caller, rawInput: unknown): Promise<LineItem> {
    const input = LineItemInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The line item is malformed.");
    const { label, scoreMaximum, resourceLinkId, resourceId } = input.data;
    const services = await this.#services(caller, input.data, "ags");
    return this.#options.lineItems.createLineItem(services, {
      label,
      scoreMaximum,
      ...(resourceLinkId === undefined ? {} : { resourceLinkId }),
      ...(resourceId === undefined ? {} : { resourceId }),
    });
  }

  /**
   * Reads a connected platform context's roster through NRPS, matched to identity links. Nothing is
   * written: applying a roster is `LtiRosterSync`'s, and only where the platform owns enrollments.
   */
  async readRoster(caller: Caller, rawInput: unknown): Promise<RosterRead> {
    const input = PlatformContextInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The platform context is malformed.");
    const services = await this.#services(caller, input.data, "nrps");
    const projection = await this.#options.roster.rosterProjection(services);
    const linked = new Map<string, PrincipalId>();
    for (const principal of (await this.#options.directory.load()).snapshot.principals) {
      for (const identity of principal.externalIdentities) linked.set(externalIdentityKey(identity), principal.id);
    }
    return {
      offeringId: projection.offeringId,
      contextId: input.data.contextId,
      observedAt: projection.observedAt,
      members: projection.members.map((member) => ({
        subject: member.identity.subject,
        status: member.status,
        principalId: linked.get(externalIdentityKey(member.identity)) ?? null,
        untrustedPlatformRoles: member.untrustedPlatformRoles,
      })),
    };
  }

  /**
   * Publishes one teacher-approved grade version to the offering's platform gradebook. Only the
   * teacher who approved that version may publish it, and the score sent is the approved one.
   */
  async publishGrade(caller: Caller, rawInput: unknown): Promise<PassbackResult> {
    const input = GradePublishInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The grade to publish is malformed.");
    const approval = await this.#options.approvals.find(input.data);
    if (approval === undefined) throw new EducateOsError("policy-violation", "This grade has not been approved by the offering's teacher.");
    if (approval.approverId !== caller.principal.principalId || caller.principal.districtId !== this.#options.districtId) throw forbidden();
    return this.#options.passback.publish({ ...input.data, scoreGiven: approval.scoreGiven, scoreMaximum: approval.scoreMaximum });
  }

  /** The tool's published key IDs, signing key first. */
  async toolKeyIds(caller: Caller): Promise<readonly string[]> {
    await authorizeLti(this.#options.authorizer, caller, "read", districtResource(this.#options.districtId), forbidden);
    const set = await this.#options.toolKeys.keySet();
    return [set.signing.kid, ...set.retired.map((key) => key.kid)];
  }

  /** Rotates the tool's signing key; the previous key stays published. */
  async rotateToolKeys(caller: Caller): Promise<ToolKeyRotation> {
    await this.#authorizeDistrict(caller);
    return this.#options.toolKeys.rotate();
  }

  async #authorizeDistrict(caller: Caller): Promise<void> {
    await authorizeLti(this.#options.authorizer, caller, "update", districtResource(this.#options.districtId), forbidden);
  }

  /** The recorded services of a context the registration maps to the offering, offering `service`. */
  async #services(caller: Caller, input: PlatformContextInput, service: "ags" | "nrps"): Promise<LtiContextServices> {
    const { authorizer, districtId } = this.#options;
    const directory = (await this.#options.directory.load()).snapshot;
    const offeringId = await authorizeLtiOffering({ authorizer, districtId, directory }, caller, "update", input.offeringId, forbidden);
    const { issuer, clientId, contextId } = input;
    const registration = await this.#options.registrations.get({ issuer, clientId });
    if (registration === undefined || offeringForContext(registration, contextId) !== offeringId) {
      throw new EducateOsError("not-found", "That course is not connected to this offering.");
    }
    const recorded = (await this.#options.contextServices.list(offeringId)).find(
      ({ services }) => services.registration.issuer === issuer && services.registration.clientId === clientId && services.contextId === contextId,
    );
    if (recorded?.services[service] === undefined) {
      throw new EducateOsError("conflict", `No launch from that course has reported its ${service === "ags" ? "gradebook" : "roster"} service yet.`);
    }
    return recorded.services;
  }
}

const forbidden = (): EducateOsError => new EducateOsError("forbidden", "You cannot manage this course connection.");
