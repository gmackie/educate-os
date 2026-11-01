// Test worker for the workerd suite: a Durable Object that hosts one district's LTI stores over
// `DurableObjectRecordTable`, the way the district Worker will, so concurrent takes and claims
// arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import { ActivityId, DistrictId, OfferingId, PrincipalId, type DistrictDirectorySnapshot } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { LoginState, PlatformLaunchTicket, toolJwks, type PassbackClaim, type PlatformRegistration, type PlatformToolId } from "@educateos/lti";
// Imported module by module, not through the package index: these are the stores the Durable
// Object hosts, and the index also re-exports modules over E01 and the curriculum service.
import { DurableObjectRecordTable } from "../../src/durable-object.ts";
import { LTI_COLLECTIONS, TablePassbackLedger, TableRegistrationStore, TableSingleUseStore } from "../../src/stores.ts";
import { PLATFORM_LAUNCH_COLLECTIONS, TablePlatformSubjectStore } from "../../src/platform-launch.ts";
import { directoryRegistrationTargets } from "../../src/targets.ts";
import { PLATFORM_KEYS_COLLECTION, TableToolKeyStore, type ToolKeyRotation } from "../../src/tool-keys.ts";

const NF = DistrictId.parse("dst_northfield");
const NF_CANVAS = "https://canvas.northfield.example";
const BIO = OfferingId.parse("off_nf-bio-fall-p2");
const CELL_LAB = ActivityId.parse("act_cell-lab");
const AMARA = PrincipalId.parse("prn_nf-student-amara");

/** A launch ticket for Amara in Biology (SCHO-179). */
export const LAUNCH_TICKET: PlatformLaunchTicket = {
  districtId: NF,
  toolId: "ltt_notebook00000000000000",
  deploymentId: "ltd_notebook00000000000000",
  offeringId: BIO,
  principalId: AMARA,
  subject: "subject-amara",
  roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
  resourceLinkId: "resource-link-1",
  targetLinkUri: "https://notebook.example/lti/launch",
  bindingHash: "binding-hash",
};

const DIRECTORY: DistrictDirectorySnapshot = {
  ...NORTHFIELD,
  district: { ...NORTHFIELD.district, trustedIssuers: [...NORTHFIELD.district.trustedIssuers, NF_CANVAS] },
};

/** Northfield's Canvas registration. */
export const REGISTRATION: PlatformRegistration = {
  districtId: NF,
  provider: "canvas",
  issuer: NF_CANVAS,
  clientId: "10000000000001",
  deploymentIds: ["nf-canvas-deploy-1"],
  authLoginUrl: `${NF_CANVAS}/api/lti/authorize_redirect`,
  authTokenUrl: `${NF_CANVAS}/login/oauth2/token`,
  jwksUrl: `${NF_CANVAS}/api/lti/security/jwks`,
  offerings: [{ contextId: "nf-canvas-course-bio-p2", offeringId: BIO }],
  activityLinks: [],
};

/** One district's LTI stores in one Durable Object. */
export class TestLtiDistrict extends DurableObject {
  readonly #stores: {
    loginStates: TableSingleUseStore<LoginState>;
    passbackLedger: TablePassbackLedger;
    registrations: TableRegistrationStore;
    toolKeys: TableToolKeyStore;
    platformKeys: TableToolKeyStore;
    launchTickets: TableSingleUseStore<PlatformLaunchTicket>;
    platformSubjects: TablePlatformSubjectStore;
  };

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const targets = directoryRegistrationTargets({
      districtId: NF,
      directory: async () => DIRECTORY,
      activities: {
        find: async (activityId) =>
          activityId === CELL_LAB
            ? { scope: { level: "activity", districtId: NF, schoolId: "sch_nf-high" as never, offeringId: BIO, activityId }, title: "Cell lab" }
            : undefined,
      },
    });
    const table = new DurableObjectRecordTable(ctx.storage);
    this.#stores = {
      loginStates: new TableSingleUseStore(table, LTI_COLLECTIONS.loginStates, LoginState),
      passbackLedger: new TablePassbackLedger(table),
      registrations: new TableRegistrationStore(table, targets),
      toolKeys: new TableToolKeyStore(table),
      platformKeys: new TableToolKeyStore(table, Date.now, PLATFORM_KEYS_COLLECTION),
      launchTickets: new TableSingleUseStore(table, PLATFORM_LAUNCH_COLLECTIONS.tickets, PlatformLaunchTicket),
      platformSubjects: new TablePlatformSubjectStore(table),
    };
  }

  async putLoginState(state: string, ttlMs: number): Promise<void> {
    const login: LoginState = { issuer: NF_CANVAS, clientId: REGISTRATION.clientId, nonce: `nonce-${state}`, targetLinkUri: "https://educateos.example/lti/launch" };
    await this.#stores.loginStates.put(state, login, Date.now() + ttlMs);
  }

  async takeLoginState(state: string): Promise<LoginState | undefined> {
    return this.#stores.loginStates.take(state);
  }

  async claim(key: string, version: number, approvedAtMs: number): Promise<PassbackClaim> {
    const now = Date.now();
    return this.#stores.passbackLedger.claim(key, version, approvedAtMs, now, now + 120_000);
  }

  async complete(key: string, version: number): Promise<void> {
    await this.#stores.passbackLedger.complete(key, version);
  }

  async saveRegistration(): Promise<void> {
    await this.#stores.registrations.save(REGISTRATION);
  }

  async addActivityLink(linkId: string): Promise<"added" | "conflict"> {
    try {
      await this.#stores.registrations.addActivityLink(REGISTRATION, { offeringId: BIO, linkId, activityId: CELL_LAB });
      return "added";
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "conflict") return "conflict";
      throw err;
    }
  }

  async registration(): Promise<PlatformRegistration | undefined> {
    return this.#stores.registrations.get(REGISTRATION);
  }

  /** The published tool key IDs, signing key first. */
  async toolKeyIds(): Promise<string[]> {
    return toolJwks(await this.#stores.toolKeys.keySet()).keys.map((key) => key.kid);
  }

  async rotateToolKeys(): Promise<ToolKeyRotation> {
    return this.#stores.toolKeys.rotate();
  }

  /** The published LTI Platform key IDs (SCHO-179), signing key first. */
  async platformKeyIds(): Promise<string[]> {
    return toolJwks(await this.#stores.platformKeys.keySet()).keys.map((key) => key.kid);
  }

  async rotatePlatformKeys(): Promise<ToolKeyRotation> {
    return this.#stores.platformKeys.rotate();
  }

  /** Stores {@link LAUNCH_TICKET} under `hint`, the launch's `lti_message_hint` (SCHO-179). */
  async putLaunchTicket(hint: string, ttlMs: number): Promise<void> {
    await this.#stores.launchTickets.put(hint, LAUNCH_TICKET, Date.now() + ttlMs);
  }

  async takeLaunchTicket(hint: string): Promise<PlatformLaunchTicket | undefined> {
    return this.#stores.launchTickets.take(hint);
  }

  /** Amara's subject for `toolId`, made on first use. */
  async subjectFor(toolId: PlatformToolId): Promise<string> {
    return this.#stores.platformSubjects.subjectFor(toolId, AMARA);
  }

  async principalFor(toolId: PlatformToolId, subject: string): Promise<string | undefined> {
    return this.#stores.platformSubjects.principalFor(toolId, subject);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
