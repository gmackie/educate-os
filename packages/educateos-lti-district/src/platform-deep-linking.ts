import {
  EducateOsError,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type ResourceRef,
} from "@educateos/contracts";
import {
  deploymentAllows,
  newPlatformResourceLinkId,
  PlatformDeepLinkingError,
  PlatformDeploymentId,
  PlatformResourceLink,
  sha256Base64Url,
  verifyPlatformDeepLinkingResponse,
  type Clock,
  type PlatformDeepLinkFlow,
  type PlatformResourceLinkId,
  type PlatformToolId,
  type SingleUseStore,
} from "@educateos/lti";
import { authorizeLti, authorizeLtiOffering } from "./authorize.ts";
import type { TablePlatformToolStore } from "./platform-tools.ts";
import { LtiStoredRecordError } from "./stores.ts";
import { tupleKey, type RecordTable } from "./table.ts";

/** The collections the LTI Platform's Deep Linking keeps its state in (SCHO-179). */
export const PLATFORM_DEEP_LINKING_COLLECTIONS = {
  /** Single-use deep linking flows, keyed by the ID in their return URL. */
  flows: "lti.platform-deep-link-flow",
  /** The response `nonce`s already used, per tool, each until its response expires. */
  nonces: "lti.platform-deep-link-nonce",
  /** The resource links teachers added, keyed by ID. */
  resourceLinks: "lti.platform-resource-link",
} as const;

/**
 * The resource an added resource link is decided as: a `teacher-only` activity of the offering,
 * which is what a draft is. Creating one is `create` on the offering's activities; launching one is
 * `read` of it, which students are refused.
 */
export function draftActivityResource(directory: DistrictDirectorySnapshot, offeringId: OfferingId, id?: PlatformResourceLinkId): ResourceRef {
  const offering = directory.offerings.find((o) => o.id === offeringId);
  if (offering === undefined) throw new EducateOsError("forbidden", "That offering is not in this district.");
  return {
    kind: "activity",
    ...id === undefined ? {} : { id },
    scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId },
    classification: "teacher-only",
  };
}

/**
 * The resource links teachers added by deep linking, and the response nonces already used, over
 * the district's record table. A nonce is checked and recorded in one atomic step, and every link of
 * one response is written in one step, so a response creates all of its drafts or none.
 */
export class TablePlatformResourceLinkStore {
  readonly #table: RecordTable;
  readonly #now: Clock;

  constructor(table: RecordTable, now: Clock = Date.now) {
    this.#table = table;
    this.#now = now;
  }

  /** Records the tool's response `nonce` as used until `expiresAt`. `false` if it already was. */
  async claimNonce(toolId: PlatformToolId, nonce: string, expiresAt: number): Promise<boolean> {
    const { nonces } = PLATFORM_DEEP_LINKING_COLLECTIONS;
    const key = tupleKey(toolId, nonce);
    return this.#table.atomically(() => {
      this.#table.purgeExpired(nonces, this.#now());
      if (this.#table.get(nonces, key) !== undefined) return false;
      this.#table.put(nonces, key, {}, expiresAt);
      return true;
    });
  }

  /** Stores every link, in one step. */
  async putLinks(links: readonly PlatformResourceLink[]): Promise<void> {
    const parsed = links.map((link) => PlatformResourceLink.parse(link));
    this.#table.atomically(() => {
      for (const link of parsed) this.#table.put(PLATFORM_DEEP_LINKING_COLLECTIONS.resourceLinks, link.id, link);
    });
  }

  /** The link `id`, if there is one. */
  async link(id: PlatformResourceLinkId): Promise<PlatformResourceLink | undefined> {
    const row = this.#table.get(PLATFORM_DEEP_LINKING_COLLECTIONS.resourceLinks, id);
    return row === undefined ? undefined : this.#read(row.value);
  }

  /** The links added to `offeringId`, oldest first, and those added together in the tool's order. */
  async links(offeringId: OfferingId): Promise<PlatformResourceLink[]> {
    return this.#table.list(PLATFORM_DEEP_LINKING_COLLECTIONS.resourceLinks)
      .map(({ row }) => this.#read(row.value))
      .filter((link) => link.offeringId === offeringId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.position - b.position);
  }

  #read(value: unknown): PlatformResourceLink {
    const parsed = PlatformResourceLink.safeParse(value);
    if (!parsed.success) throw new LtiStoredRecordError(`a ${PLATFORM_DEEP_LINKING_COLLECTIONS.resourceLinks} record does not match its schema`);
    return parsed.data;
  }
}

/** What {@link LtiPlatformDeepLinkingService} is built from. */
export interface LtiPlatformDeepLinkingServiceOptions {
  readonly districtId: DistrictId;
  /** The platform's issuer: the only `aud` a response may carry. */
  readonly issuer: string;
  /** The district's policy engine. Each draft is created as the teacher who started the flow. */
  readonly authorizer: Authorizer;
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly tools: TablePlatformToolStore;
  readonly flows: SingleUseStore<PlatformDeepLinkFlow>;
  readonly resourceLinks: TablePlatformResourceLinkStore;
  /** The tools' published keys (`PlatformJwksCache.getKey`). */
  readonly keys: { getKey(jwksUrl: string, kid: string): Promise<CryptoKey> };
  readonly now?: Clock;
}

/** What one deep linking response came to. */
export interface ReceivedDeepLinkingResponse {
  readonly toolId: PlatformToolId;
  /** The draft resource links it created, in the order the tool returned them. */
  readonly created: readonly PlatformResourceLink[];
  /** How many content items of other types were dropped. */
  readonly ignored: number;
}

