import {
  PrincipalId,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type PrincipalKind,
  type ResourceRef,
} from "@educateos/contracts";
import {
  deploymentAllows,
  LTI_SCOPES,
  PLATFORM_LAUNCH_ROLE,
  PLATFORM_NRPS_MAX_LIMIT,
  PlatformLineItemId,
  PlatformToolId,
  platformPersonClaims,
  platformRoleFilter,
  type PlatformDeploymentId,
  type PlatformMember,
  type PlatformMembershipContainer,
  type PlatformServiceGrant,
  type PlatformServiceRefusalCode,
  type PlatformToolService,
} from "@educateos/lti";
import type { TablePlatformAgsStore } from "./platform-ags.ts";
import type { TablePlatformSubjectStore } from "./platform-launch.ts";
import type { TablePlatformToolStore } from "./platform-tools.ts";

const TOOL_PRINCIPAL_PREFIX = "prn_lti-tool-";

/**
 * The principal ID a registered tool is decided under on the `lti-service` channel: its client ID,
 * hex-encoded into the principal ID alphabet. It names no directory principal, so a tool is never
 * a person and holds no role; its authority is only what its deployments establish
 * ({@link platformToolPolicySources}).
 */
export function platformToolPrincipalId(toolId: PlatformToolId): PrincipalId {
  const body = toolId.slice("ltt_".length);
  const hex = [...new TextEncoder().encode(body)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return PrincipalId.parse(`${TOOL_PRINCIPAL_PREFIX}${hex}`);
}

/** The tool a {@link platformToolPrincipalId} names, or `undefined` if it names none. */
export function platformToolForPrincipal(principalId: string): PlatformToolId | undefined {
  if (!principalId.startsWith(TOOL_PRINCIPAL_PREFIX)) return undefined;
  const hex = principalId.slice(TOOL_PRINCIPAL_PREFIX.length);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const id = PlatformToolId.safeParse(`ltt_${new TextDecoder().decode(bytes)}`);
  return id.success ? id.data : undefined;
}

/**
 * The deployment service a tool needs for `action` on a resource of `kind`, or `undefined` if no
 * service reaches it: an offering's enrollments are its roster (NRPS); its gradebook columns are AGS
 * line items, whose approved results are read with the same service; and an official grade written
 * (`grade`) is an AGS score.
 */
function serviceFor(kind: ResourceRef["kind"], action: Action): PlatformToolService | undefined {
  switch (kind) {
    case "enrollment":
      return action === "list" ? "nrps" : undefined;
    case "gradebook":
      return "agsLineItems";
    case "official-grade":
      return action === "grade" ? "agsScores" : action === "list" ? "agsLineItems" : undefined;
    default:
      return undefined;
  }
}

/**
 * What the policy engine reads about registered tools (SCHO-179): each tool as a `service`
 * subject, active while the tool is, and the `lti-deployment` relationship an active deployment
 * of the tool establishes to an offering for the resources and actions its services reach
 * ({@link serviceFor}). A resource with no ID (an offering's roster, its gradebook columns) is
 * reached through any such deployment of the tool there; one with an ID is an AGS line item (a
 * column, or the official grades in it), reached only through the deployment that created it, so
 * `ags` must be given for AGS. Both read the stores on every decision, so a revocation applies to
 * the next one. Pass them to the district application's `policySources`.
 */
export function platformToolPolicySources(store: TablePlatformToolStore, ags?: Pick<TablePlatformAgsStore, "lineItem">) {
  return {
    subjects: [{
      async subjectFacts(principalId: PrincipalId) {
        const toolId = platformToolForPrincipal(principalId);
        const tool = toolId === undefined ? undefined : await store.tool(toolId);
        if (tool === undefined) return undefined;
        return { principalId, districtId: tool.districtId, kind: "service" as PrincipalKind, active: tool.status === "active", roles: [] };
      },
    }],
    relationships: [{
      async relationships(subject: PrincipalId, resource: ResourceRef, action?: Action) {
        const toolId = platformToolForPrincipal(subject);
        const service = action === undefined ? undefined : serviceFor(resource.kind, action);
        if (toolId === undefined || service === undefined || resource.scope.level !== "offering") return [];
        const offeringId = resource.scope.offeringId;
        let deploymentId: string | undefined;
        if (resource.id !== undefined) {
          if (resource.kind === "enrollment" || ags === undefined) return [];
          const lineItemId = PlatformLineItemId.safeParse(resource.id);
          const item = lineItemId.success ? await ags.lineItem(lineItemId.data) : undefined;
          if (item === undefined || item.toolId !== toolId || item.offeringId !== offeringId) return [];
          deploymentId = item.deploymentId;
        } else if (resource.kind === "official-grade") {
          return [];
        }
        const tool = await store.tool(toolId);
        if (tool === undefined || tool.districtId !== resource.scope.districtId) return [];
        return (await store.deployments())
          .filter((deployment) => (deploymentId === undefined || deployment.id === deploymentId) && deploymentAllows(tool, deployment, offeringId, service))
          .map((deployment) => ({ relationship: "lti-deployment" as const, grantId: deployment.id }));
      },
    }],
  };
}

/** A refused membership request, with the OAuth or HTTP refusal the tool is answered with. */
export class PlatformServiceRefused extends Error {
  override readonly name = "PlatformServiceRefused";
  readonly code: PlatformServiceRefusalCode;

  constructor(code: PlatformServiceRefusalCode) {
    super(`The LTI service call was refused: ${code}.`);
    this.code = code;
  }
}

/** What {@link LtiPlatformNrpsService} is built from. */
export interface LtiPlatformNrpsServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine, built with {@link platformToolPolicySources}. */
  readonly authorizer: Authorizer;
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly tools: TablePlatformToolStore;
  readonly subjects: TablePlatformSubjectStore;
  /** The membership URL of a deployment and offering, as launches advertise it. */
  readonly membershipsUrl: (deploymentId: PlatformDeploymentId, offeringId: OfferingId) => string;
}

