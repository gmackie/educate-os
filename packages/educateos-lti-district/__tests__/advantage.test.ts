// The district's LTI Advantage operations (SCHO-177): trusting a platform issuer, identity link
// requests, AGS line items, NRPS roster reads, a teacher publishing their own approved grade, and
// tool key rotation, each decided by the policy engine.
import { describe, expect, it } from "vitest";
import type { PendingIdentityLink } from "@educateos/identity";
import type { LtiContextServices, NewLineItem } from "@educateos/lti";
import { LtiAdvantageService, OfficialGradeApprovals } from "../src/index.ts";
import {
  ADMIN,
  AMARA,
  as,
  BIO,
  BIO_CONTEXT,
  canvasRegistration,
  createDistrict,
  gradedBiology,
  MORGAN,
  NF,
  NF_CANVAS,
  rejection,
  SCHOOL_ADMIN,
  SUBJECTS,
} from "./setup.ts";

const CLIENT = "10000000000001";
const SERVICES: LtiContextServices = {
  registration: { issuer: NF_CANVAS, clientId: CLIENT },
  contextId: BIO_CONTEXT,
  ags: { scopes: [], lineItemsUrl: `${NF_CANVAS}/api/lti/courses/1/line_items` },
  nrps: { membershipsUrl: `${NF_CANVAS}/api/lti/courses/1/names_and_roles` },
};
const CONTEXT = { offeringId: BIO, issuer: NF_CANVAS, clientId: CLIENT, contextId: BIO_CONTEXT };
const COLUMN = `${NF_CANVAS}/api/lti/courses/1/line_items/7`;

async function setup() {
  const district = createDistrict();
  await district.stores.registrations.save(canvasRegistration());
  await district.stores.contextServices.record({ offeringId: BIO, services: SERVICES, observedAt: "2026-10-21T09:00:00.000Z" });
  await district.assessments.commit(gradedBiology(), 0);
  await district.stores.gradeColumns.bind({ offeringId: BIO, column: COLUMN, assignmentId: "asg_cell-lab" as never });
  const created: NewLineItem[] = [];
  const published: unknown[] = [];
  const links: PendingIdentityLink[] = [];
  const advantage = new LtiAdvantageService({
    districtId: NF,
    authorizer: district.engine,
    directory: district.academics,
    registrations: district.stores.registrations,
    pending: district.stores.pendingRegistrations,
    contextServices: district.stores.contextServices,
    lineItems: {
      createLineItem: async (_services, input) => {
        created.push(input);
        return { id: COLUMN, label: input.label, scoreMaximum: input.scoreMaximum };
      },
    },
    roster: {
      rosterProjection: async (services) => ({
        districtId: NF,
        offeringId: BIO,
        source: { kind: "lti-nrps", issuer: NF_CANVAS, clientId: CLIENT, contextId: services.contextId },
        observedAt: "2026-10-21T09:00:00.000Z",
        members: [
          { identity: { districtId: NF, issuer: NF_CANVAS, subject: SUBJECTS[AMARA]! }, status: "active", untrustedPlatformRoles: ["Learner"] },
          { identity: { districtId: NF, issuer: NF_CANVAS, subject: "lti-stranger" }, status: "active", untrustedPlatformRoles: ["Instructor"] },
        ],
      }),
    },
    passback: {
      publish: async (input) => {
        published.push(input);
        return { status: "posted", route: "lti-ags" };
      },
    },
    approvals: new OfficialGradeApprovals({ districtId: NF, columns: district.stores.gradeColumns, assessments: district.assessments }),
    toolKeys: district.stores.toolKeys,
    requestIdentityLink: async (link) => {
      links.push(link);
      return "idr_1";
    },
    now: () => new Date(district.clock.ms),
  });
  return { district, advantage, created, published, links };
}

