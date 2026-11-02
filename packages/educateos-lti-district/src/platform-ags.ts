import { z } from "zod";
import {
  EducateOsError,
  OfferingId,
  PrincipalId,
  UtcTimestamp,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type ResourceRef,
  type Scope,
  type TermState,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import {
  deploymentAllows,
  lineItemBody,
  LTI_SCOPES,
  newPlatformLineItemId,
  PlatformDeploymentId,
  platformAgsEndpointClaim,
  PlatformLineItem,
  PlatformLineItemId,
  PlatformLineItemInput,
  PlatformScore,
  type Clock,
  type LtiScope,
  type PlatformDeployment,
  type PlatformServiceGrant,
  type PlatformTool,
  type PlatformToolService,
} from "@educateos/lti";
import {
  defineSchoolTool,
  OPEN_APPROVAL_STATES,
  PendingToolAction,
  SchoolToolRunner,
  type PolicyDecider,
  type ToolApprovalId,
  type ToolApprovalState,
  type ToolApprovalStore,
  type ToolDecisionOutcome,
} from "@educateos/policy";
import type { TablePlatformSubjectStore } from "./platform-launch.ts";
import type { TablePlatformToolStore } from "./platform-tools.ts";
import { LtiStoredRecordError } from "./stores.ts";
import { tupleKey, type RecordTable } from "./table.ts";

/** The collections the LTI Platform's Assignment and Grade Services keep their state in (SCHO-179). */
export const PLATFORM_AGS_COLLECTIONS = {
  /** Line items, by ID: each a tool's gradebook column in one offering. */
  lineItems: "lti.platform-line-item",
  /** Official results, by line item and learner: scores a teacher approved. */
  results: "lti.platform-ags-result",
  /** The latest score timestamp received, by line item and learner, approved or not. */
  scoreTimes: "lti.platform-ags-score-time",
  /** Scores waiting for a teacher: the IF-06 approval queue of the AGS score tool. */
  approvals: "lti.platform-score-approval",
} as const;

function read<T>(schema: z.ZodType<T>, value: unknown, collection: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LtiStoredRecordError(`a ${collection} record does not match its schema`);
  return parsed.data;
}

/**
 * A learner's official result for a line item: a score a tool posted that a teacher of the offering
 * approved. Nothing a tool sends becomes one by itself.
 */
export const PlatformAgsResult = z.strictObject({
  lineItemId: PlatformLineItemId,
  offeringId: OfferingId,
  studentId: PrincipalId,
  scoreGiven: z.number().finite().min(0),
  scoreMaximum: z.number().finite().positive(),
  comment: z.string().max(1000).optional(),
  /** The score's timestamp, as the tool sent it. */
  timestamp: z.iso.datetime({ offset: true }),
  /** How many of the learner's scores for the line item have become official. */
  version: z.int().positive(),
  /** The correlation ID the score was queued under, which its approval is audited with. */
  correlationId: z.string().min(1).max(128),
  recordedAt: UtcTimestamp,
});
/** An official AGS result. */
export type PlatformAgsResult = z.infer<typeof PlatformAgsResult>;

const ScoreTime = z.strictObject({ timestamp: z.iso.datetime({ offset: true }) });

/**
 * The LTI Platform's line items, official results and score timestamps, over the district's record
 * table. A line item with an official result cannot be removed, and a result is recorded only
 * while its line item exists and no later score is official, each in one atomic step.
 */
export class TablePlatformAgsStore {
  readonly #table: RecordTable;
  readonly #now: Clock;

  constructor(table: RecordTable, now: Clock = Date.now) {
    this.#table = table;
    this.#now = now;
  }

  async lineItem(id: PlatformLineItemId): Promise<PlatformLineItem | undefined> {
    const row = this.#table.get(PLATFORM_AGS_COLLECTIONS.lineItems, id);
    return row === undefined ? undefined : read(PlatformLineItem, row.value, PLATFORM_AGS_COLLECTIONS.lineItems);
  }

  /** The line items created through `deploymentId` in `offeringId`, oldest first. */
  async lineItems(deploymentId: PlatformDeploymentId, offeringId: OfferingId): Promise<PlatformLineItem[]> {
    return this.#table.list(PLATFORM_AGS_COLLECTIONS.lineItems)
      .map(({ row }) => read(PlatformLineItem, row.value, PLATFORM_AGS_COLLECTIONS.lineItems))
      .filter((item) => item.deploymentId === deploymentId && item.offeringId === offeringId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async putLineItem(item: PlatformLineItem): Promise<void> {
    this.#table.put(PLATFORM_AGS_COLLECTIONS.lineItems, item.id, PlatformLineItem.parse(item));
  }

  /** Removes a line item and its score timestamps, unless a result of it is official. */
  async deleteLineItem(id: PlatformLineItemId): Promise<"deleted" | "has-results"> {
    return this.#table.atomically(() => {
      if (this.#resultRows(id).length > 0) return "has-results";
      this.#table.delete(PLATFORM_AGS_COLLECTIONS.lineItems, id);
      for (const { key } of this.#table.list(PLATFORM_AGS_COLLECTIONS.scoreTimes)) {
        if ((JSON.parse(key) as string[])[0] === id) this.#table.delete(PLATFORM_AGS_COLLECTIONS.scoreTimes, key);
      }
      return "deleted";
    });
  }

  /**
   * Records `timestamp` as the latest score received for the learner, if it is later than every one
   * before it (AGS 2.0 §3.4.6). Returns `false`, recording nothing, if it is not.
   */
  async claimScoreTime(lineItemId: PlatformLineItemId, studentId: PrincipalId, timestamp: string): Promise<boolean> {
    const key = tupleKey(lineItemId, studentId);
    return this.#table.atomically(() => {
      const row = this.#table.get(PLATFORM_AGS_COLLECTIONS.scoreTimes, key);
      if (row !== undefined && Date.parse(read(ScoreTime, row.value, PLATFORM_AGS_COLLECTIONS.scoreTimes).timestamp) >= Date.parse(timestamp)) return false;
      this.#table.put(PLATFORM_AGS_COLLECTIONS.scoreTimes, key, { timestamp });
      return true;
    });
  }

  /** The official results of a line item. */
  async results(lineItemId: PlatformLineItemId): Promise<PlatformAgsResult[]> {
    return this.#resultRows(lineItemId);
  }

  /** The learner's official result for a line item, if a teacher approved one. */
  async result(lineItemId: PlatformLineItemId, studentId: PrincipalId): Promise<PlatformAgsResult | undefined> {
    const row = this.#table.get(PLATFORM_AGS_COLLECTIONS.results, tupleKey(lineItemId, studentId));
    return row === undefined ? undefined : read(PlatformAgsResult, row.value, PLATFORM_AGS_COLLECTIONS.results);
  }

  /**
   * Makes an approved score the learner's official result, as its next version. `conflict` if the
   * line item is gone or a score with a later timestamp is already official.
   */
  async recordResult(input: Omit<PlatformAgsResult, "version" | "recordedAt">): Promise<PlatformAgsResult> {
    const key = tupleKey(input.lineItemId, input.studentId);
    return this.#table.atomically(() => {
      if (this.#table.get(PLATFORM_AGS_COLLECTIONS.lineItems, input.lineItemId) === undefined) {
        throw new EducateOsError("conflict", "The line item no longer exists.");
      }
      const row = this.#table.get(PLATFORM_AGS_COLLECTIONS.results, key);
      const previous = row === undefined ? undefined : read(PlatformAgsResult, row.value, PLATFORM_AGS_COLLECTIONS.results);
      if (previous !== undefined && Date.parse(previous.timestamp) > Date.parse(input.timestamp)) {
        throw new EducateOsError("conflict", "A later score is already official.");
      }
      const result = PlatformAgsResult.parse({ ...input, version: (previous?.version ?? 0) + 1, recordedAt: new Date(this.#now()).toISOString() });
      this.#table.put(PLATFORM_AGS_COLLECTIONS.results, key, result);
      return result;
    });
  }

  #resultRows(lineItemId: PlatformLineItemId): PlatformAgsResult[] {
    return this.#table.list(PLATFORM_AGS_COLLECTIONS.results)
      .map(({ row }) => read(PlatformAgsResult, row.value, PLATFORM_AGS_COLLECTIONS.results))
      .filter((result) => result.lineItemId === lineItemId);
  }
}

