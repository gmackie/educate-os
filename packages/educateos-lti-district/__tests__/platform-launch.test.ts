// Launching a third-party tool from EducateOS as an LTI Platform (SCHO-179), against the fake tool
// in `@educateos/provider-fakes`: a person actively enrolled in a deployed offering starts the
// launch, the tool's authentication request redeems its single-use, browser-bound ticket, and the
// tool verifies a signed id_token that carries an opaque per-tool subject, the person's LIS role,
// the offering alone as context, and a name or email only when the deployment allows each.
import { describe, expect, it } from "vitest";
import { PLATFORM_LAUNCH_ROLE, PlatformLaunchTicket, toolJwks, LTI_CLAIM } from "@educateos/lti";
import { FakeLtiTool, FakeLtiToolError } from "@educateos/provider-fakes";
import {
  LtiPlatformLaunchService,
  LtiPlatformToolService,
  PLATFORM_LAUNCH_COLLECTIONS,
  PLATFORM_LAUNCH_TICKET_TTL_MS,
  TablePlatformSubjectStore,
  TablePlatformToolStore,
  TableSingleUseStore,
} from "../src/index.ts";
import { ADMIN, AMARA, as, BIO, createDistrict, DMITRI, ENG9, MORGAN, NF, rejection, RIVERA, TOOL } from "./setup.ts";

const AUTH_URL = `${TOOL}/lti/platform/auth`;

async function platform() {
  const district = createDistrict();
  const tools = new TablePlatformToolStore(district.table);
  const admin = new LtiPlatformToolService({ districtId: NF, authorizer: district.engine, directory: district.loadDirectory, store: tools, now: district.clock.now });
  const subjects = new TablePlatformSubjectStore(district.table);
  const keys = district.stores.platformKeys;
  const launches = new LtiPlatformLaunchService({
    districtId: NF,
    issuer: TOOL,
    authorizer: district.engine,
    directory: district.loadDirectory,
    tools,
    keys,
    tickets: new TableSingleUseStore(district.table, PLATFORM_LAUNCH_COLLECTIONS.tickets, PlatformLaunchTicket, district.clock.now),
    subjects,
    now: district.clock.now,
  });
  const fakeTool = async (origin: string) => {
    const fake = await FakeLtiTool.create({ origin, platformIssuer: TOOL, platformAuthUrl: AUTH_URL, platformJwks: async () => toolJwks(await keys.keySet()), now: district.clock.now });
    const tool = await admin.registerTool(as(ADMIN), fake.registration());
    fake.clientId = tool.id;
    const deployment = await admin.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO] });
    fake.deploymentIds.push(deployment.id);
    return { fake, tool, deployment };
  };
  const notebook = await fakeTool("https://notebook.example");
  return { district, admin, subjects, launches, keys, fakeTool, ...notebook };
}

type Platform = Awaited<ReturnType<typeof platform>>;

/** Starts a launch and returns the parameters of the tool's authentication request. */
async function startLogin(p: Platform, principal = AMARA, offeringId: string = BIO, deploymentId: string = p.deployment.id) {
  const started = await p.launches.start(as(principal), { deploymentId, offeringId });
  const params = Object.fromEntries(new URL(p.fake.initiateLogin(started.loginUrl)).searchParams);
  return { started, params };
}

/** A whole launch, from the person's start to the tool's verified id_token. */
async function launch(p: Platform, principal = AMARA) {
  const { started, params } = await startLogin(p, principal);
  const form = await p.launches.authorize(params, started.binding);
  expect(form.action).toBe(p.fake.launchUrl);
  return p.fake.receiveLaunch(form.fields);
}

