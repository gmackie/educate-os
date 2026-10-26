// The broker, handlers and LTI Advantage clients, unchanged, against the wire-faithful Canvas- and
// Schoology-flavoured platform fakes of `@educateos/provider-fakes` (SCHO-201): OIDC login through
// launch, a Deep Linking round trip the platform verifies, NRPS paging, AGS line items and grade
// passback, Dynamic Registration with Canvas, and transport faults.
import { describe, expect, it } from "vitest";
import { ActivityId, DistrictId, OfferingId, PrincipalId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import {
  AgsClient,
  approvedRegistration,
  createLtiHandler,
  createToolKeySet,
  DynamicRegistration,
  generateToolKey,
  GradePassback,
  importToolKey,
  InMemoryGradeApprovalStore,
  InMemoryGradeRouteStore,
  InMemoryPassbackLedger,
  InMemoryPendingRegistrationStore,
  InMemoryPlatformRegistrationStore,
  InMemorySingleUseStore,
  LTI_SCOPES,
  LtiAgsGradeSink,
  LtiBroker,
  LtiServiceClient,
  NrpsClient,
  PlatformJwksCache,
  toolJwks,
  type DeepLinkSession,
  type LoginState,
  type LtiContextServices,
  type RegistrationInvitation,
  type ResolvedLaunch,
} from "../src/index.ts";
import {
  canvasFlavour,
  LtiPlatformFake,
  parseAutoSubmitForm,
  SAMPLE_DISTRICT,
  schoologyFlavour,
  type LtiFlavour,
} from "@educateos/provider-fakes";
import { cookiePair, formPost, rejection, TestClock, TOOL, withLtiPlatform } from "./helpers.ts";

const NF = DistrictId.parse("dst_northfield");
const BIO = OfferingId.parse("off_nf-bio-fall-p2");
const AMARA = PrincipalId.parse("prn_nf-student-amara");
const MORGAN = PrincipalId.parse("prn_nf-morgan-lee");
/** The seed's Biology period 2, its first student and its teacher stand for Northfield's. */
const SECTION = "mw-bio-p2";
const STUDENT = "mw-s-01";
const TEACHER = "mw-t-okafor";

const flavours: [string, () => LtiFlavour][] = [
  ["canvas", () => canvasFlavour({ issuer: "https://canvas.northfield.example", sso: "https://sso.canvas.northfield.example", domain: "https://northfield.instructure.example" })],
  ["schoology", () => schoologyFlavour({ issuer: "https://schoology.northfield.example", service: "https://lti-service.schoology.northfield.example" })],
];

async function createWorld(flavour: () => LtiFlavour) {
  const clock = new TestClock();
  const toolKeys = createToolKeySet(await importToolKey(await generateToolKey()));
  const fake = await LtiPlatformFake.create({
    flavour: flavour(),
    seed: SAMPLE_DISTRICT,
    now: clock.now,
    tools: [{ name: "EducateOS", initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [`${TOOL}/lti/launch`], jwks: () => toolJwks(toolKeys) }],
  });
  const tool = [...fake.tools.values()][0]!;
  const contextId = fake.contextOf(SECTION).contextId;
  const directory = withLtiPlatform(NORTHFIELD, fake.issuer, { [AMARA]: fake.userOf(STUDENT).sub, [MORGAN]: fake.userOf(TEACHER).sub });
  const registrations = new InMemoryPlatformRegistrationStore([
    {
      districtId: NF,
      provider: fake.flavour.name,
      issuer: fake.issuer,
      clientId: tool.clientId,
      deploymentIds: [...tool.deploymentIds],
      authLoginUrl: fake.flavour.authorizationEndpoint,
      authTokenUrl: fake.flavour.tokenEndpoint,
      jwksUrl: fake.flavour.jwksUri,
      offerings: [{ contextId, offeringId: BIO }],
      activityLinks: [],
    },
  ]);
  const broker = new LtiBroker({
    toolOrigin: TOOL,
    registrations,
    loginStates: new InMemorySingleUseStore<LoginState>(clock.now),
    deepLinkSessions: new InMemorySingleUseStore<DeepLinkSession>(clock.now),
    platformKeys: new PlatformJwksCache({ fetch: fake.fetch, now: clock.now }),
    toolKeys: () => toolKeys,
    principalResolver: async (districtId) => (districtId === NF ? createDirectoryPrincipalResolver(directory) : undefined),
    now: clock.now,
  });
  const handler = createLtiHandler({
    broker,
    onResourceLinkLaunch: async (launch) => Response.json({ accepted: launch }),
    onDeepLinkingRequest: async (launch, session) => Response.json({ picker: launch, session }),
    selectActivities: async (_launch, activityIds) => activityIds.map((activityId) => ({ activityId, title: `Activity ${activityId}` })),
  });
  const services = new LtiServiceClient({ fetch: fake.fetch, toolKeys: () => toolKeys, now: clock.now });
  return { clock, fake, tool, contextId, directory, registrations, broker, handler, services, toolKeys };
}

type World = Awaited<ReturnType<typeof createWorld>>;

/**
 * A launch the way a browser makes it: the platform's login initiation to the tool, the tool's
 * redirect to the platform's authorization endpoint, and the platform's form post back.
 */
async function browserLaunch(world: World, input: Omit<Parameters<LtiPlatformFake["initiateLogin"]>[0], "sectionId"> & { sectionId?: string }) {
  const initiation = world.fake.initiateLogin({ sectionId: SECTION, ...input });
  const login = (await world.handler(new Request(initiation.url)))!;
  expect(login.status).toBe(302);
  const authorization = await world.fake.authorize(login.headers.get("location")!);
  expect(authorization.form?.action).toBe(`${TOOL}/lti/launch`);
  return (await world.handler(formPost(authorization.form!.action, Object.entries(authorization.form!.fields), cookiePair(login.headers.get("set-cookie")))))!;
}

describe.each(flavours)("@educateos/lti against the %s platform fake", (name, flavour) => {
  it("runs OIDC login through launch and resolves the principal, offering and services", async () => {
    const world = await createWorld(flavour);
    const response = await browserLaunch(world, { personId: STUDENT });
    expect(response.status).toBe(200);
    const { accepted } = (await response.json()) as { accepted: ResolvedLaunch };
    expect(accepted).toMatchObject({ principal: { principalId: AMARA }, offeringId: BIO, messageType: "LtiResourceLinkRequest" });
    const context = world.fake.contextOf(SECTION);
    expect(accepted.services).toEqual({
      registration: { issuer: world.fake.issuer, clientId: world.tool.clientId },
      contextId: context.contextId,
      ags: { scopes: [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score], lineItemsUrl: context.lineItemsUrl },
      nrps: { membershipsUrl: context.membershipsUrl },
    });
  });

  it("completes a Deep Linking round trip the platform verifies, and the placed link launches its activity", async () => {
    const world = await createWorld(flavour);
    const request = await browserLaunch(world, { personId: TEACHER, messageType: "LtiDeepLinkingRequest" });
    const { picker, session } = (await request.json()) as { picker: ResolvedLaunch; session: string };
    expect(picker).toMatchObject({ principal: { principalId: MORGAN }, offeringId: BIO });

    const chosen = (await world.handler(formPost(`${TOOL}/lti/deep-link`, [["session", session], ["activity", "act_cell-lab"]])))!;
    const form = parseAutoSubmitForm(await chosen.text())!;
    expect(new URL(form.action).pathname).toBe(new URL(world.fake.contextOf(SECTION).deepLinkReturnUrl).pathname);
    const returned = await world.fake.fetch(form.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form.fields).toString(),
    });
    expect(returned.status).toBe(200);
    const [result] = world.fake.deepLinkResults;
    expect(result!.links).toHaveLength(1);
    const link = result!.links[0]!;
    expect(link).toMatchObject({ title: "Activity act_cell-lab", url: `${TOOL}/lti/launch` });

    // The platform launches the placed link with the custom parameter the tool wrote into it.
    const launched = await browserLaunch(world, { personId: STUDENT, resourceLinkId: link.id });
    const { accepted } = (await launched.json()) as { accepted: ResolvedLaunch };
    expect(accepted.activity).toBe(ActivityId.parse("act_cell-lab"));
  });

  it("reads a paged NRPS roster", async () => {
    const world = await createWorld(flavour);
    const nrps = new NrpsClient({ services: world.services, registrations: world.registrations, now: world.clock.now });
    const context = world.fake.contextOf(SECTION);
    const services: LtiContextServices = {
      registration: { issuer: world.fake.issuer, clientId: world.tool.clientId },
      contextId: context.contextId,
      nrps: { membershipsUrl: `${context.membershipsUrl}?limit=2` },
    };
    const projection = await nrps.rosterProjection(services);
    expect(projection.offeringId).toBe(BIO);
    expect(projection.members).toHaveLength(7);
    expect(projection.members.map((m) => m.identity.subject)).toContain(world.fake.userOf(STUDENT).sub);
    expect(world.fake.requestsTo(new URL(context.membershipsUrl).pathname)).toHaveLength(4);
  });

  it("creates an AGS line item and passes a teacher-approved grade back as a score", async () => {
    const world = await createWorld(flavour);
    const launch = (await (await browserLaunch(world, { personId: STUDENT })).json()) as { accepted: ResolvedLaunch };
    const services = launch.accepted.services!;
    const ags = new AgsClient({ services: world.services, registrations: world.registrations });
    const column = await ags.createLineItem(services, { label: "Cell lab report", scoreMaximum: 10, resourceId: "act_cell-lab" });
    expect(world.fake.lineItem(column.id)?.item).toMatchObject({ label: "Cell lab report", scoreMaximum: 10 });
    expect((await ags.listLineItems(services, { resourceId: "act_cell-lab" })).map((item) => item.id)).toEqual([column.id]);

    const approvals = new InMemoryGradeApprovalStore();
    const passback = new GradePassback({
      districtId: NF,
      directory: async () => world.directory,
      routes: new InMemoryGradeRouteStore([{ offeringId: BIO, authority: `lms:${name}`, via: "lti-ags", services }]),
      approvals,
      ledger: new InMemoryPassbackLedger(),
      sinks: [new LtiAgsGradeSink({ services: world.services, registrations: world.registrations })],
      now: world.clock.now,
    });
    const approved = {
      offeringId: BIO,
      studentId: AMARA,
      column: column.id,
      gradeVersion: 1,
      scoreGiven: 8,
      scoreMaximum: 10,
      approverId: MORGAN,
      approvedAt: new Date(world.clock.now() - 5 * 60_000).toISOString(),
    };
    approvals.record(approved);
    const { approverId: _approver, approvedAt: _at, ...request } = approved;
    expect(await passback.publish(request)).toEqual({ status: "posted", route: "lti-ags" });
    expect(world.fake.scores).toEqual([
      {
        lineItem: column.id,
        score: { userId: world.fake.userOf(STUDENT).sub, scoreGiven: 8, scoreMaximum: 10, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: approved.approvedAt },
      },
    ]);
    expect(await ags.readResults(services, column.id, world.fake.userOf(STUDENT).sub)).toMatchObject([{ resultScore: 8, resultMaximum: 10 }]);
  });

  it("reports a rate-limited token endpoint and an unreachable JWKS as unavailable", async () => {
    const world = await createWorld(flavour);
    const [registration] = await world.registrations.listByIssuer(world.fake.issuer);
    world.fake.inject({ kind: "rate-limit", retryAfterSeconds: 30, times: 1, match: { path: new URL(world.fake.flavour.tokenEndpoint).pathname } });
    expect(await rejection(world.services.accessToken(registration!, [LTI_SCOPES.score]))).toBe("unavailable");
    await expect(world.services.accessToken(registration!, [LTI_SCOPES.score])).resolves.toMatch(/at-/);

    world.fake.inject({ kind: "outage", status: 503, match: { path: new URL(world.fake.flavour.jwksUri).pathname } });
    const response = await browserLaunch(world, { personId: STUDENT });
    expect(response.status).toBe(503);
  });
});