/** A memberships request's query: the NRPS `role` filter and paging. */
export interface PlatformMembershipQuery {
  readonly role: string | null;
  readonly limit: string | null;
  readonly page: string | null;
}

/** One page of an offering's roster, and the URL of the next page if there is one. */
export interface PlatformMembershipPage {
  readonly container: PlatformMembershipContainer;
  readonly next?: string;
}

const MEMBERSHIP_SCOPE = LTI_SCOPES.contextMembershipReadonly;

/**
 * The LTI Platform's Names and Role Provisioning Service (NRPS 2.0, SCHO-179): a tool reads the
 * roster of one offering through one of its deployments. The call needs a token with the NRPS
 * scope, the URL's deployment must be one of the token's tool's active deployments, to that
 * offering, allowing NRPS, and the policy engine must allow the tool, as itself on the
 * `lti-service` channel, to list the offering's enrollments. Anything else is refused alike.
 *
 * The roster is the offering's active enrollments of active people, each as the person's opaque
 * subject for the tool (the `sub` of their launches, made on first use), their LIS role, and their
 * name and email only as the deployment allows each. Nothing else of the directory is read out.
 */
export class LtiPlatformNrpsService {
  readonly #options: LtiPlatformNrpsServiceOptions;

  constructor(options: LtiPlatformNrpsServiceOptions) {
    this.#options = options;
  }