const QueuedRow = z.strictObject({ seq: z.int().positive(), action: PendingToolAction });

/**
 * The AGS score tool's {@link ToolApprovalStore} (IF-06), over the district's record table. It is
 * the same queue, with the same compare-and-set transitions, as the district's school tools keep in
 * their own table; it is kept apart so a runner that does not hold the score tool can never decide
 * (and so decline) a score.
 */
export class TablePlatformScoreApprovalStore implements ToolApprovalStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async get(id: ToolApprovalId): Promise<PendingToolAction | undefined> {
    return this.#row(id)?.action;
  }

  async insertUnlessOpen(action: PendingToolAction): Promise<PendingToolAction> {
    const parsed = PendingToolAction.parse(action);
    return this.#table.atomically(() => {
      const rows = this.#rows();
      const open = rows.find(({ action: stored }) => stored.idempotencyKey === parsed.idempotencyKey && OPEN_APPROVAL_STATES.has(stored.state));
      if (open !== undefined) return open.action;
      if (rows.some(({ action: stored }) => stored.id === parsed.id)) throw new Error(`duplicate tool approval ID ${parsed.id}`);
      const seq = Math.max(0, ...rows.map((row) => row.seq)) + 1;
      this.#table.put(PLATFORM_AGS_COLLECTIONS.approvals, parsed.id, { seq, action: parsed });
      return parsed;
    });
  }

  async transition(id: ToolApprovalId, from: ToolApprovalState, next: PendingToolAction): Promise<boolean> {
    const parsed = PendingToolAction.parse(next);
    if (parsed.id !== id) throw new Error("a transition cannot change an action's ID");
    return this.#table.atomically(() => {
      const row = this.#row(id);
      if (row?.action.state !== from) return false;
      this.#table.put(PLATFORM_AGS_COLLECTIONS.approvals, id, { seq: row.seq, action: parsed });
      return true;
    });
  }

  async list(): Promise<PendingToolAction[]> {
    return this.#rows().map((row) => row.action);
  }

  #row(id: string): z.infer<typeof QueuedRow> | undefined {
    const row = this.#table.get(PLATFORM_AGS_COLLECTIONS.approvals, id);
    return row === undefined ? undefined : read(QueuedRow, row.value, PLATFORM_AGS_COLLECTIONS.approvals);
  }

  #rows(): z.infer<typeof QueuedRow>[] {
    return this.#table.list(PLATFORM_AGS_COLLECTIONS.approvals)
      .map(({ row }) => read(QueuedRow, row.value, PLATFORM_AGS_COLLECTIONS.approvals))
      .toSorted((a, b) => a.seq - b.seq);
  }
}

