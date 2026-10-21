import { expect } from "vitest";
import { ActivityId, DistrictId, OfferingId, SchoolOsError, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { createDirectoryPrincipalResolver, type PrincipalResolver } from "@schoolos/identity";
import {
  createLtiHandler,
  createToolKeySet,
  generateToolKey,
  importToolKey,
  InMemoryPlatformRegistrationStore,
  InMemorySingleUseStore,
  LtiBroker,
  PlatformJwksCache,
  type DeepLinkSession,
  type LoginState,
  type LtiHandlerOptions,
  type PlatformRegistration,
  type ToolKeySet,
} from "../src/index.ts";
import { FakePlatform, platformFetch } from "./fake-platform.ts";

/** The tool's origin. */
export const TOOL = "https://schoolos.example";
/** Northfield's Canvas. */
export const NF_CANVAS = "https://canvas.northfield.example";
/** A second platform Northfield also uses. */
export const NF_MOODLE = "https://moodle.northfield.example";
/** Riverbend's Canvas. */
export const RB_CANVAS = "https://canvas.riverbend.example";
/** An LTI subject that appears on two of Northfield's platforms, for different people. */
export const SHARED_SUB = "lti-user-0007";

/** Adds an LTI platform to a fixture district: trusts its issuer and links principals to subjects. */
export function withLtiPlatform(
  directory: DistrictDirectorySnapshot,
  issuer: string,
  subjects: Record<string, string>,
): DistrictDirectorySnapshot {
  const districtId = directory.district.id;
  return {
    ...directory,
    district: { ...directory.district, trustedIssuers: [...directory.district.trustedIssuers, issuer] },
    principals: directory.principals.map((p) => {
      const subject = subjects[p.id];
      return subject === undefined ? p : { ...p, externalIdentities: [...p.externalIdentities, { districtId, issuer, subject }] };
    }),
  };
}

/** Northfield, on Canvas and Moodle. Amara is `SHARED_SUB` on Canvas; Ms Rivera is on Moodle. */
export const NORTHFIELD_LTI = withLtiPlatform(
  withLtiPlatform(NORTHFIELD, NF_CANVAS, {
    "prn_nf-student-amara": SHARED_SUB,
    "prn_nf-teacher-rivera": "canvas-teacher-rivera",
    "prn_nf-district-admin": "canvas-admin-avery",
  }),
  NF_MOODLE,
  { "prn_nf-teacher-rivera": SHARED_SUB },
);

/** Riverbend, on its own Canvas. Inés has the same LTI subject as Amara in Northfield. */
export const RIVERBEND_LTI = withLtiPlatform(RIVERBEND, RB_CANVAS, {
  "prn_rb-student-ines": SHARED_SUB,
  "prn_rb-morgan-lee": "canvas-teacher-morgan",
});

/** A mutable test clock. */
export class TestClock {
  ms = Date.UTC(2026, 9, 20, 15, 0, 0);
  readonly now = (): number => this.ms;
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

function registration(platform: FakePlatform, districtId: string, offerings: PlatformRegistration["offerings"]): PlatformRegistration {
  return {
    districtId: DistrictId.parse(districtId),
    provider: platform.issuer.includes("moodle") ? "moodle" : "canvas",
    issuer: platform.issuer,
    clientId: platform.clientId,
    deploymentIds: [platform.deploymentId],
    authLoginUrl: platform.authLoginUrl,
    authTokenUrl: `${platform.issuer}/login/oauth2/token`,
    jwksUrl: platform.jwksUrl,
    offerings,
    activityLinks: [],
  };
}

/** A broker serving both districts, with its platforms, stores and handler. */
export async function createWorld(handlerOverrides: Partial<Omit<LtiHandlerOptions, "broker">> = {}) {
  const clock = new TestClock();
  const nfCanvas = await FakePlatform.create(NF_CANVAS, "10000000000001", "nf-canvas-deploy-1", clock.now);
  const nfMoodle = await FakePlatform.create(NF_MOODLE, "moodle-client-nf", "nf-moodle-deploy-1", clock.now);
  const rbCanvas = await FakePlatform.create(RB_CANVAS, "20000000000002", "rb-canvas-deploy-1", clock.now);
  const { fetch, calls } = platformFetch([nfCanvas, nfMoodle, rbCanvas]);

  const registrations = new InMemoryPlatformRegistrationStore([
    {
      ...registration(nfCanvas, "dst_northfield", [
        { contextId: "nf-canvas-course-bio-p2", offeringId: OfferingId.parse("off_nf-bio-fall-p2") },
        { contextId: "nf-canvas-course-eng9-p3", offeringId: OfferingId.parse("off_nf-eng9-fall-p3") },
      ]),
      deploymentIds: [nfCanvas.deploymentId, "nf-canvas-deploy-2"],
      activityLinks: [{ offeringId: OfferingId.parse("off_nf-bio-fall-p2"), linkId: "rl-cell-lab", activityId: ActivityId.parse("act_cell-lab") }],
    },
    registration(nfMoodle, "dst_northfield", [{ contextId: "moodle-bio", offeringId: OfferingId.parse("off_nf-bio-fall-p2") }]),
    registration(rbCanvas, "dst_riverbend", [{ contextId: "rb-canvas-course-bio-a", offeringId: OfferingId.parse("off_rb-bio-a") }]),
  ]);

  const resolvers = new Map<string, PrincipalResolver>([
    ["dst_northfield", createDirectoryPrincipalResolver(NORTHFIELD_LTI)],
    ["dst_riverbend", createDirectoryPrincipalResolver(RIVERBEND_LTI)],
  ]);
  let toolKeys: ToolKeySet = createToolKeySet(await importToolKey(await generateToolKey()));
  const loginStates = new InMemorySingleUseStore<LoginState>(clock.now);
  const deepLinkSessions = new InMemorySingleUseStore<DeepLinkSession>(clock.now);

  const broker = new LtiBroker({
    toolOrigin: TOOL,
    registrations,
    loginStates,
    deepLinkSessions,
    platformKeys: new PlatformJwksCache({ fetch, now: clock.now }),
    toolKeys: () => toolKeys,
    principalResolver: async (districtId) => resolvers.get(districtId),
    now: clock.now,
  });
  const handler = createLtiHandler({
    broker,
    onResourceLinkLaunch: async (launch) => Response.json({ accepted: launch }),
    onDeepLinkingRequest: async (launch, session) => Response.json({ picker: launch, session }),
    selectActivities: async (_launch, activityIds) => activityIds.map((activityId) => ({ activityId, title: `Activity ${activityId}` })),
    ...handlerOverrides,
  });

  return {
    clock,
    broker,
    handler,
    registrations,
    calls,
    platforms: { nfCanvas, nfMoodle, rbCanvas },
    getToolKeys: () => toolKeys,
    setToolKeys: (next: ToolKeySet) => {
      toolKeys = next;
    },
  };
}

/** A world from {@link createWorld}. */
export type World = Awaited<ReturnType<typeof createWorld>>;

/** Starts a login through the broker and returns its state and nonce. */
export async function startLogin(world: World, platform: FakePlatform, extra: Record<string, string | undefined> = {}) {
  const { redirectUrl, state } = await world.broker.login({
    iss: platform.issuer,
    client_id: platform.clientId,
    login_hint: "opaque-login-hint",
    target_link_uri: `${TOOL}/lti/launch`,
    lti_deployment_id: platform.deploymentId,
    ...extra,
  });
  const nonce = new URL(redirectUrl).searchParams.get("nonce")!;
  return { state, nonce, redirectUrl };
}

/** The code of the `SchoolOsError` a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SchoolOsError);
    return (err as SchoolOsError).code;
  }
  throw new Error("expected a rejection");
}

/** A form-encoded POST. */
export function formPost(url: string, fields: [string, string][], cookie?: string): Request {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request(url, { method: "POST", headers, body });
}

/** The `name=value` part of a Set-Cookie header. */
export function cookiePair(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}