describe("LtiPlatformLaunchService", () => {
  it("launches the tool for a student and a teacher of the offering, which verifies the signed id_token", async () => {
    const p = await platform();
    const student = await launch(p, AMARA);
    expect(student.claims.iss).toBe(TOOL);
    expect(student.claims.aud).toBe(p.tool.id);
    expect(student.deploymentId).toBe(p.deployment.id);
    expect(student.contextId).toBe(BIO);
    expect(student.claims[LTI_CLAIM.context]).toEqual({
      id: BIO,
      label: "Biology I",
      title: "Biology I, Period 2",
      type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"],
    });
    expect(student.roles).toEqual([PLATFORM_LAUNCH_ROLE.learner]);
    expect((await launch(p, MORGAN)).roles).toEqual([PLATFORM_LAUNCH_ROLE.instructor]);
  });

  it("gives each person an opaque subject per tool and shares no name or email unless the deployment allows it", async () => {
    const p = await platform();
    const first = await launch(p, AMARA);
    expect(first.claims.sub).not.toContain("amara");
    expect(first.claims).not.toHaveProperty("name");
    expect(first.claims).not.toHaveProperty("email");
    expect((await launch(p, AMARA)).claims.sub).toBe(first.claims.sub);
    expect(await p.subjects.principalFor(p.tool.id, first.claims.sub!)).toBe(AMARA);

    // Another tool sees another subject for the same person.
    const other = await p.fakeTool("https://quiz.example");
    const started = await p.launches.start(as(AMARA), { deploymentId: other.deployment.id, offeringId: BIO });
    const params = Object.fromEntries(new URL(other.fake.initiateLogin(started.loginUrl)).searchParams);
    const otherLaunch = await other.fake.receiveLaunch((await p.launches.authorize(params, started.binding)).fields);
    expect(otherLaunch.claims.sub).not.toBe(first.claims.sub);
    expect(await p.subjects.principalFor(p.tool.id, otherLaunch.claims.sub!)).toBeUndefined();

    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { privacy: { name: true, email: false } });
    const named = await launch(p, AMARA);
    expect(named.claims).toMatchObject({ name: "Amara Okafor", given_name: "Amara", family_name: "Okafor" });
    expect(named.claims).not.toHaveProperty("email");
    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { privacy: { name: false, email: true } });
    const emailed = await launch(p, AMARA);
    expect(emailed.claims.email).toBe("family.okafor@northfield.example");
    expect(emailed.claims).not.toHaveProperty("name");
  });

  it("refuses to start a launch outside an active enrollment in a deployed offering, alike", async () => {
    const p = await platform();
    // Rivera teaches English 9, not Biology; the district admin is enrolled in neither.
    expect(await rejection(p.launches.start(as(RIVERA), { deploymentId: p.deployment.id, offeringId: BIO }))).toBe("forbidden");
    expect(await rejection(p.launches.start(as(ADMIN), { deploymentId: p.deployment.id, offeringId: BIO }))).toBe("forbidden");
    // Amara is in English 9, but the tool is not deployed there.
    expect(await rejection(p.launches.start(as(AMARA), { deploymentId: p.deployment.id, offeringId: ENG9 }))).toBe("forbidden");
    // Deployed there, Dmitri's English 9 enrollment is inactive.
    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { offerings: [BIO, ENG9] });
    expect(await rejection(p.launches.start(as(DMITRI), { deploymentId: p.deployment.id, offeringId: ENG9 }))).toBe("forbidden");
    expect(await rejection(p.launches.start(as(AMARA), { deploymentId: "ltd_0000000000000000000000", offeringId: BIO }))).toBe("forbidden");
    expect(await rejection(p.launches.start(as(AMARA), { deploymentId: p.deployment.id, offeringId: "off_other-district" }))).toBe("forbidden");
    await p.admin.revokeDeployment(as(ADMIN), p.deployment.id);
    expect(await rejection(p.launches.start(as(AMARA), { deploymentId: p.deployment.id, offeringId: BIO }))).toBe("forbidden");
  });

  it("redeems a ticket once, only from the browser that started it", async () => {
    const p = await platform();
    const { started, params } = await startLogin(p);
    expect(await rejection(p.launches.authorize(params, undefined))).toBe("forbidden");
    // The failed attempt used the ticket up: even the right browser cannot redeem it now.
    expect(await rejection(p.launches.authorize(params, started.binding))).toBe("forbidden");

    const second = await startLogin(p);
    expect(await rejection(p.launches.authorize(second.params, "another-browser"))).toBe("forbidden");

    const third = await startLogin(p);
    const form = await p.launches.authorize(third.params, third.started.binding);
    expect(await rejection(p.launches.authorize(third.params, third.started.binding))).toBe("forbidden");
    await p.fake.receiveLaunch(form.fields);
  });

  it("refuses an authentication request that does not match the ticket and the tool's registration", async () => {
    const p = await platform();
    const other = await p.fakeTool("https://quiz.example");
    const cases: [string, (params: Record<string, string>) => Record<string, string>][] = [
      ["an unregistered redirect URI", (params) => ({ ...params, redirect_uri: "https://notebook.example/lti/elsewhere" })],
      ["another tool's client ID", (params) => ({ ...params, client_id: other.tool.id })],
      ["another subject", (params) => ({ ...params, login_hint: "someone-else" })],
      ["an unknown ticket", (params) => ({ ...params, lti_message_hint: "not-a-ticket" })],
    ];
    for (const [, tamper] of cases) {
      const { started, params } = await startLogin(p);
      expect(await rejection(p.launches.authorize(tamper(params), started.binding))).toBe("forbidden");
    }
    for (const malformed of [{ response_type: "code" }, { prompt: "login" }, { nonce: "" }, { client_id: "not-a-tool" }]) {
      const { started, params } = await startLogin(p);
      expect(await rejection(p.launches.authorize({ ...params, ...malformed }, started.binding))).toBe("validation-failed");
    }
  });

  it("refuses an expired ticket, and one whose tool was revoked after the launch started", async () => {
    const p = await platform();
    const late = await startLogin(p);
    p.district.clock.ms += PLATFORM_LAUNCH_TICKET_TTL_MS + 1;
    expect(await rejection(p.launches.authorize(late.params, late.started.binding))).toBe("forbidden");

    const revoked = await startLogin(p);
    await p.admin.revokeTool(as(ADMIN), p.tool.id);
    expect(await rejection(p.launches.authorize(revoked.params, revoked.started.binding))).toBe("forbidden");
  });

  it("is refused by the tool when signed by a key the platform does not publish, or for another tool", async () => {
    const p = await platform();
    const { started, params } = await startLogin(p);
    const form = await p.launches.authorize(params, started.binding);
    // A rotation that kept no retired key would leave the token's key unpublished.
    await p.keys.rotate(0);
    await expect(p.fake.receiveLaunch(form.fields)).rejects.toThrow(FakeLtiToolError);

    const other = await p.fakeTool("https://quiz.example");
    const next = await startLogin(p);
    const nextForm = await p.launches.authorize(next.params, next.started.binding);
    await expect(other.fake.receiveLaunch(nextForm.fields)).rejects.toThrow(/unknown state/);
  });
});
