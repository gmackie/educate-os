// Test worker for the workerd suite: a Durable Object that hosts one district's LTI stores over
// `DurableObjectRecordTable`, the way the district Worker will, so concurrent takes and claims
// arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import { ActivityId, DistrictId, OfferingId, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { LoginState, type PassbackClaim, type PlatformRegistration } from "@schoolos/lti";
// Imported module by module, not through the package index: these are the stores the Durable
// Object hosts, and the index also re-exports modules over E01 and the curriculum service.
import { DurableObjectRecordTable } from "../../src/durable-object.ts";
import { LTI_COLLECTIONS, TablePassbackLedger, TableRegistrationStore, TableSingleUseStore } from "../../src/stores.ts";
import { directoryRegistrationTargets } from "../../src/targets.ts";

const NF = DistrictId.parse("dst_northfield");
const NF_CANVAS = "https://canvas.northfield.example";
const BIO = OfferingId.parse("off_nf-bio-fall-p2");
const CELL_LAB = ActivityId.parse("act_cell-lab");

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
    };
  }

  async putLoginState(state: string, ttlMs: number): Promise<void> {
    const login: LoginState = { issuer: NF_CANVAS, clientId: REGISTRATION.clientId, nonce: `nonce-${state}`, targetLinkUri: "https://schoolos.example/lti/launch" };
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
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
