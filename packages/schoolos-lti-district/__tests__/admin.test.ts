// The administrator's LTI service: registration approval through the policy engine (SCHO-59), the
// directory checks on save (SCHO-60), and grade routes built from launch-reported services (SCHO-76).
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@schoolos/fixtures";
import type { ResolvedLaunch } from "@schoolos/lti";
import { recordLaunchServices } from "../src/index.ts";
import {
  ADMIN,
  AMARA,
  as,
  BIO,
  BIO_CONTEXT,
  canvasRegistration,
  createDistrict,
  ENG9,
  MATH7,
  MORGAN,
  NF,
  NF_CANVAS,
  gradedBiology,
  rejection,
  SCHOOL_ADMIN,
  type District,
} from "./setup.ts";

/** Answers dynamic registration as Northfield's Canvas does. */
function canvasAnswers(district: District): void {
  district.platformFetch.handler = async (request) => {
    if (request.url === `${NF_CANVAS}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: NF_CANVAS,
        authorization_endpoint: `${NF_CANVAS}/api/lti/authorize_redirect`,
        token_endpoint: `${NF_CANVAS}/login/oauth2/token`,
        jwks_uri: `${NF_CANVAS}/api/lti/security/jwks`,
        registration_endpoint: `${NF_CANVAS}/api/lti/registrations`,
      });
    }
    if (request.url === `${NF_CANVAS}/api/lti/registrations`) {
      return Response.json({ client_id: "10000000000001", "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "nf-canvas-deploy-1" } });
    }
    return new Response(null, { status: 404 });
  };
}

async function registerCanvas(district: District) {
  canvasAnswers(district);
  const { url } = await district.admin.inviteRegistration(as(ADMIN));
  const target = new URL(url);
  target.searchParams.set("openid_configuration", `${NF_CANVAS}/.well-known/openid-configuration`);
  expect((await district.dynamicRegistration.handle(new Request(target))).status).toBe(200);
  const [pending] = await district.admin.listPendingRegistrations(as(ADMIN));
  return pending!;
}

const APPROVAL = { provider: "canvas", offerings: [{ contextId: BIO_CONTEXT, offeringId: BIO }] };

describe("LtiAdminService registrations (SCHO-59)", () => {
  it("lets a district admin approve a pending registration with its offering mappings", async () => {
    const district = createDistrict();
    const pending = await registerCanvas(district);
    expect(await district.admin.listRegistrations(as(ADMIN))).toEqual([]);

    const registration = await district.admin.approveRegistration(as(ADMIN), pending.id, APPROVAL);
    expect(registration).toMatchObject({ districtId: NF, provider: "canvas", deploymentIds: ["nf-canvas-deploy-1"], offerings: APPROVAL.offerings });
    expect(await district.admin.listRegistrations(as(ADMIN))).toEqual([registration]);
    expect(await district.admin.listPendingRegistrations(as(ADMIN))).toEqual([]);
    // Every decision went through the policy engine and was audited.
    expect(district.audit.some((event) => event.principalId === ADMIN && event.resourceKind === "district" && event.effect === "allow")).toBe(true);
  });

  it("refuses everyone but a district admin, by policy", async () => {
    const district = createDistrict();
    const pending = await registerCanvas(district);
    for (const principal of [SCHOOL_ADMIN, MORGAN, AMARA]) {
      expect(await rejection(district.admin.inviteRegistration(as(principal)))).toBe("forbidden");
      expect(await rejection(district.admin.listPendingRegistrations(as(principal)))).toBe("forbidden");
      expect(await rejection(district.admin.approveRegistration(as(principal), pending.id, APPROVAL))).toBe("forbidden");
      expect(await rejection(district.admin.rejectRegistration(as(principal), pending.id))).toBe("forbidden");
    }
    expect(await district.admin.listPendingRegistrations(as(ADMIN))).toHaveLength(1);
    expect(district.audit.filter((event) => event.effect === "deny").length).toBeGreaterThanOrEqual(12);
  });

  it("keeps a registration pending when its mappings name an unknown offering or activity", async () => {
    const district = createDistrict();
    const pending = await registerCanvas(district);
    const ghost = { provider: "canvas", offerings: [{ contextId: "c", offeringId: "off_nf-ghost" }] };
    expect(await rejection(district.admin.approveRegistration(as(ADMIN), pending.id, ghost))).toBe("not-found");
    const badLink = { ...APPROVAL, activityLinks: [{ offeringId: BIO, linkId: "rl-1", activityId: "act_eng9-essay" }] };
    expect(await rejection(district.admin.approveRegistration(as(ADMIN), pending.id, badLink))).toBe("not-found");
    expect(await rejection(district.admin.approveRegistration(as(ADMIN), pending.id, { ...APPROVAL, extra: 1 }))).toBe("validation-failed");
    expect(await district.admin.listPendingRegistrations(as(ADMIN))).toHaveLength(1);
    expect(await district.admin.listRegistrations(as(ADMIN))).toEqual([]);
  });

  it("refuses to approve a platform whose issuer the district does not trust", async () => {
    // Plain Northfield: nobody is linked to Canvas, and its issuer is not trusted.
    const district = createDistrict(NORTHFIELD);
    const pending = await registerCanvas(district);
    expect(await rejection(district.admin.approveRegistration(as(ADMIN), pending.id, APPROVAL))).toBe("conflict");
  });

  it("rejects a pending registration", async () => {
    const district = createDistrict();
    const pending = await registerCanvas(district);
    await district.admin.rejectRegistration(as(ADMIN), pending.id);
    expect(await district.admin.listPendingRegistrations(as(ADMIN))).toEqual([]);
    expect(await rejection(district.admin.rejectRegistration(as(ADMIN), pending.id))).toBe("not-found");
    expect(await rejection(district.admin.approveRegistration(as(ADMIN), pending.id, APPROVAL))).toBe("not-found");
  });
});

const launchFrom = (contextId: string, ags: boolean): ResolvedLaunch => ({
  principal: { districtId: NF, principalId: MORGAN, kind: "staff", identity: { districtId: NF, issuer: NF_CANVAS, subject: "lti-morgan" } },
  offeringId: BIO,
  messageType: "LtiResourceLinkRequest",
  services: {
    registration: { issuer: NF_CANVAS, clientId: "10000000000001" },
    contextId,
    ...(ags ? { ags: { scopes: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"], lineItemsUrl: `${NF_CANVAS}/api/lti/courses/1/line_items` } } : {}),
    nrps: { membershipsUrl: `${NF_CANVAS}/api/lti/courses/1/names_and_roles` },
  },
});

async function withCanvas() {
  const district = createDistrict();
  await district.stores.registrations.save(canvasRegistration());
  return district;
}

describe("LtiAdminService grade routes (SCHO-76)", () => {
  it("builds an LTI grade route from the services a launch reported", async () => {
    const district = await withCanvas();
    const route = { offeringId: BIO, issuer: NF_CANVAS, clientId: "10000000000001", contextId: BIO_CONTEXT };
    expect(await rejection(district.admin.routeGradesToPlatform(as(ADMIN), route))).toBe("conflict");

    await recordLaunchServices(district.stores.contextServices, launchFrom(BIO_CONTEXT, true), district.clock.now);
    expect(await district.admin.listContextServices(as(ADMIN), BIO)).toHaveLength(1);
    const built = await district.admin.routeGradesToPlatform(as(ADMIN), route);
    expect(built).toEqual({ offeringId: BIO, authority: "lms:canvas", via: "lti-ags", services: launchFrom(BIO_CONTEXT, true).services });
    expect(await district.stores.gradeRoutes.routeFor(BIO)).toEqual(built);

    await district.admin.keepGradesLocal(as(ADMIN), BIO);
    expect(await district.stores.gradeRoutes.routeFor(BIO)).toEqual({ offeringId: BIO, authority: "local" });
  });

  it("refuses a context without AGS, and one the registration maps to another offering", async () => {
    const district = await withCanvas();
    await recordLaunchServices(district.stores.contextServices, launchFrom(BIO_CONTEXT, false), district.clock.now);
    const route = { offeringId: BIO, issuer: NF_CANVAS, clientId: "10000000000001", contextId: BIO_CONTEXT };
    expect(await rejection(district.admin.routeGradesToPlatform(as(ADMIN), route))).toBe("conflict");
    expect(await rejection(district.admin.routeGradesToPlatform(as(ADMIN), { ...route, offeringId: ENG9 }))).toBe("not-found");
  });

  it("lets a school admin route their school's offerings, and nobody else", async () => {
    const district = await withCanvas();
    await district.admin.keepGradesLocal(as(SCHOOL_ADMIN), BIO);
    // Math 7 is the middle school's; the high school's principal cannot configure it.
    expect(await rejection(district.admin.keepGradesLocal(as(SCHOOL_ADMIN), MATH7))).toBe("forbidden");
    expect(await rejection(district.admin.keepGradesLocal(as(MORGAN), BIO))).toBe("forbidden");
    // Amara may read her own offering, but not its configuration.
    expect(await rejection(district.admin.listContextServices(as(AMARA), BIO))).toBe("forbidden");
    expect(await rejection(district.admin.keepGradesLocal(as(ADMIN), "off_nf-ghost"))).toBe("forbidden");
  });

  it("binds a column only to an assignment of the same offering", async () => {
    const district = await withCanvas();
    await district.assessments.commit(gradedBiology(), 0);
    const column = `${NF_CANVAS}/api/lti/courses/1/line_items/7`;
    expect(await rejection(district.admin.bindGradeColumn(as(ADMIN), { offeringId: ENG9, column, assignmentId: "asg_cell-lab" }))).toBe("not-found");
    expect(await rejection(district.admin.bindGradeColumn(as(MORGAN), { offeringId: BIO, column, assignmentId: "asg_cell-lab" }))).toBe("forbidden");
    await district.admin.bindGradeColumn(as(ADMIN), { offeringId: BIO, column, assignmentId: "asg_cell-lab" });
    expect(await district.stores.gradeColumns.assignmentFor(BIO, column)).toBe("asg_cell-lab");
  });

  it("records services from a launch only for the launch's own offering", async () => {
    const district = await withCanvas();
    await recordLaunchServices(district.stores.contextServices, { ...launchFrom(BIO_CONTEXT, true), services: undefined }, district.clock.now);
    expect(await district.stores.contextServices.list(BIO)).toEqual([]);
    await recordLaunchServices(district.stores.contextServices, launchFrom(BIO_CONTEXT, true), district.clock.now);
    expect(await district.stores.contextServices.list(ENG9)).toEqual([]);
  });
});
