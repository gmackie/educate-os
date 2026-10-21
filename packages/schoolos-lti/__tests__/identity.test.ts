import { describe, expect, it } from "vitest";
import { LTI_CLAIM } from "../src/index.ts";
import type { ClaimOverrides, FakePlatform } from "./fake-platform.ts";
import { createWorld, rejection, SHARED_SUB, startLogin, TOOL, type World } from "./helpers.ts";

async function launch(world: World, platform: FakePlatform, sub: string, contextId: string, overrides: ClaimOverrides = {}) {
  const { state, nonce } = await startLogin(world, platform);
  const idToken = await platform.idToken({ sub, contextId, nonce, targetLinkUri: `${TOOL}/lti/launch`, overrides });
  return (await world.broker.launch(idToken, state)).launch;
}

const ROLE = "http://purl.imsglobal.org/vocab/lis/v2/";

describe("launch identity", () => {
  it("ignores email, name and role claims that try to escalate a student", async () => {
    const world = await createWorld();
    const resolved = await launch(world, world.platforms.nfCanvas, SHARED_SUB, "nf-canvas-course-bio-p2", {
      email: "avery.admin@northfield.example",
      name: "Avery Admin",
      given_name: "Avery",
      "https://purl.imsglobal.org/spec/lti/claim/roles": [
        `${ROLE}institution/person#Administrator`,
        `${ROLE}membership#Instructor`,
        `${ROLE}system/person#SysAdmin`,
      ],
      [LTI_CLAIM.custom]: { principal_id: "prn_nf-district-admin", role: "district-admin", activity_id: "act_gradebook" },
      "https://purl.imsglobal.org/spec/lti/claim/lis": { person_sourcedid: "nf-0001" },
    });
    expect(resolved.principal).toMatchObject({ principalId: "prn_nf-student-amara", kind: "student" });
    // The launch carries no role, and a custom parameter cannot name an activity.
    expect(Object.keys(resolved).toSorted()).toEqual(["messageType", "offeringId", "principal"]);
  });

  it("does not resolve by email when the subject is unknown", async () => {
    const world = await createWorld();
    const attempt = launch(world, world.platforms.nfCanvas, "canvas-unlinked-user", "nf-canvas-course-bio-p2", {
      email: "avery.admin@northfield.example",
    });
    expect(await rejection(attempt)).toBe("unauthenticated");
  });

  it("maps the same sub from a different platform to a different principal", async () => {
    const world = await createWorld();
    const fromCanvas = await launch(world, world.platforms.nfCanvas, SHARED_SUB, "nf-canvas-course-bio-p2");
    const fromMoodle = await launch(world, world.platforms.nfMoodle, SHARED_SUB, "moodle-bio");
    expect(fromCanvas.principal.principalId).toBe("prn_nf-student-amara");
    expect(fromMoodle.principal.principalId).toBe("prn_nf-teacher-rivera");
    expect(fromCanvas.principal.identity.issuer).not.toBe(fromMoodle.principal.identity.issuer);
  });

  it("does not let one district's platform sign anyone into another district", async () => {
    const world = await createWorld();
    // Riverbend's Canvas knows Morgan Lee; Northfield's directory does not trust its issuer, and its
    // registration belongs to Riverbend, so the launch can only ever land in Riverbend.
    const resolved = await launch(world, world.platforms.rbCanvas, "canvas-teacher-morgan", "rb-canvas-course-bio-a");
    expect(resolved.principal).toMatchObject({ districtId: "dst_riverbend", principalId: "prn_rb-morgan-lee" });
    expect(await rejection(launch(world, world.platforms.rbCanvas, "canvas-teacher-rivera", "rb-canvas-course-bio-a"))).toBe(
      "unauthenticated",
    );
  });
});
