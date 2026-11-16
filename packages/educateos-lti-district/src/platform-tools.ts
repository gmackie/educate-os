import { z } from "zod";
import {
  EducateOsError,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
} from "@educateos/contracts";
import {
  newPlatformDeploymentId,
  newPlatformToolId,
  PlatformDeployment,
  PlatformDeploymentChange,
  PlatformDeploymentId,
  PlatformDeploymentInput,
  PlatformTool,
  PlatformToolId,
  PlatformToolInput,
  type Clock,
} from "@educateos/lti";
import { authorizeLti, districtResource } from "./authorize.ts";
import { LtiStoredRecordError } from "./stores.ts";
import type { RecordTable } from "./table.ts";

/** The collections the LTI Platform's tools and deployments are kept in (SCHO-179). */
export const PLATFORM_TOOL_COLLECTIONS = {
  tools: "lti.platform-tool",
  deployments: "lti.platform-deployment",
} as const;

function read<T>(schema: z.ZodType<T>, value: unknown, collection: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LtiStoredRecordError(`a ${collection} record does not match its schema`);
  return parsed.data;
}

/**
 * The district's registered third-party tools and their deployments, over its record table. Each
 * write reads, decides and writes in one atomic step: a deployment is stored only while its tool
 * is active, and revoking a tool revokes every deployment of it in the same step, so no launch can
 * slip through a half-revoked tool. Nothing is deleted; a revoked record stays as the audit of what
 * the tool was allowed.
 */
export class TablePlatformToolStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  /** Stores a newly registered tool. */
  async addTool(input: PlatformTool): Promise<void> {
    const tool = PlatformTool.parse(input);
    this.#table.atomically(() => {
      if (this.#table.get(PLATFORM_TOOL_COLLECTIONS.tools, tool.id) !== undefined) throw new EducateOsError("conflict", "That tool already exists.");
      this.#table.put(PLATFORM_TOOL_COLLECTIONS.tools, tool.id, tool);
    });
  }

  /** The tool with `id` (its client ID), active or revoked. */
  async tool(id: PlatformToolId): Promise<PlatformTool | undefined> {
    return this.#tool(id);
  }

  /** Every registered tool, active and revoked. */
  async tools(): Promise<readonly PlatformTool[]> {
    return this.#table.list(PLATFORM_TOOL_COLLECTIONS.tools).map(({ row }) => read(PlatformTool, row.value, PLATFORM_TOOL_COLLECTIONS.tools));
  }

  /**
   * Revokes the tool and every deployment of it, in one step. Returns the revoked tool, or
   * `undefined` if there is no such tool.
   */
  async revokeTool(id: PlatformToolId, by: PlatformTool["updatedBy"], at: string): Promise<PlatformTool | undefined> {
    return this.#table.atomically(() => {
      const tool = this.#tool(id);
      if (tool === undefined) return undefined;
      const revoked = PlatformTool.parse({ ...tool, status: "revoked", updatedBy: by, updatedAt: at });
      this.#table.put(PLATFORM_TOOL_COLLECTIONS.tools, id, revoked);
      for (const deployment of this.#deployments()) {
        if (deployment.toolId === id && deployment.status === "active") {
          this.#table.put(PLATFORM_TOOL_COLLECTIONS.deployments, deployment.id, { ...deployment, status: "revoked", updatedBy: by, updatedAt: at });
        }
      }
      return revoked;
    });
  }

  /** Stores a new deployment, or a changed one, while its tool is active. */
  async putDeployment(input: PlatformDeployment): Promise<void> {
    const deployment = PlatformDeployment.parse(input);
    this.#table.atomically(() => {
      const tool = this.#tool(deployment.toolId);
      if (tool === undefined || tool.districtId !== deployment.districtId) throw new EducateOsError("not-found", "No such tool.");
      const existing = this.#deployment(deployment.id);
      if (existing !== undefined && existing.toolId !== deployment.toolId) throw new EducateOsError("conflict", "A deployment cannot move to another tool.");
      // A revoked deployment stays revoked, and a revoked tool gets no new or changed deployment;
      // revoking one, though, is always allowed.
      if (deployment.status === "active" && (tool.status !== "active" || existing?.status === "revoked")) {
        throw new EducateOsError("conflict", "That tool or deployment is revoked.");
      }
      this.#table.put(PLATFORM_TOOL_COLLECTIONS.deployments, deployment.id, deployment);
    });
  }

  /** The deployment with `id`, active or revoked. */
  async deployment(id: PlatformDeploymentId): Promise<PlatformDeployment | undefined> {
    return this.#deployment(id);
  }

  /** Every deployment, active and revoked. */
  async deployments(): Promise<readonly PlatformDeployment[]> {
    return this.#deployments();
  }

  #tool(id: string): PlatformTool | undefined {
    const row = this.#table.get(PLATFORM_TOOL_COLLECTIONS.tools, id);
    return row === undefined ? undefined : read(PlatformTool, row.value, PLATFORM_TOOL_COLLECTIONS.tools);
  }

  #deployment(id: string): PlatformDeployment | undefined {
    const row = this.#table.get(PLATFORM_TOOL_COLLECTIONS.deployments, id);
    return row === undefined ? undefined : read(PlatformDeployment, row.value, PLATFORM_TOOL_COLLECTIONS.deployments);
  }

  #deployments(): PlatformDeployment[] {
    return this.#table.list(PLATFORM_TOOL_COLLECTIONS.deployments).map(({ row }) => read(PlatformDeployment, row.value, PLATFORM_TOOL_COLLECTIONS.deployments));
  }
}

