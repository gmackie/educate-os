import { z } from "zod";
import {
  OfferingId,
  EducateOsError,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type ResourceRef,
} from "@educateos/contracts";
import { AssignmentId, type AssessmentRecordStore } from "@educateos/assessment";
import {
  approvedRegistration,
  offeringForContext,
  PendingRegistrationId,
  RegistrationApproval,
  type DynamicRegistration,
  type LtiGradeRoute,
  type PendingPlatformRegistration,
  type PendingRegistrationStore,
  type PlatformRegistration,
} from "@educateos/lti";
import type {
  ConfigurableGradeRouteStore,
  ContextServicesStore,
  DistrictRegistrationStore,
  RecordedContextServices,
} from "./stores.ts";
import type { GradeColumnStore } from "./columns.ts";

/** Which recorded platform context an offering's grades should go to. */
export const PlatformGradeRouteInput = z.strictObject({
  offeringId: OfferingId,
  issuer: z.url({ protocol: /^https$/ }),
  clientId: z.string().min(1).max(255),
  contextId: z.string().min(1).max(255),
});
/** A platform grade route request. */
export type PlatformGradeRouteInput = z.infer<typeof PlatformGradeRouteInput>;

/** Which assignment an offering's gradebook column carries. */
export const GradeColumnInput = z.strictObject({
  offeringId: OfferingId,
  column: z.string().min(1).max(2048),
  assignmentId: AssignmentId,
});
/** A grade column binding request. */
export type GradeColumnInput = z.infer<typeof GradeColumnInput>;

/** What {@link LtiAdminService} is built from. */
export interface LtiAdminServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine (A02). Every method is decided by it. */
  readonly authorizer: Authorizer;
  /** The district directory, read on every call. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly dynamicRegistration: DynamicRegistration;
  readonly pending: PendingRegistrationStore;
  readonly registrations: DistrictRegistrationStore;
  readonly contextServices: ContextServicesStore;
  readonly gradeRoutes: ConfigurableGradeRouteStore;
  readonly gradeColumns: GradeColumnStore;
  readonly assessments: AssessmentRecordStore;
}

/**
 * The district administrator's LTI operations: inviting a platform to register, approving or
 * rejecting what registered (setting its offering mappings), and choosing where each offering's
 * official grades go. Each call is authorized by the policy engine from the caller's directory
 * roles:
 *
 * - registrations are district configuration, so they need `update` on the district (by the
 *   default rules, a district admin), and listing them needs `read` there;
 * - a grade route or column is offering configuration, so it needs `update` on the offering (a
 *   district admin, or a school admin for their school), and so does listing the services a route
 *   can be built from: anyone in the offering may `read` it, but this is its configuration.
 *
 * A refusal is `forbidden`, whatever the reason; the policy audit trail records which rule decided.
 */
export class LtiAdminService {
  readonly #options: LtiAdminServiceOptions;

  constructor(options: LtiAdminServiceOptions) {
    this.#options = options;
  }

  /** Issues a single-use registration URL for a platform administrator to paste into their LMS. */
  async inviteRegistration(caller: Caller): Promise<{ url: string; expiresAt: string }> {
    await this.#authorize(caller, "update", this.#district());
    return this.#options.dynamicRegistration.issueInvitation(this.#options.districtId, caller.principal.principalId);
  }

  /** Every registration waiting for approval. */
  async listPendingRegistrations(caller: Caller): Promise<readonly PendingPlatformRegistration[]> {
    await this.#authorize(caller, "read", this.#district());
    return this.#options.pending.list();
  }

  /** Every approved registration. */
  async listRegistrations(caller: Caller): Promise<readonly PlatformRegistration[]> {
    await this.#authorize(caller, "read", this.#district());
    return this.#options.registrations.list();
  }