/** The name of the school tool an AGS score is queued as. */
export const PLATFORM_AGS_SCORE_TOOL = "lti_ags_score";

/** A queued score, exactly as it becomes official once a teacher approves it. */
const ScoreChange = z.strictObject({
  lineItemId: PlatformLineItemId,
  studentId: PrincipalId,
  scoreGiven: z.number().finite().min(0),
  scoreMaximum: z.number().finite().positive(),
  comment: z.string().max(1000).optional(),
  timestamp: z.iso.datetime({ offset: true }),
});
type ScoreChange = z.infer<typeof ScoreChange>;

/** A score waiting for a teacher, as the teacher reviews it. */
export interface PendingPlatformScore {
  /** Pass to approve or decline it. */
  readonly approvalId: ToolApprovalId;
  /** What the teacher reviewed: pass it back with the approval so only this score is applied. */
  readonly digest: string | undefined;
  readonly toolName: string;
  readonly offeringId: OfferingId;
  readonly lineItem: { readonly id: PlatformLineItemId; readonly label: string; readonly scoreMaximum: number };
  readonly studentId: PrincipalId;
  readonly studentName: string | undefined;
  readonly scoreGiven: number;
  readonly scoreMaximum: number;
  readonly comment?: string;
  readonly timestamp: string;
  readonly queuedAt: string;
  readonly expiresAt: string;
}