describe("LtiAdvantageService", () => {
  it("trusts a pending or registered platform's issuer once, for a district admin only", async () => {
    const { district, advantage } = await setup();
    const other = "https://canvas.other.example";
    expect(await rejection(advantage.trustPlatformIssuer(as(ADMIN), other))).toBe("not-found");
    await district.stores.pendingRegistrations.put({
      id: "lpr_otherCanvasPending000001" as never,
      districtId: NF,
      issuer: other,
      clientId: "20000000000002",
      deploymentId: "other-deploy-1",
      authLoginUrl: `${other}/api/lti/authorize_redirect`,
      authTokenUrl: `${other}/login/oauth2/token`,
      jwksUrl: `${other}/api/lti/security/jwks`,
      invitedBy: ADMIN,
      receivedAt: "2026-10-21T09:00:00.000Z",
    });
    expect(await rejection(advantage.trustPlatformIssuer(as(MORGAN), other))).toBe("forbidden");
    expect(await rejection(advantage.trustPlatformIssuer(as(ADMIN), "http://insecure.example"))).toBe("validation-failed");

    const before = (await district.academics.load()).version;
    expect(await advantage.trustPlatformIssuer(as(ADMIN), other)).toContain(other);
    expect(await advantage.trustPlatformIssuer(as(ADMIN), other)).toContain(other);
    const after = await district.academics.load();
    expect(after.version).toBe(before + 1);
    expect(after.snapshot.district.trustedIssuers.filter((issuer) => issuer === other)).toHaveLength(1);
  });

  it("records an identity link request for a registered platform's subject", async () => {
    const { advantage, links } = await setup();
    const input = { issuer: NF_CANVAS, subject: "canvas-sub-9", principalId: AMARA };
    expect(await rejection(advantage.requestIdentityLink(as(MORGAN), input))).toBe("forbidden");
    expect(await rejection(advantage.requestIdentityLink(as(ADMIN), { ...input, issuer: "https://canvas.other.example" }))).toBe("not-found");
    expect(await advantage.requestIdentityLink(as(ADMIN), input)).toBe("idr_1");
    expect(links).toEqual([{
      districtId: NF,
      principalId: AMARA,
      identity: { districtId: NF, issuer: NF_CANVAS, subject: "canvas-sub-9" },
      credential: "person",
      requestedAt: "2026-10-21T09:00:00.000Z",
    }]);
  });

  it("creates a line item only in a connected context that reported AGS, for offering administrators", async () => {
    const { district, advantage, created } = await setup();
    const input = { ...CONTEXT, label: "Cell lab", scoreMaximum: 10 };
    expect(await rejection(advantage.createLineItem(as(MORGAN), input))).toBe("forbidden");
    expect(await rejection(advantage.createLineItem(as(ADMIN), { ...input, contextId: "nf-canvas-course-unmapped" }))).toBe("not-found");
    expect(await advantage.createLineItem(as(ADMIN), input)).toEqual({ id: COLUMN, label: "Cell lab", scoreMaximum: 10 });
    expect(created).toEqual([{ label: "Cell lab", scoreMaximum: 10 }]);

    await district.stores.contextServices.record({
      offeringId: BIO,
      services: { registration: SERVICES.registration, contextId: BIO_CONTEXT },
      observedAt: "2026-10-22T09:00:00.000Z",
    });
    expect(await rejection(advantage.createLineItem(as(ADMIN), input))).toBe("conflict");
  });

  it("reads a roster matched to identity links, without writing anything", async () => {
    const { district, advantage } = await setup();
    const before = (await district.academics.load()).version;
    expect(await rejection(advantage.readRoster(as(AMARA), CONTEXT))).toBe("forbidden");
    const read = await advantage.readRoster(as(ADMIN), CONTEXT);
    expect(read.members).toEqual([
      { subject: SUBJECTS[AMARA], status: "active", principalId: AMARA, untrustedPlatformRoles: ["Learner"] },
      { subject: "lti-stranger", status: "active", principalId: null, untrustedPlatformRoles: ["Instructor"] },
    ]);
    expect((await district.academics.load()).version).toBe(before);
  });

  it("publishes a grade only for the teacher who approved it, with the approved score", async () => {
    const { advantage, published } = await setup();
    const grade = { offeringId: BIO, studentId: AMARA, column: COLUMN, gradeVersion: 1 };
    expect(await rejection(advantage.publishGrade(as(ADMIN), grade))).toBe("forbidden");
    expect(await rejection(advantage.publishGrade(as(MORGAN), { ...grade, gradeVersion: 2 }))).toBe("policy-violation");
    expect(await rejection(advantage.publishGrade(as(MORGAN), { ...grade, scoreGiven: 10 }))).toBe("validation-failed");
    expect(await advantage.publishGrade(as(MORGAN), grade)).toEqual({ status: "posted", route: "lti-ags" });
    expect(published).toEqual([{ ...grade, scoreGiven: 8, scoreMaximum: 10 }]);
  });

  it("rotates the tool's keys for a district admin, keeping the previous key published", async () => {
    const { advantage } = await setup();
    const [first] = await advantage.toolKeyIds(as(ADMIN));
    expect(await rejection(advantage.rotateToolKeys(as(SCHOOL_ADMIN)))).toBe("forbidden");
    const rotation = await advantage.rotateToolKeys(as(ADMIN));
    expect(await advantage.toolKeyIds(as(ADMIN))).toEqual([rotation.signingKid, first]);
  });
});