  /** One page of the roster `grant`'s tool asks for through `deploymentId` in `offeringId`. */
  async memberships(
    grant: PlatformServiceGrant,
    target: { deploymentId: PlatformDeploymentId; offeringId: OfferingId },
    query: PlatformMembershipQuery,
  ): Promise<PlatformMembershipPage> {
    if (!grant.scopes.includes(MEMBERSHIP_SCOPE)) throw new PlatformServiceRefused("insufficient_scope");
    const { tool } = grant;
    const deployment = grant.deployments.find((candidate) => candidate.id === target.deploymentId);
    if (tool.districtId !== this.#options.districtId || deployment === undefined || !deploymentAllows(tool, deployment, target.offeringId, "nrps")) {
      throw new PlatformServiceRefused("forbidden");
    }
    const paging = readPaging(query);
    const role = platformRoleFilter(query.role);

    const directory = await this.#options.directory();
    const offering = directory.offerings.find((o) => o.id === target.offeringId && o.districtId === this.#options.districtId);
    const course = offering === undefined ? undefined : directory.courses.find((c) => c.id === offering.courseId);
    if (offering === undefined || course === undefined) throw new PlatformServiceRefused("forbidden");
    const caller: Caller = { principal: { principalId: platformToolPrincipalId(tool.id), districtId: this.#options.districtId }, channel: "lti-service" };
    const decision = await this.#options.authorizer.authorize({
      subject: caller.principal,
      action: "list",
      resource: {
        kind: "enrollment",
        scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
        classification: "course",
      },
      context: { channel: caller.channel },
    });
    if (decision.effect !== "allow") throw new PlatformServiceRefused("forbidden");

    const people = new Map(directory.principals.filter((p) => p.status === "active").map((p) => [p.id, p]));
    const enrolled = directory.enrollments
      .filter((e) => e.offeringId === offering.id && e.status === "active" && people.has(e.principalId))
      .map((e) => ({ enrollment: e, role: e.role === "student" ? PLATFORM_LAUNCH_ROLE.learner : PLATFORM_LAUNCH_ROLE.instructor }))
      .filter((member) => role === undefined || member.role === role)
      .toSorted((a, b) => (a.enrollment.id < b.enrollment.id ? -1 : a.enrollment.id > b.enrollment.id ? 1 : 0));
    const start = paging === undefined ? 0 : (paging.page - 1) * paging.limit;
    const page = paging === undefined ? enrolled : enrolled.slice(start, start + paging.limit);

    const members: PlatformMember[] = [];
    for (const { enrollment, role: memberRole } of page) {
      const person = people.get(enrollment.principalId)!;
      members.push({
        user_id: await this.#options.subjects.subjectFor(tool.id, person.id),
        roles: [memberRole],
        status: "Active",
        ...platformPersonClaims(person, deployment.privacy),
      });
    }
    const base = this.#options.membershipsUrl(deployment.id, offering.id);
    const url = (pageNumber?: number) => {
      const params = new URLSearchParams();
      if (query.role !== null) params.set("role", query.role);
      if (paging !== undefined) {
        params.set("limit", String(paging.limit));
        params.set("page", String(pageNumber ?? paging.page));
      }
      const search = params.toString();
      return search === "" ? base : `${base}?${search}`;
    };
    return {
      container: {
        id: url(),
        context: { id: offering.id, label: course.title, title: `${course.title}, ${offering.sectionName}` },
        members,
      },
      ...paging !== undefined && start + paging.limit < enrolled.length ? { next: url(paging.page + 1) } : {},
    };
  }
}

/**
 * The page a request asks for: none without `limit`, which returns the whole roster. `page`
 * counts from 1 and needs `limit`. Anything malformed is `invalid_request`.
 */
function readPaging(query: PlatformMembershipQuery): { limit: number; page: number } | undefined {
  if (query.limit === null) {
    if (query.page !== null) throw new PlatformServiceRefused("invalid_request");
    return undefined;
  }
  const limit = positiveInteger(query.limit);
  const page = query.page === null ? 1 : positiveInteger(query.page);
  if (limit === undefined || limit > PLATFORM_NRPS_MAX_LIMIT || page === undefined) throw new PlatformServiceRefused("invalid_request");
  return { limit, page };
}

function positiveInteger(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,8}$/.test(text)) return undefined;
  return Number(text);
}