/** What {@link LtiPlatformAgsService} is built from. */
export interface LtiPlatformAgsServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine (A02): every call is decided by it on the `lti-service` channel. */
  readonly policy: Authorizer & PolicyDecider;
  /** The district directory, read for offerings, terms, enrollments and people. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly tools: TablePlatformToolStore;
  readonly subjects: TablePlatformSubjectStore;
  readonly store: TablePlatformAgsStore;
  /** Where scores wait for a teacher (`TablePlatformScoreApprovalStore`). */
  readonly approvals: ToolApprovalStore;
  /**
   * The URL the AGS endpoints are under. A deployment's line items in an offering are at
   * `<agsUrl>/<deployment ID>/<offering ID>/lineitems`, each line item below that by its ID.
   */
  readonly agsUrl: string;
  readonly now?: Clock;
}

/** One AGS call's verified context: the tool, the deployment and offering it names, and its subject. */
interface AgsContext {
  readonly tool: PlatformTool;
  readonly deployment: PlatformDeployment;
  readonly offeringId: OfferingId;
  readonly scope: Scope;
  readonly termState: TermState | undefined;
  /** Who the call is decided as: the administrator who last set the deployment. */
  readonly subject: VerifiedPrincipal;
}

const notFound = () => new EducateOsError("not-found", "There is no such line item here.");
const insufficientScope = () => new EducateOsError("forbidden", "The access token does not allow this.");

/**
 * The LTI Platform's Assignment and Grade Services 2.0 (SCHO-179), for a tool calling with an access
 * token from `PlatformTokenEndpoint`.
 *
 * - Line items belong to one deployment and one offering; a tool reaches only those of its own
 *   deployments, in offerings they still name, with the scope the call needs and the service on.
 * - A call is decided by the policy engine on the `lti-service` channel as the administrator who
 *   last set the deployment, so it can do no more than they could, and stops when they leave.
 * - A score never becomes an official result by itself. A fully graded score for an active learner
 *   of the offering is queued as an IF-06 approval (the {@link PLATFORM_AGS_SCORE_TOOL} school tool,
 *   approval policy `approver`), pinned to its line item's revision; only a teacher of the offering,
 *   acting directly, can approve it, and only then is it a result. Results answer approved scores
 *   only, with each learner's per-tool subject.
 */
export class LtiPlatformAgsService {
  readonly #options: LtiPlatformAgsServiceOptions;
  readonly #now: Clock;
  readonly #runner: SchoolToolRunner;