/** A resource link as a teacher sees it, listing an offering's. */
export type PlatformResourceLinkView = Pick<PlatformResourceLink, "id" | "deploymentId" | "toolId" | "title" | "text" | "url" | "status" | "createdAt">;

const refused = () => new EducateOsError("forbidden", "That content cannot be added.");

/**
 * The receiving end of the LTI Platform's Deep Linking (SCHO-179): the tool's
 * `LtiDeepLinkingResponse`, posted by the teacher's browser to the return URL of the flow they
 * started (`LtiPlatformLaunchService.startDeepLinking`). The flow is used up by the first post,
 * valid or not, and must be bound to that browser; the tool and deployment must still allow deep
 * linking in the offering; the response must verify against the tool's keys and the flow
 * (`verifyPlatformDeepLinkingResponse`), with a `nonce` the tool has not used before; and the
 * teacher must still be an active person the policy engine allows to `create` a draft activity in
 * the offering. Only then is each resource link stored, as a draft of the offering, all at once.
 * The drafts are the teacher's action, approved by their browser: the tool's authority plays no
 * part. Nothing else in the response (line items, custom parameters, other item types) is kept.
 */
export class LtiPlatformDeepLinkingService {
  readonly #options: LtiPlatformDeepLinkingServiceOptions;
  readonly #now: Clock;

  constructor(options: LtiPlatformDeepLinkingServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Receives the response `jwt` for the flow `flowId`, from the browser that holds `binding`.
   * A refusal is `forbidden` (a {@link PlatformDeepLinkingError} says why, for the log), with
   * nothing created.
   */
  async receive(flowId: string, jwt: string, binding: string | undefined): Promise<ReceivedDeepLinkingResponse> {
    const flow = flowId === "" || flowId.length > 255 ? undefined : await this.#options.flows.take(flowId);
    if (flow === undefined) throw new PlatformDeepLinkingError("unknown-flow");
    if (binding === undefined || (await sha256Base64Url(binding)) !== flow.bindingHash) throw new PlatformDeepLinkingError("binding");
    if (flow.districtId !== this.#options.districtId) throw new PlatformDeepLinkingError("district");

    const tool = await this.#options.tools.tool(flow.toolId);
    const deployment = await this.#options.tools.deployment(flow.deploymentId);
    if (tool === undefined || deployment === undefined || !deploymentAllows(tool, deployment, flow.offeringId, "deepLinking")) {
      throw new PlatformDeepLinkingError("deployment-revoked");
    }
    const response = await verifyPlatformDeepLinkingResponse(jwt, {
      tool,
      deploymentId: deployment.id,
      issuer: this.#options.issuer,
      data: flow.data,
      nowMs: this.#now(),
      getKey: (jwksUrl, kid) => this.#options.keys.getKey(jwksUrl, kid),
    });
    if (!(await this.#options.resourceLinks.claimNonce(tool.id, response.nonce, response.expiresAt))) throw new PlatformDeepLinkingError("nonce-replayed");

    const directory = await this.#options.directory();
    const teacher = directory.principals.find((p) => p.id === flow.principalId);
    if (teacher === undefined || teacher.status !== "active") throw new PlatformDeepLinkingError("teacher-inactive");
    const subject = { principalId: flow.principalId, districtId: this.#options.districtId };
    await authorizeLti(this.#options.authorizer, { principal: subject, channel: "http" }, "create", draftActivityResource(directory, flow.offeringId), () => new PlatformDeepLinkingError("policy"));

    const createdAt = new Date(this.#now()).toISOString();
    const created = response.items.map((item, position) => PlatformResourceLink.parse({
      id: newPlatformResourceLinkId(),
      districtId: this.#options.districtId,
      toolId: tool.id,
      deploymentId: deployment.id,
      offeringId: flow.offeringId,
      ...item,
      status: "draft",
      position,
      createdBy: flow.principalId,
      createdAt,
    }));
    await this.#options.resourceLinks.putLinks(created);
    return { toolId: tool.id, created, ignored: response.ignored };
  }

  /**
   * The resource links added to the offering `rawOfferingId` that the caller may `read`: for a
   * teacher, every draft; for a student, none, since a draft is staff material. Optionally only
   * those of the deployment `deploymentId`.
   */
  async list(caller: Caller, rawOfferingId: unknown, rawDeploymentId?: unknown): Promise<PlatformResourceLinkView[]> {
    const directory = await this.#options.directory();
    const offeringId = await authorizeLtiOffering(
      { authorizer: this.#options.authorizer, districtId: this.#options.districtId, directory },
      caller,
      "read",
      rawOfferingId,
      refused,
    );
    const deploymentId = rawDeploymentId === undefined ? undefined : PlatformDeploymentId.safeParse(rawDeploymentId);
    if (deploymentId !== undefined && !deploymentId.success) throw new EducateOsError("validation-failed", "That is not a deployment ID.");
    const visible: PlatformResourceLinkView[] = [];
    for (const link of await this.#options.resourceLinks.links(offeringId)) {
      if (link.districtId !== this.#options.districtId || (deploymentId !== undefined && link.deploymentId !== deploymentId.data)) continue;
      const decision = await this.#options.authorizer.authorize({
        subject: caller.principal,
        action: "read",
        resource: draftActivityResource(directory, offeringId, link.id),
        context: { channel: caller.channel },
      });
      if (decision.effect !== "allow") continue;
      const { id, deploymentId: linkDeployment, toolId, title, text, url, status, createdAt } = link;
      visible.push({ id, deploymentId: linkDeployment, toolId, title, ...text === undefined ? {} : { text }, ...url === undefined ? {} : { url }, status, createdAt });
    }
    return visible;
  }
}
