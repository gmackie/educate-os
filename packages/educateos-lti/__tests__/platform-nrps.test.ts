// The stateless parts of the LTI Platform's roster service (NRPS 2.0, SCHO-179): the membership URL
// names one deployment and one offering, the launch advertises it only when asked, the role filter
// reads LIS names or URIs, and refusals carry RFC 6750 challenges.
import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import {
  LTI_CLAIM,
  parsePlatformMembershipsPath,
  PLATFORM_LAUNCH_ROLE,
  platformLaunchClaims,
  platformMembershipResponse,
  platformMembershipsPath,
  platformRoleFilter,
  platformServiceRefusal,
  PlatformDeploymentId,
  type PlatformAuthRequest,
  type PlatformLaunchTicket,
} from "../src/index.ts";

const DEPLOYMENT = PlatformDeploymentId.parse("ltd_AbC-_09xyzXYZ012345678");
const OFFERING = OfferingId.parse("off_nf-bio-fall-p2");

describe("the platform's membership service", () => {
  it("round-trips its path, and nothing else parses as one", () => {
    const path = platformMembershipsPath(DEPLOYMENT, OFFERING);
    expect(path).toBe(`nrps/${DEPLOYMENT}/${OFFERING}/memberships`);
    expect(parsePlatformMembershipsPath(path)).toEqual({ deploymentId: DEPLOYMENT, offeringId: OFFERING });
    for (const other of [
      `nrps/${DEPLOYMENT}/${OFFERING}/memberships/`,
      `nrps/${DEPLOYMENT}/${OFFERING}`,
      `nrps/ltd_short/${OFFERING}/memberships`,
      `nrps/${DEPLOYMENT}/prn_nf-morgan-lee/memberships`,
      `nrps/${DEPLOYMENT}/${OFFERING}/../memberships`,
      "token",
    ]) {
      expect(parsePlatformMembershipsPath(other), other).toBeUndefined();
    }
  });

  it("filters by LIS role name or URI, and an unknown role matches nobody", () => {
    expect(platformRoleFilter(null)).toBeUndefined();
    expect(platformRoleFilter("Learner")).toBe(PLATFORM_LAUNCH_ROLE.learner);
    expect(platformRoleFilter(PLATFORM_LAUNCH_ROLE.instructor)).toBe(PLATFORM_LAUNCH_ROLE.instructor);
    for (const role of ["Mentor", "learner", "", "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor"]) expect(platformRoleFilter(role)).toBeNull();
  });

  it("answers with the container media type, no-store and a next link, and refuses with bearer challenges", async () => {
    const ok = platformMembershipResponse({ id: "https://d.example/m", context: { id: OFFERING }, members: [] }, "https://d.example/m?limit=1&page=2");
    expect(ok.headers.get("content-type")).toBe("application/vnd.ims.lti-nrps.v2.membershipcontainer+json");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("link")).toBe('<https://d.example/m?limit=1&page=2>; rel="next"');

    const invalid = platformServiceRefusal("invalid_token");
    expect([invalid.status, invalid.headers.get("www-authenticate")]).toEqual([401, 'Bearer error="invalid_token"']);
    const scope = platformServiceRefusal("insufficient_scope", "s");
    expect([scope.status, scope.headers.get("www-authenticate")]).toEqual([403, 'Bearer error="insufficient_scope", scope="s"']);
    const forbidden = platformServiceRefusal("forbidden");
    expect([forbidden.status, forbidden.headers.get("www-authenticate"), await forbidden.json()]).toEqual([403, null, { error: "forbidden" }]);
    expect(platformServiceRefusal("invalid_request").status).toBe(400);
  });

  it("is advertised by a launch only when the deployment allows it", () => {
    const ticket = {
      subject: "subject",
      toolId: "ltt_AbC-_09xyzXYZ012345678",
      deploymentId: DEPLOYMENT,
      offeringId: OFFERING,
      roles: [PLATFORM_LAUNCH_ROLE.learner],
      resourceLinkId: "link",
      targetLinkUri: "https://tool.example/launch",
    } as unknown as PlatformLaunchTicket;
    const request = { nonce: "n" } as PlatformAuthRequest;
    const context = { offeringTitle: "Biology I, Period 2", offeringLabel: "Biology I", person: { displayName: "Amara Okafor" }, privacy: { name: false, email: false } };
    expect(platformLaunchClaims(ticket, request, context)[LTI_CLAIM.nrpsService]).toBeUndefined();
    expect(platformLaunchClaims(ticket, request, { ...context, membershipsUrl: "https://d.example/m" })[LTI_CLAIM.nrpsService]).toEqual({
      context_memberships_url: "https://d.example/m",
      service_versions: ["2.0"],
    });
  });
});