  constructor(options: LtiPlatformAgsServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#runner = new SchoolToolRunner({
      engine: options.policy,
      tools: [this.#scoreTool()],
      approvals: { store: options.approvals, now: () => new Date(this.#now()) },
    });
  }

  /** The line items container of a deployment in an offering. */
  lineItemsUrl(deploymentId: PlatformDeploymentId, offeringId: OfferingId): string {
    return `${this.#options.agsUrl}/${encodeURIComponent(deploymentId)}/${encodeURIComponent(offeringId)}/lineitems`;
  }

  /** The AGS endpoint claim of a launch through `deployment` in `offeringId` from `resourceLinkId`. */
  async launchClaims(launch: { deployment: PlatformDeployment; offeringId: OfferingId; resourceLinkId: string }): Promise<Record<string, unknown>> {
    const lineItems = this.lineItemsUrl(launch.deployment.id, launch.offeringId);
    const own = (await this.#options.store.lineItems(launch.deployment.id, launch.offeringId)).filter((item) => item.resourceLinkId === launch.resourceLinkId);
    return platformAgsEndpointClaim(launch.deployment, { lineItems, lineItem: own.length === 1 ? `${lineItems}/${own[0]!.id}` : undefined });
  }

  /** The container's line items, filtered as AGS 2.0 §3.2.4 allows. */
  async listLineItems(
    grant: PlatformServiceGrant,
    deploymentId: string,
    offeringId: string,
    filter: { resourceLinkId?: string | undefined; resourceId?: string | undefined; tag?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly], "agsLineItems");
    await this.#authorize(at, "list", this.#gradebook(at));
    const container = this.lineItemsUrl(at.deployment.id, at.offeringId);
    return (await this.#options.store.lineItems(at.deployment.id, at.offeringId))
      .filter((item) => (filter.resourceLinkId === undefined || item.resourceLinkId === filter.resourceLinkId)
        && (filter.resourceId === undefined || item.resourceId === filter.resourceId)
        && (filter.tag === undefined || item.tag === filter.tag))
      .map((item) => lineItemBody(item, `${container}/${item.id}`));
  }

  /** Creates a line item in the container. */
  async createLineItem(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, raw: unknown): Promise<Record<string, unknown>> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.lineItem], "agsLineItems");
    const input = parseLineItem(raw);
    await this.#authorize(at, "create", this.#gradebook(at));
    const now = new Date(this.#now()).toISOString();
    const item = PlatformLineItem.parse({
      ...input,
      id: newPlatformLineItemId(),
      districtId: this.#options.districtId,
      toolId: at.tool.id,
      deploymentId: at.deployment.id,
      offeringId: at.offeringId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.#options.store.putLineItem(item);
    return lineItemBody(item, `${this.lineItemsUrl(at.deployment.id, at.offeringId)}/${item.id}`);
  }

  /** One line item of the container. */
  async lineItem(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, rawId: string): Promise<Record<string, unknown>> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly], "agsLineItems");
    const item = await this.#ownLineItem(at, rawId);
    await this.#authorize(at, "read", this.#gradebook(at, item.id));
    return lineItemBody(item, `${this.lineItemsUrl(at.deployment.id, at.offeringId)}/${item.id}`);
  }

  /** Replaces a line item's fields (AGS 2.0 §3.2.6), as its next revision. */
  async replaceLineItem(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, rawId: string, raw: unknown): Promise<Record<string, unknown>> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.lineItem], "agsLineItems");
    const item = await this.#ownLineItem(at, rawId);
    const input = parseLineItem(raw);
    await this.#authorize(at, "update", this.#gradebook(at, item.id));
    const next = PlatformLineItem.parse({
      ...input,
      id: item.id,
      districtId: item.districtId,
      toolId: item.toolId,
      deploymentId: item.deploymentId,
      offeringId: item.offeringId,
      revision: item.revision + 1,
      createdAt: item.createdAt,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    await this.#options.store.putLineItem(next);
    return lineItemBody(next, `${this.lineItemsUrl(at.deployment.id, at.offeringId)}/${item.id}`);
  }

  /** Removes a line item. One with an official result is kept: `conflict`. */
  async deleteLineItem(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, rawId: string): Promise<void> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.lineItem], "agsLineItems");
    const item = await this.#ownLineItem(at, rawId);
    await this.#authorize(at, "delete", this.#gradebook(at, item.id));
    if ((await this.#options.store.deleteLineItem(item.id)) === "has-results") {
      throw new EducateOsError("conflict", "A line item with official results cannot be removed.");
    }
  }

  /**
   * Receives a score (AGS 2.0 §3.4). It must name an active learner of the offering by their
   * subject for this tool and be later than every score received before it for them. A fully
   * graded score is queued for a teacher's approval (`queued: true`); any other only records the
   * learner's progress timestamp. Nothing becomes official here.
   */
  async postScore(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, rawId: string, raw: unknown): Promise<{ queued: boolean }> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.score], "agsScores");
    const item = await this.#ownLineItem(at, rawId);
    const parsed = PlatformScore.safeParse(raw);
    if (!parsed.success) throw new EducateOsError("validation-failed", "The score is malformed.");
    const score = parsed.data;
    const studentId = await this.#learner(at.tool, at.offeringId, score.userId);
    if (studentId === undefined) throw new EducateOsError("validation-failed", "userId is not a learner in this context.");
    if (!(await this.#options.store.claimScoreTime(item.id, studentId, score.timestamp))) {
      throw new EducateOsError("conflict", "A score with this or a later timestamp was already received.");
    }
    if (score.gradingProgress !== "FullyGraded" || score.scoreGiven === undefined) return { queued: false };
    const change: ScoreChange = {
      lineItemId: item.id,
      studentId,
      scoreGiven: score.scoreGiven,
      scoreMaximum: score.scoreMaximum!,
      ...score.comment === undefined ? {} : { comment: score.comment },
      timestamp: score.timestamp,
    };
    const outcome = await this.#runner.invoke({ principal: at.subject, channel: "lti-service" }, PLATFORM_AGS_SCORE_TOOL, change);
    if (outcome.status === "error") throw new EducateOsError(outcome.error.code, outcome.error.message);
    // The tool's approval policy queues every call, so a score that ran at once would be a bug.
    if (outcome.status === "ok") throw new Error("an AGS score became official without an approval");
    return { queued: true };
  }

  /**
   * The line item's official results (AGS 2.0 §3.3): approved scores only, each learner named by
   * their subject for this tool, optionally for one subject.
   */
  async results(grant: PlatformServiceGrant, deploymentId: string, offeringId: string, rawId: string, filter: { userId?: string | undefined }): Promise<Record<string, unknown>[]> {
    const at = await this.#context(grant, deploymentId, offeringId, [LTI_SCOPES.resultReadonly], "agsLineItems");
    const item = await this.#ownLineItem(at, rawId);
    await this.#authorize(at, "list", { kind: "official-grade", id: item.id, scope: at.scope, classification: "course" });
    const url = `${this.lineItemsUrl(at.deployment.id, at.offeringId)}/${item.id}`;
    const answered: Record<string, unknown>[] = [];
    for (const result of await this.#options.store.results(item.id)) {
      const userId = await this.#options.subjects.subjectFor(at.tool.id, result.studentId);
      if (filter.userId !== undefined && filter.userId !== userId) continue;
      answered.push({
        id: `${url}/results?user_id=${encodeURIComponent(userId)}`,
        scoreOf: url,
        userId,
        resultScore: result.scoreGiven,
        resultMaximum: result.scoreMaximum,
        ...result.comment === undefined ? {} : { comment: result.comment },
      });
    }
    return answered;
  }

  /** The scores waiting for `caller`'s decision, oldest first: those of offerings they may approve grades in. */
  async pendingScores(caller: Caller): Promise<PendingPlatformScore[]> {
    const directory = await this.#options.directory();
    const pending: PendingPlatformScore[] = [];
    for (const action of await this.#runner.pendingFor({ principal: caller.principal, channel: caller.channel })) {
      const change = ScoreChange.safeParse(action.input);
      const item = change.success ? await this.#options.store.lineItem(change.data.lineItemId) : undefined;
      if (!change.success || item === undefined) continue;
      const tool = await this.#options.tools.tool(item.toolId);
      pending.push({
        approvalId: action.id,
        digest: action.digest,
        toolName: tool?.name ?? item.toolId,
        offeringId: item.offeringId,
        lineItem: { id: item.id, label: item.label, scoreMaximum: item.scoreMaximum },
        studentId: change.data.studentId,
        studentName: directory.principals.find((p) => p.id === change.data.studentId)?.displayName,
        scoreGiven: change.data.scoreGiven,
        scoreMaximum: change.data.scoreMaximum,
        ...change.data.comment === undefined ? {} : { comment: change.data.comment },
        timestamp: change.data.timestamp,
        queuedAt: action.createdAt,
        expiresAt: action.expiresAt,
      });
    }
    return pending;
  }

  /**
   * Approves a waiting score as `caller`'s own decision, which makes it the learner's official
   * result. Given the `digest` they reviewed, only that score is applied.
   */
  async approveScore(caller: Caller, approvalId: string, raw: unknown): Promise<{ status: "applied" | "already-applied" }> {
    const body = z.strictObject({ digest: z.string().max(128).optional() }).safeParse(raw ?? {});
    if (!body.success) throw new EducateOsError("validation-failed", "An approval may name only the digest reviewed.");
    const outcome = decided(await this.#runner.approve(
      { principal: caller.principal, channel: caller.channel },
      approvalId,
      body.data.digest === undefined ? {} : { digest: body.data.digest },
    ));
    return { status: outcome.status === "already-applied" ? "already-applied" : "applied" };
  }

  /** Declines a waiting score with a reason; it never becomes official. */
  async declineScore(caller: Caller, approvalId: string, raw: unknown): Promise<{ status: "declined" }> {
    const body = z.strictObject({ reason: z.unknown() }).safeParse(raw);
    if (!body.success) throw new EducateOsError("validation-failed", "A decline needs a reason.");
    decided(await this.#runner.decline({ principal: caller.principal, channel: caller.channel }, approvalId, body.data.reason));
    return { status: "declined" };
  }

  /** The school tool a score is queued as, and applied by once a teacher approves it. */
  #scoreTool() {
    return defineSchoolTool({
      name: PLATFORM_AGS_SCORE_TOOL,
      description: "A score a third-party LTI tool posted for a learner, which becomes their official result for the line item once a teacher approves it.",
      inputSchema: ScoreChange,
      action: "grade",
      effect: "write",
      approval: "approver",
      // Only a tool's own service call queues a score; no agent or MCP client can.
      resource: async (input, context) => (context.channel === "lti-service" ? this.#scoreTarget(input) : undefined),
      recheck: async (input) => {
        const item = await this.#options.store.lineItem(input.lineItemId);
        const tool = item === undefined ? undefined : await this.#options.tools.tool(item.toolId);
        const deployment = item === undefined ? undefined : await this.#options.tools.deployment(item.deploymentId);
        if (item === undefined || tool === undefined || deployment === undefined || !deploymentAllows(tool, deployment, item.offeringId, "agsScores")) {
          throw new EducateOsError("conflict", "The tool may no longer send scores to this offering.");
        }
        if (!(await this.#isLearner(item.offeringId, input.studentId))) throw new EducateOsError("conflict", "The student is no longer a learner in this offering.");
        const official = await this.#options.store.result(input.lineItemId, input.studentId);
        if (official !== undefined && Date.parse(official.timestamp) > Date.parse(input.timestamp)) {
          throw new EducateOsError("conflict", "A later score is already official.");
        }
      },
      handler: async (input, context) => {
        const item = await this.#options.store.lineItem(input.lineItemId);
        if (item === undefined) throw new EducateOsError("conflict", "The line item no longer exists.");
        return this.#options.store.recordResult({ ...input, offeringId: item.offeringId, correlationId: context.correlationId });
      },
    });
  }

  /** A queued score's target: the learner's official grade for the line item, at its revision. */
  async #scoreTarget(input: ScoreChange): Promise<{ resource: ResourceRef; termState?: TermState; version: string } | undefined> {
    const item = await this.#options.store.lineItem(input.lineItemId);
    if (item === undefined) return undefined;
    const offering = offeringAt(await this.#options.directory(), this.#options.districtId, item.offeringId);
    if (offering === undefined) return undefined;
    return {
      resource: { kind: "official-grade", id: item.id, scope: offering.scope, classification: "course", ownerPrincipalId: input.studentId },
      ...offering.termState === undefined ? {} : { termState: offering.termState },
      version: String(item.revision),
    };
  }

  /**
   * Resolves the deployment and offering a call names, through its token's grant. A deployment or
   * offering the token cannot reach is `not-found`, alike; one it reaches without the scope or the
   * service the call needs is `forbidden`.
   */
  async #context(
    grant: PlatformServiceGrant,
    rawDeploymentId: string,
    rawOfferingId: string,
    scopes: readonly LtiScope[],
    service: PlatformToolService,
  ): Promise<AgsContext> {
    const deploymentId = PlatformDeploymentId.safeParse(rawDeploymentId);
    const offeringId = OfferingId.safeParse(rawOfferingId);
    const deployment = deploymentId.success ? grant.deployments.find((d) => d.id === deploymentId.data) : undefined;
    if (deployment === undefined || !offeringId.success || !deploymentAllows(grant.tool, deployment, offeringId.data)) throw notFound();
    const offering = offeringAt(await this.#options.directory(), this.#options.districtId, offeringId.data);
    if (offering === undefined) throw notFound();
    if (!scopes.some((scope) => grant.scopes.includes(scope)) || !deployment.services[service]) throw insufficientScope();
    return {
      tool: grant.tool,
      deployment,
      offeringId: offeringId.data,
      scope: offering.scope,
      termState: offering.termState,
      subject: { principalId: deployment.updatedBy, districtId: this.#options.districtId },
    };
  }

  /** The line item `rawId` names, if it is one of this deployment's in this offering. */
  async #ownLineItem(at: AgsContext, rawId: string): Promise<PlatformLineItem> {
    const id = PlatformLineItemId.safeParse(rawId);
    const item = id.success ? await this.#options.store.lineItem(id.data) : undefined;
    if (item === undefined || item.toolId !== at.tool.id || item.deploymentId !== at.deployment.id || item.offeringId !== at.offeringId) throw notFound();
    return item;
  }

  async #authorize(at: AgsContext, action: Action, resource: ResourceRef): Promise<void> {
    const decision = await this.#options.policy.authorize({
      subject: at.subject,
      action,
      resource,
      context: { channel: "lti-service", ...at.termState === undefined ? {} : { termState: at.termState } },
    });
    if (decision.effect !== "allow") throw new EducateOsError("forbidden", "The platform's policy does not allow this.");
  }

  #gradebook(at: AgsContext, lineItemId?: PlatformLineItemId): ResourceRef {
    return { kind: "gradebook", ...lineItemId === undefined ? {} : { id: lineItemId }, scope: at.scope, classification: "teacher-only" };
  }

  /** The active learner of the offering whose subject for the tool is `subject`, if there is one. */
  async #learner(tool: PlatformTool, offeringId: OfferingId, subject: string): Promise<PrincipalId | undefined> {
    const principalId = await this.#options.subjects.principalFor(tool.id, subject);
    return principalId !== undefined && (await this.#isLearner(offeringId, principalId)) ? principalId : undefined;
  }

  async #isLearner(offeringId: OfferingId, principalId: PrincipalId): Promise<boolean> {
    const directory = await this.#options.directory();
    const person = directory.principals.find((p) => p.id === principalId);
    return person?.status === "active"
      && directory.enrollments.some((e) => e.offeringId === offeringId && e.principalId === principalId && e.role === "student" && e.status === "active");
  }
}

/** A line item a tool sent, or `validation-failed`. */
function parseLineItem(raw: unknown): PlatformLineItemInput {
  const parsed = PlatformLineItemInput.safeParse(raw);
  if (!parsed.success) throw new EducateOsError("validation-failed", "The line item is malformed.");
  return parsed.data;
}

/** An offering of the district: its policy scope and its term's state. */
function offeringAt(directory: DistrictDirectorySnapshot, districtId: DistrictId, offeringId: OfferingId): { scope: Scope; termState: TermState | undefined } | undefined {
  const offering = directory.offerings.find((o) => o.id === offeringId);
  if (offering === undefined || offering.districtId !== districtId) return undefined;
  return {
    scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
    termState: directory.terms.find((t) => t.id === offering.termId)?.state,
  };
}

/** A decision's outcome, or its refusal thrown. */
function decided(outcome: ToolDecisionOutcome): Exclude<ToolDecisionOutcome, { status: "error" }> {
  if (outcome.status === "error") throw new EducateOsError(outcome.error.code, outcome.error.message);
  return outcome;
}