/** What {@link LtiPlatformToolService} is built from. */
export interface LtiPlatformToolServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine (A02). Every call is decided by it. */
  readonly authorizer: Authorizer;
  /** The district directory, read on every call that names offerings. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly store: TablePlatformToolStore;
  readonly now?: Clock;
}

const forbidden = () => new EducateOsError("forbidden", "You may not manage this district's LTI tools.");

/**
 * A district administrator's management of the third-party tools EducateOS hosts as an LTI
 * Platform (SCHO-179): registering a tool, deploying it to specific offerings with the services
 * and personal data each deployment may use, changing or revoking a deployment, and revoking a
 * tool. A tool is district configuration, so every call needs `update` on the district (`read` to
 * list), which by the default rules only a district admin has; the policy audit trail records each
 * decision, and every record keeps who last changed it and when.
 *
 * A refusal is `forbidden`, whatever the reason. A deployment naming an offering that is not the
 * district's is `validation-failed`, after the caller was allowed.
 */
export class LtiPlatformToolService {
  readonly #options: LtiPlatformToolServiceOptions;
  readonly #now: Clock;

  constructor(options: LtiPlatformToolServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Registers a tool. EducateOS assigns its ID, which is its `client_id`. */
  async registerTool(caller: Caller, rawInput: unknown): Promise<PlatformTool> {
    await this.#authorize(caller, "update");
    const input = PlatformToolInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The tool registration is malformed.");
    const at = this.#at();
    const tool = PlatformTool.parse({
      ...input.data,
      id: newPlatformToolId(),
      districtId: this.#options.districtId,
      status: "active",
      registeredBy: caller.principal.principalId,
      registeredAt: at,
      updatedBy: caller.principal.principalId,
      updatedAt: at,
    });
    await this.#options.store.addTool(tool);
    return tool;
  }

  /** Every tool and deployment, active and revoked. */
  async list(caller: Caller): Promise<{ tools: readonly PlatformTool[]; deployments: readonly PlatformDeployment[] }> {
    await this.#authorize(caller, "read");
    return { tools: await this.#options.store.tools(), deployments: await this.#options.store.deployments() };
  }

  /** Revokes a tool and all its deployments: from then on it can neither launch nor call a service. */
  async revokeTool(caller: Caller, rawId: unknown): Promise<PlatformTool> {
    await this.#authorize(caller, "update");
    const id = PlatformToolId.safeParse(rawId);
    const revoked = id.success ? await this.#options.store.revokeTool(id.data, caller.principal.principalId, this.#at()) : undefined;
    if (revoked === undefined) throw new EducateOsError("not-found", "No such tool.");
    return revoked;
  }

  /** Deploys an active tool to offerings of the district, with the services and data it may use. */
  async deploy(caller: Caller, rawInput: unknown): Promise<PlatformDeployment> {
    await this.#authorize(caller, "update");
    const input = PlatformDeploymentInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The deployment is malformed.");
    await this.#checkOfferings(input.data.offerings);
    const at = this.#at();
    const deployment = PlatformDeployment.parse({
      ...input.data,
      id: newPlatformDeploymentId(),
      districtId: this.#options.districtId,
      status: "active",
      createdBy: caller.principal.principalId,
      createdAt: at,
      updatedBy: caller.principal.principalId,
      updatedAt: at,
    });
    await this.#options.store.putDeployment(deployment);
    return deployment;
  }

  /** Changes a deployment's offerings, services or privacy. A revoked deployment cannot change. */
  async changeDeployment(caller: Caller, rawId: unknown, rawChange: unknown): Promise<PlatformDeployment> {
    await this.#authorize(caller, "update");
    const change = PlatformDeploymentChange.safeParse(rawChange);
    if (!change.success) throw new EducateOsError("validation-failed", "The deployment change is malformed.");
    const existing = await this.#deployment(rawId);
    if (existing.status === "revoked") throw new EducateOsError("conflict", "That deployment is revoked.");
    if (change.data.offerings !== undefined) await this.#checkOfferings(change.data.offerings);
    const changed = PlatformDeployment.parse({
      ...existing,
      ...change.data.offerings === undefined ? {} : { offerings: change.data.offerings },
      ...change.data.services === undefined ? {} : { services: change.data.services },
      ...change.data.privacy === undefined ? {} : { privacy: change.data.privacy },
      updatedBy: caller.principal.principalId,
      updatedAt: this.#at(),
    });
    await this.#options.store.putDeployment(changed);
    return changed;
  }

  /** Revokes one deployment: the tool can no longer launch or call a service through it. */
  async revokeDeployment(caller: Caller, rawId: unknown): Promise<PlatformDeployment> {
    await this.#authorize(caller, "update");
    const existing = await this.#deployment(rawId);
    if (existing.status === "revoked") return existing;
    const revoked = PlatformDeployment.parse({ ...existing, status: "revoked", updatedBy: caller.principal.principalId, updatedAt: this.#at() });
    await this.#options.store.putDeployment(revoked);
    return revoked;
  }

  async #deployment(rawId: unknown): Promise<PlatformDeployment> {
    const id = PlatformDeploymentId.safeParse(rawId);
    const deployment = id.success ? await this.#options.store.deployment(id.data) : undefined;
    if (deployment === undefined) throw new EducateOsError("not-found", "No such deployment.");
    return deployment;
  }

  async #checkOfferings(offerings: readonly OfferingId[]): Promise<void> {
    const directory = await this.#options.directory();
    const known = new Set(directory.offerings.filter((o) => o.districtId === this.#options.districtId).map((o) => o.id));
    if (offerings.some((id) => !known.has(id))) throw new EducateOsError("validation-failed", "A deployment may name only this district's offerings.");
  }

  async #authorize(caller: Caller, action: "read" | "update"): Promise<void> {
    await authorizeLti(this.#options.authorizer, caller, action, districtResource(this.#options.districtId), forbidden);
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }
}
