// The district's Durable Object: one per district, named by its district ID, holding every store
// of the district application in its SQLite storage and running the application itself
// (`startDistrict` in district.ts). The Worker's `/api` requests and both service entrypoints reach
// the district through it.
//
// Why one object. The application's stores are optimistic: each commit names the version it was
// planned against. Keeping them all in one object means each store's check and write run in one
// synchronous SQLite transaction, with no cross-object protocol, and the stores that cache what they
// read stay correct because this object is their only writer. The cost is throughput: one object
// serves the whole district, which suits a pilot district (see README.md).
//
// What is not atomic. No transaction spans two stores. A request that writes several (a submission
// writes artifact records and then assessment records; a roster apply writes the directory, then the
// roster sources, then the workspaces' grants) commits each in turn, exactly as it does over the
// in-memory stores. Between those commits the object may serve other requests, since the
// application awaits (WebCrypto, outbound fetches) between them; a request planned against a version
// another one has since replaced fails with `conflict` and is retried by its caller.
//
// Like the other Workers-only modules, this shell is checked by running it (`__tests__/`): the
// Workers runtime's typings reject the web-standard sources it composes (ADR-0009).
import { DurableObject } from "cloudflare:workers";
import type { JWTVerifyGetKey } from "jose";
import { createLogger } from "@gadgets/observability/logger";
import type { DistrictDirectorySnapshot, VerifiedPrincipal } from "@schoolos/contracts";
import type { DistrictApp } from "@schoolos/district-app";
import type { AdmittedSubjectRequest, GuardSubject, GuardSubjectRequest } from "@schoolos/district-app/guard-directory";
import type { SchoolToolListing, SchoolToolOutcome, ToolDecisionOutcome } from "@schoolos/policy";
import { startDistrict, type District } from "./district.ts";
import type { SendEmailBinding } from "./mail.ts";
import { jobForCron } from "./schedule.ts";

/** What the district logs: its ID, and a scheduled job's counts (SCHO-189). */
interface DistrictLogFields {
  districtId: string;
  week?: string;
  added?: number;
  emailed?: number;
  sent?: number;
  skipped?: number;
  failed?: number;
  alreadyDone?: number;
}

const logger = createLogger<DistrictLogFields>({ component: "schoolos.district" });

/** One district's state and application. */
export class DistrictObject extends DurableObject<Cloudflare.Env> {
  #district: Promise<District> | undefined;

  /**
   * The keys Access assertions are verified with. Undefined uses the Access team's published
   * certs; the tests override it with a local key set.
   */
  protected accessKeys(): JWTVerifyGetKey | undefined {
    return undefined;
  }

  /**
   * The fetch the Content Studio imports URLs with, after its own URL checks. On Workers `fetch`
   * cannot reach private networks, so those checks suffice (see `@schoolos/harness/pinned-fetch`).
   */
  protected importFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  /**
   * The Email Service binding notification and digest email is sent through (`SEND_EMAIL`,
   * declared in cloudflare.config.ts). Tests replace it with a recorder.
   */
  protected sendEmail(): SendEmailBinding | undefined {
    return this.env.SEND_EMAIL as SendEmailBinding | undefined;
  }

  /** The running application, for subclasses that drive it directly (the tests). */
  protected async districtApp(): Promise<DistrictApp> {
    return (await this.#boot()).app;
  }

  /** Serves the district's `/api` surface. */
  override async fetch(request: Request): Promise<Response> {
    return (await this.#boot()).app.fetch(request);
  }

  /** What the district says about a Workshop user, for the AI call guard. */
  async guardSubject(request: GuardSubjectRequest): Promise<GuardSubject | null> {
    return (await this.#boot()).app.guardDirectory.guardSubject(request);
  }

  /** What the district says now about an admitted call's principal, for the AI call guard. */
  async admittedSubject(request: AdmittedSubjectRequest): Promise<GuardSubject | null> {
    return (await this.#boot()).app.guardDirectory.admittedSubject(request);
  }

  /** The profile-free directory the AI call guard's ledger resolves funding against. */
  async ledgerDirectory(): Promise<DistrictDirectorySnapshot> {
    return (await this.#boot()).app.guardDirectory.ledgerDirectory();
  }

  /** The principal a browser request is signed in as, for the SchoolOS gatekeeper. */
  async authenticate(request: Request): Promise<VerifiedPrincipal | null> {
    return (await this.#boot()).tools.authenticate(request);
  }

  /** The district's school tools. */
  async listTools(): Promise<SchoolToolListing[]> {
    return (await this.#boot()).tools.listTools();
  }

  /** Runs one tool call for `subject` as an agent's; writes are queued for a person. */
  async callTool(subject: VerifiedPrincipal, name: string, args: unknown): Promise<SchoolToolOutcome> {
    return (await this.#boot()).tools.callTool(subject, name, args);
  }

  /** Approves a queued change as `approver`'s own decision. */
  async approveChange(approver: VerifiedPrincipal, approvalId: string): Promise<ToolDecisionOutcome> {
    return (await this.#boot()).tools.approveChange(approver, approvalId);
  }

  /** Declines a queued change as `decider`'s own decision. */
  async declineChange(decider: VerifiedPrincipal, approvalId: string, reason: string): Promise<ToolDecisionOutcome> {
    return (await this.#boot()).tools.declineChange(decider, approvalId, reason);
  }

  /**
   * Runs the job a Cron Trigger names (SCHO-189): the hourly notification sweep, or the weekly
   * family digest. An expression the district does not schedule runs nothing.
   */
  async runScheduled(cron: string): Promise<void> {
    const { app } = await this.#boot();
    const log = logger.with({ districtId: app.districtId });
    const job = jobForCron(cron);
    if (job === undefined) {
      log.warn("a Cron Trigger named no district job", { event: "district.cron.unknown" });
      return;
    }
    const result = job === "notifications" ? await app.communication.runNotificationJob() : await app.communication.runWeeklyDigest();
    log.info("a scheduled district job ran", { event: `district.cron.${job}`, ...result });
  }

  #boot(): Promise<District> {
    // A failed start is not kept, so the next request tries again (after a configuration fix, say).
    this.#district ??= this.#start().catch((error: unknown) => {
      this.#district = undefined;
      logger.error("the district failed to start", { event: "district.start.failed", error });
      throw error;
    });
    return this.#district;
  }

  async #start(): Promise<District> {
    const keys = this.accessKeys();
    const sendEmail = this.sendEmail();
    const district = await startDistrict(
      this.ctx.storage,
      { config: this.env.DISTRICT_CONFIG, accessIssuer: this.env.CF_ACCESS_ISS, accessAudience: this.env.CF_ACCESS_AUD },
      {
        importFetch: (url, init) => this.importFetch(url, init),
        ...(keys === undefined ? {} : { accessKeys: keys }),
        ...(sendEmail === undefined ? {} : { sendEmail }),
      },
    );
    logger.with({ districtId: district.app.districtId }).info("the district started", { event: "district.started" });
    return district;
  }
}
