import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { ActivityId } from "@schoolos/contracts";
import { CANVAS_PLACEMENTS, canvasDeveloperKey, LTI_CLAIM, ltiToolEndpoints, type CanvasPlacement } from "../src/index.ts";
import developerKeyFixture from "./fixtures/canvas-developer-key.json" with { type: "json" };
import { canvasPlacementClaims } from "./fixtures/canvas-placements.ts";
import { createWorld, startLogin, TOOL } from "./helpers.ts";

describe("Canvas", () => {
  it("builds the developer key JSON documented in fixtures/canvas-developer-key.json", () => {
    expect(canvasDeveloperKey(ltiToolEndpoints(TOOL))).toEqual(developerKeyFixture);
  });

  it("refuses a tool origin that is not a bare https origin", () => {
    for (const origin of ["http://schoolos.example", "https://schoolos.example/", "https://schoolos.example/lti"]) {
      expect(() => ltiToolEndpoints(origin)).toThrow();
    }
  });

  for (const placement of Object.keys(CANVAS_PLACEMENTS) as CanvasPlacement[]) {
    it(`accepts a ${placement} launch, ignoring its role claims`, async () => {
      const world = await createWorld();
      const platform = world.platforms.nfCanvas;
      const { state, nonce } = await startLogin(world, platform);
      const messageType = CANVAS_PLACEMENTS[placement];
      const token = await platform.idToken({
        // A student, although Canvas's role claims say instructor: roles come from the directory.
        sub: "lti-user-0007",
        nonce,
        messageType,
        targetLinkUri: `${TOOL}/lti/launch`,
        overrides: canvasPlacementClaims(placement, "nf-canvas-course-bio-p2"),
      });
      const { launch, deepLinkSession } = await world.broker.launch(token, state);
      expect(launch).toMatchObject({ messageType, offeringId: "off_nf-bio-fall-p2", principal: { kind: "student" } });
      if (messageType === "LtiResourceLinkRequest") return expect(deepLinkSession).toBeUndefined();

      const result = await world.broker.completeDeepLink(deepLinkSession!, async () => [
        { activityId: ActivityId.parse("act_cell-lab"), title: "Cell lab" },
      ]);
      expect(result.returnUrl).toBe("https://canvas.northfield.example/courses/1/deep_linking_response?modal=true");
      expect(result.html).toContain('action="https://canvas.northfield.example/courses/1/deep_linking_response?modal=true"');
      expect(decodeJwt(result.jwt)[LTI_CLAIM.contentItems]).toHaveLength(1);
    });
  }
});
