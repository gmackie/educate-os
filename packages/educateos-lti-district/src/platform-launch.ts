import { z } from "zod";
import {
  EducateOsError,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type PrincipalId,
} from "@educateos/contracts";
import {
  deploymentAllows,
  PlatformAuthRequest,
  PlatformDeploymentId,
  PLATFORM_LAUNCH_ROLE,
  platformLaunchClaims,
  platformLoginInitiationUrl,
  PlatformLaunchTicket,
  redirectUriAllowed,
  randomToken,
  sha256Base64Url,
  signPlatformIdToken,
  type Clock,
  type PlatformToolId,
  type SingleUseStore,
} from "@educateos/lti";
import { authorizeLtiOffering } from "./authorize.ts";
import type { TablePlatformToolStore } from "./platform-tools.ts";
import { LtiStoredRecordError } from "./stores.ts";
import { tupleKey, type RecordTable } from "./table.ts";
import type { TableToolKeyStore } from "./tool-keys.ts";

/** The collections the LTI Platform's launches keep their state in (SCHO-179). */
export const PLATFORM_LAUNCH_COLLECTIONS = {
  /** Single-use launch tickets, each a launch's `lti_message_hint`. */
  tickets: "lti.platform-launch-ticket",
  /** Each person's opaque subject for each tool, in both directions. */
  subjects: "lti.platform-subject",
} as const;

/** How long a started launch can be redeemed by the tool's authentication request. */
export const PLATFORM_LAUNCH_TICKET_TTL_MS = 5 * 60_000;

const SubjectRecord = z.strictObject({ subject: z.string().min(1) });
const PrincipalRecord = z.strictObject({ principalId: z.string().min(1) });

/**
 * Each person's subject for each tool: a random value, made on the person's first launch of the
 * tool and kept, so a tool sees the same `sub` every time but two tools cannot match their people
 * by it, and nothing in it is derived from the person. The reverse lookup lets a later service call
 * that names a `sub` (an AGS score, for one) be traced back to the person.
 */
export class TablePlatformSubjectStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  /** The person's subject for the tool, made now if they have none. */
  async subjectFor(toolId: PlatformToolId, principalId: PrincipalId): Promise<string> {
    return this.#table.atomically(() => {
      const forward = tupleKey("principal", toolId, principalId);
      const row = this.#table.get(PLATFORM_LAUNCH_COLLECTIONS.subjects, forward);
      if (row !== undefined) return this.#read(SubjectRecord, row.value).subject;
      const subject = randomToken();
      this.#table.put(PLATFORM_LAUNCH_COLLECTIONS.subjects, forward, { subject });
      this.#table.put(PLATFORM_LAUNCH_COLLECTIONS.subjects, tupleKey("subject", toolId, subject), { principalId });
      return subject;
    });
  }

  /** The person whose subject for the tool is `subject`, if anyone's is. */
  async principalFor(toolId: PlatformToolId, subject: string): Promise<PrincipalId | undefined> {
    const row = this.#table.get(PLATFORM_LAUNCH_COLLECTIONS.subjects, tupleKey("subject", toolId, subject));
    return row === undefined ? undefined : this.#read(PrincipalRecord, row.value).principalId as PrincipalId;
  }

  #read<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new LtiStoredRecordError(`a ${PLATFORM_LAUNCH_COLLECTIONS.subjects} record does not match its schema`);
    return parsed.data;
  }
}

/** What {@link LtiPlatformLaunchService} is built from. */
export interface LtiPlatformLaunchServiceOptions {
  readonly districtId: DistrictId;
  /** The platform's issuer: the district's origin (`LTI_TOOL_ORIGIN`). */
  readonly issuer: string;
  /** The district's policy engine (A02). Starting a launch is decided by it. */
  readonly authorizer: Authorizer;
  /** The district directory, read for the person's enrollment, name and email and the offering's. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly tools: TablePlatformToolStore;
  /** The platform's signing keys (`LtiDistrictStores.platformKeys`). */
  readonly keys: TableToolKeyStore;
  /** Atomic single-use storage for launch tickets ({@link PLATFORM_LAUNCH_COLLECTIONS}). */
  readonly tickets: SingleUseStore<PlatformLaunchTicket>;
  readonly subjects: TablePlatformSubjectStore;
  readonly now?: Clock;
}

/** A started launch: where to send the browser, and the value only that browser may hold. */
export interface StartedPlatformLaunch {
  /** The tool's login initiation URL, with the launch's parameters. */
  readonly loginUrl: string;
  /** Kept by the browser that started the launch (a cookie) and presented with the auth request. */
  readonly binding: string;
  /** When the launch can no longer be redeemed, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** The answer to a valid authentication request: a form the browser posts to the tool. */
export interface PlatformLaunchForm {
  /** The registered redirect URI the tool asked for. */
  readonly action: string;
  readonly fields: { readonly id_token: string; readonly state?: string };
}

const forbidden = () => new EducateOsError("forbidden", "You may not launch that tool here.");
const refused = () => new EducateOsError("forbidden", "That launch cannot be completed.");

/**
 * Launches of the district's third-party tools (SCHO-179), from both ends. A signed-in person
 * starts one in an offering they are actively enrolled in, through an active deployment of an
 * active tool to that offering, and the policy engine allows them to `read` the offering; anything
 * else is `forbidden`, alike. That mints a single-use ticket bound to the starting browser and
 * sends the browser to the tool's login initiation URL.
 *
 * The tool's authentication request is then redeemed against the ticket: the request must be
 * well-formed, its `client_id` the ticket's tool, its `login_hint` the ticket's subject, its
 * `redirect_uri` exactly one the tool registered, and the browser the one that started it; the
 * tool and deployment must still allow the offering. The ticket is used up by the first attempt,
 * valid or not. The answer is a signed id_token for the tool alone.
 */
export class LtiPlatformLaunchService {
  readonly #options: LtiPlatformLaunchServiceOptions;
  readonly #now: Clock;