describe("@educateos/lti Dynamic Registration against the Canvas platform fake", () => {
  async function register(options: { registrationDeploymentId?: "top-level" | "tool-configuration" } = {}) {
    const clock = new TestClock();
    const toolKeys = createToolKeySet(await importToolKey(await generateToolKey()));
    const invitations = new InMemorySingleUseStore<RegistrationInvitation>(clock.now);
    const pending = new InMemoryPendingRegistrationStore();
    let toolHandler: (request: Request) => Promise<Response | undefined> = async () => undefined;
    // The platform fetches the tool's JWKS from the tool itself.
    const fake = await LtiPlatformFake.create({
      flavour: flavours[0]![1](),
      seed: SAMPLE_DISTRICT,
      now: clock.now,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => (await toolHandler(new Request(input, init))) ?? new Response(null, { status: 404 })) as typeof fetch,
      ...options,
    });
    const dynamicRegistration = new DynamicRegistration({ toolOrigin: TOOL, toolName: "EducateOS", invitations, pending, fetch: fake.fetch, now: clock.now });
    const broker = new LtiBroker({
      toolOrigin: TOOL,
      registrations: new InMemoryPlatformRegistrationStore([]),
      loginStates: new InMemorySingleUseStore<LoginState>(clock.now),
      deepLinkSessions: new InMemorySingleUseStore<DeepLinkSession>(clock.now),
      platformKeys: new PlatformJwksCache({ fetch: fake.fetch, now: clock.now }),
      toolKeys: () => toolKeys,
      principalResolver: async () => undefined,
      now: clock.now,
    });
    const handler = createLtiHandler({
      broker,
      dynamicRegistration,
      onResourceLinkLaunch: async () => new Response(null),
      onDeepLinkingRequest: async () => new Response(null),
      selectActivities: async () => [],
    });
    toolHandler = handler;
    const { url } = await dynamicRegistration.issueInvitation(NF, PrincipalId.parse("prn_nf-district-admin"));
    const opened = fake.registrationInitiation(url);
    const response = (await handler(new Request(opened.url)))!;
    return { clock, fake, pending, response, toolKeys };
  }

  it("registers from Canvas's own answer, which puts deployment_id at the top level", async () => {
    const { fake, pending, response } = await register();
    expect(fake.dynamicRegistrations).toHaveLength(1);
    expect(response.status).toBe(200);
    const [received] = await pending.list();
    expect(received).toMatchObject({ clientId: fake.dynamicRegistrations[0]!.tool.clientId, deploymentId: fake.dynamicRegistrations[0]!.tool.deploymentIds[0] });
  });

  it("registers when the deployment is in the tool configuration, and the tool can then get a token", async () => {
    const { clock, fake, pending, response, toolKeys } = await register({ registrationDeploymentId: "tool-configuration" });
    expect(response.status).toBe(200);
    const [received] = await pending.list();
    const tool = fake.dynamicRegistrations[0]!.tool;
    expect(received).toMatchObject({
      issuer: fake.issuer,
      clientId: tool.clientId,
      deploymentId: tool.deploymentIds[0],
      authLoginUrl: fake.flavour.authorizationEndpoint,
      authTokenUrl: fake.flavour.tokenEndpoint,
      jwksUrl: fake.flavour.jwksUri,
      productFamily: "canvas",
    });
    expect(fake.dynamicRegistrations[0]!.metadata).toMatchObject({ jwks_uri: `${TOOL}/lti/jwks`, token_endpoint_auth_method: "private_key_jwt" });
    expect(tool.scopes).toEqual([LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score, LTI_SCOPES.contextMembershipReadonly]);

    const registration = approvedRegistration(received!, { provider: "canvas", offerings: [{ contextId: fake.contextOf(SECTION).contextId, offeringId: BIO }] });
    const services = new LtiServiceClient({ fetch: fake.fetch, toolKeys: () => toolKeys, now: clock.now });
    await expect(services.accessToken(registration, [LTI_SCOPES.score])).resolves.toMatch(/at-/);
  });
});