  /**
   * Approves a pending registration with its provider name and offering mappings. The registration
   * is checked against the directory (trusted issuer, offerings and activities that exist) before
   * it is stored, and only then can the platform launch.
   */
  async approveRegistration(caller: Caller, rawId: unknown, rawApproval: unknown): Promise<PlatformRegistration> {
    await this.#authorize(caller, "update", this.#district());
    const id = PendingRegistrationId.safeParse(rawId);
    const approval = RegistrationApproval.safeParse(rawApproval);
    if (!id.success || !approval.success) throw new EducateOsError("validation-failed", "The approval is malformed.");
    const pending = await this.#options.pending.get(id.data);
    if (pending === undefined || pending.districtId !== this.#options.districtId) throw new EducateOsError("not-found", "No such pending registration.");
    const registration = approvedRegistration(pending, approval.data);
    await this.#options.registrations.save(registration);
    await this.#options.pending.remove(pending.id);
    return registration;
  }

  /** Discards a pending registration. */
  async rejectRegistration(caller: Caller, rawId: unknown): Promise<void> {
    await this.#authorize(caller, "update", this.#district());
    const id = PendingRegistrationId.safeParse(rawId);
    if (!id.success || !(await this.#options.pending.remove(id.data))) throw new EducateOsError("not-found", "No such pending registration.");
  }

  /** The platform contexts launches have reported for an offering, with their services. */
  async listContextServices(caller: Caller, rawOfferingId: unknown): Promise<readonly RecordedContextServices[]> {
    const offeringId = await this.#authorizeOffering(caller, "update", rawOfferingId);
    return this.#options.contextServices.list(offeringId);
  }

  /**
   * Makes a platform context's gradebook the offering's source of record for official grades,
   * reached through AGS with the services a launch from that context reported. The registration
   * must map the context to the offering, and the context must offer AGS.
   */
  async routeGradesToPlatform(caller: Caller, rawInput: unknown): Promise<LtiGradeRoute> {
    const input = PlatformGradeRouteInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The grade route is malformed.");
    const { offeringId, issuer, clientId, contextId } = input.data;
    await this.#authorizeOffering(caller, "update", offeringId);
    const registration = await this.#options.registrations.get({ issuer, clientId });
    if (registration === undefined || offeringForContext(registration, contextId) !== offeringId) {
      throw new EducateOsError("not-found", "That course is not connected to this offering.");
    }
    const recorded = (await this.#options.contextServices.list(offeringId)).find(
      ({ services }) => services.registration.issuer === issuer && services.registration.clientId === clientId && services.contextId === contextId,
    );
    if (recorded?.services.ags === undefined) {
      throw new EducateOsError("conflict", "No launch from that course has reported a gradebook service yet.");
    }
    const route: LtiGradeRoute = { offeringId, authority: `lms:${registration.provider}`, via: "lti-ags", services: recorded.services };
    await this.#options.gradeRoutes.setRoute(route);
    return route;
  }

  /** Makes EducateOS the offering's source of record: nothing is sent to any LMS. */
  async keepGradesLocal(caller: Caller, rawOfferingId: unknown): Promise<void> {
    const offeringId = await this.#authorizeOffering(caller, "update", rawOfferingId);
    await this.#options.gradeRoutes.setRoute({ offeringId, authority: "local" });
  }

  /** Binds a gradebook column to the offering's assignment whose official grades it carries. */
  async bindGradeColumn(caller: Caller, rawInput: unknown): Promise<void> {
    const input = GradeColumnInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The column binding is malformed.");
    await this.#authorizeOffering(caller, "update", input.data.offeringId);
    const { state } = await this.#options.assessments.load();
    const assignment = state.assignments.find((a) => a.id === input.data.assignmentId);
    if (assignment === undefined || assignment.offeringId !== input.data.offeringId || assignment.districtId !== this.#options.districtId) {
      throw new EducateOsError("not-found", "No such assignment in that offering.");
    }
    await this.#options.gradeColumns.bind(input.data);
  }

  #district(): ResourceRef {
    const { districtId } = this.#options;
    return { kind: "district", id: districtId, scope: { level: "district", districtId }, classification: "district-internal" };
  }

  async #authorizeOffering(caller: Caller, action: Action, rawOfferingId: unknown): Promise<OfferingId> {
    const id = OfferingId.safeParse(rawOfferingId);
    const offering = id.success ? (await this.#options.directory()).offerings.find((o) => o.id === id.data) : undefined;
    // An unknown offering is refused exactly as a forbidden one is, so the answer reveals nothing.
    if (offering === undefined || offering.districtId !== this.#options.districtId) throw forbidden();
    await this.#authorize(caller, action, {
      kind: "offering",
      id: offering.id,
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      classification: "district-internal",
    });
    return offering.id;
  }

  async #authorize(caller: Caller, action: Action, resource: ResourceRef): Promise<void> {
    const decision = await this.#options.authorizer.authorize({
      subject: caller.principal,
      action,
      resource,
      context: { channel: caller.channel },
    });
    if (decision.effect !== "allow") throw forbidden();
  }
}

const forbidden = (): EducateOsError => new EducateOsError("forbidden", "You cannot manage this course connection.");