  constructor(options: LtiPlatformLaunchServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Starts a launch of the deployment `deploymentId` in the offering `offeringId`. */
  async start(caller: Caller, raw: unknown): Promise<StartedPlatformLaunch> {
    const input = z.object({ deploymentId: z.unknown(), offeringId: z.unknown() }).safeParse(raw);
    if (!input.success) throw new EducateOsError("validation-failed", "A launch names a deployment and an offering.");
    const directory = await this.#options.directory();
    const offeringId = await authorizeLtiOffering(
      { authorizer: this.#options.authorizer, districtId: this.#options.districtId, directory },
      caller,
      "read",
      input.data.offeringId,
      forbidden,
    );
    const deploymentId = PlatformDeploymentId.safeParse(input.data.deploymentId);
    const deployment = deploymentId.success ? await this.#options.tools.deployment(deploymentId.data) : undefined;
    const tool = deployment === undefined ? undefined : await this.#options.tools.tool(deployment.toolId);
    if (deployment === undefined || tool === undefined || tool.districtId !== this.#options.districtId || !deploymentAllows(tool, deployment, offeringId)) {
      throw forbidden();
    }
    const principalId = caller.principal.principalId;
    const enrollment = directory.enrollments.find((e) => e.offeringId === offeringId && e.principalId === principalId && e.status === "active");
    if (enrollment === undefined) throw forbidden();

    const subject = await this.#options.subjects.subjectFor(tool.id, principalId);
    const binding = randomToken();
    const messageHint = randomToken();
    const expiresAt = this.#now() + PLATFORM_LAUNCH_TICKET_TTL_MS;
    await this.#options.tickets.put(messageHint, PlatformLaunchTicket.parse({
      districtId: this.#options.districtId,
      toolId: tool.id,
      deploymentId: deployment.id,
      offeringId,
      principalId,
      subject,
      roles: [enrollment.role === "student" ? PLATFORM_LAUNCH_ROLE.learner : PLATFORM_LAUNCH_ROLE.instructor],
      resourceLinkId: await sha256Base64Url(tupleKey(deployment.id, offeringId)),
      targetLinkUri: tool.targetLinkUri,
      bindingHash: await sha256Base64Url(binding),
    }), expiresAt);
    const loginUrl = platformLoginInitiationUrl(tool, {
      issuer: this.#options.issuer,
      loginHint: subject,
      messageHint,
      deploymentId: deployment.id,
      targetLinkUri: tool.targetLinkUri,
    });
    return { loginUrl, binding, expiresAt };
  }

  /**
   * Answers the tool's authentication request, `rawRequest` (its query or form parameters), from
   * the browser that holds `binding`. A malformed request is `validation-failed`; any other refusal
   * is `forbidden`, with nothing posted to the tool.
   */
  async authorize(rawRequest: unknown, binding: string | undefined): Promise<PlatformLaunchForm> {
    const request = PlatformAuthRequest.safeParse(rawRequest);
    if (!request.success) throw new EducateOsError("validation-failed", "The authentication request is malformed.");
    const ticket = await this.#options.tickets.take(request.data.lti_message_hint);
    if (ticket === undefined || binding === undefined || (await sha256Base64Url(binding)) !== ticket.bindingHash) throw refused();
    if (ticket.districtId !== this.#options.districtId || request.data.client_id !== ticket.toolId || request.data.login_hint !== ticket.subject) throw refused();

    const tool = await this.#options.tools.tool(ticket.toolId);
    const deployment = await this.#options.tools.deployment(ticket.deploymentId);
    if (tool === undefined || deployment === undefined || !deploymentAllows(tool, deployment, ticket.offeringId) || !redirectUriAllowed(tool, request.data.redirect_uri)) {
      throw refused();
    }

    const directory = await this.#options.directory();
    const person = directory.principals.find((p) => p.id === ticket.principalId);
    const offering = directory.offerings.find((o) => o.id === ticket.offeringId);
    const course = offering === undefined ? undefined : directory.courses.find((c) => c.id === offering.courseId);
    if (person === undefined || person.status !== "active" || offering === undefined || course === undefined) throw refused();

    const claims = platformLaunchClaims(ticket, request.data, {
      offeringTitle: `${course.title}, ${offering.sectionName}`,
      offeringLabel: course.title,
      person: { displayName: person.displayName, email: person.email },
      privacy: deployment.privacy,
    });
    const idToken = await signPlatformIdToken(await this.#options.keys.keySet(), claims, {
      issuer: this.#options.issuer,
      audience: tool.id,
      nowMs: this.#now(),
    });
    return {
      action: request.data.redirect_uri,
      fields: { id_token: idToken, ...request.data.state === undefined ? {} : { state: request.data.state } },
    };
  }
}
