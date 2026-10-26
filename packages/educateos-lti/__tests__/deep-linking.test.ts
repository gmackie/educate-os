import { describe, expect, it } from "vitest";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { EducateOsError } from "@educateos/contracts";
import { LTI_CLAIM, type ResolvedLaunch, STATE_COOKIE_BINDING } from "../src/index.ts";
import type { ClaimOverrides } from "./fake-platform.ts";
import { cookiePair, createWorld, formPost, startLogin, TOOL, type World } from "./helpers.ts";

const BIO = "nf-canvas-course-bio-p2";

/** A teacher's deep linking request through the handlers; returns the picker's session. */
async function deepLinkingRequest(world: World, overrides: ClaimOverrides = {}) {
  const platform = world.platforms.nfCanvas;
  const login = (await world.handler(
    new Request(`${TOOL}/lti/login?${new URLSearchParams({ iss: platform.issuer, client_id: platform.clientId, login_hint: "h", target_link_uri: `${TOOL}/lti/launch` })}`),
  ))!;
  const location = new URL(login.headers.get("location")!);
  const idToken = await platform.idToken({
    sub: "canvas-teacher-rivera",
    contextId: BIO,
    messageType: "LtiDeepLinkingRequest",
    nonce: location.searchParams.get("nonce")!,
    targetLinkUri: `${TOOL}/lti/launch`,
    overrides,
  });
  const response = (await world.handler(
    formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", location.searchParams.get("state")!]], cookiePair(login.headers.get("set-cookie"))),
  ))!;
  expect(response.status).toBe(200);
  return (await response.json()) as { picker: ResolvedLaunch; session: string };
}

const choose = (world: World, session: string, activities: string[]) =>
  world.handler(formPost(`${TOOL}/lti/deep-link`, [["session", session], ...activities.map((a): [string, string] => ["activity", a])]));

function returnedJwt(html: string): { action: string; jwt: string } {
  const action = /action="([^"]+)"/.exec(html)?.[1];
  const jwt = /name="JWT" value="([^"]+)"/.exec(html)?.[1];
  expect(action).toBeDefined();
  expect(jwt).toBeDefined();
  return { action: action!, jwt: jwt! };
}

/** A resource link launch of a deep-linked item, carrying the custom parameters the platform stored. */
async function launchItem(world: World, contextId: string, custom: Record<string, string>) {
  const platform = world.platforms.nfCanvas;
  const { state, nonce } = await startLogin(world, platform);
  const token = await platform.idToken({
    sub: "lti-user-0007",
    contextId,
    resourceLinkId: "canvas-generated-link-id",
    nonce,
    targetLinkUri: `${TOOL}/lti/launch`,
    overrides: { [LTI_CLAIM.custom]: custom },
  });
  return (await world.broker.launch(token, state, STATE_COOKIE_BINDING)).launch;
}

describe("Deep Linking 2.0", () => {
  it("returns a signed response the platform can verify, and the placed links launch their activities", async () => {
    const world = await createWorld();
    const { picker, session } = await deepLinkingRequest(world);
    expect(picker).toMatchObject({ messageType: "LtiDeepLinkingRequest", offeringId: "off_nf-bio-fall-p2", principal: { principalId: "prn_nf-teacher-rivera" } });

    const response = (await choose(world, session, ["act_cell-lab", "act_photosynthesis"]))!;
    expect(response.status).toBe(200);
    const { action, jwt } = returnedJwt(await response.text());
    expect(action).toBe("https://canvas.northfield.example/courses/1/deep_linking_response");

    // The platform verifies with the tool's published JWKS.
    const jwks = (await (await world.handler(new Request(`${TOOL}/lti/jwks`)))!.json()) as Parameters<typeof createLocalJWKSet>[0];
    const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet(jwks), {
      issuer: world.platforms.nfCanvas.clientId,
      audience: world.platforms.nfCanvas.issuer,
      algorithms: ["RS256"],
      currentDate: new Date(world.clock.ms),
    });
    expect(protectedHeader.kid).toBe(world.getToolKeys().signing.kid);
    expect(payload).toMatchObject({
      [LTI_CLAIM.messageType]: "LtiDeepLinkingResponse",
      [LTI_CLAIM.version]: "1.3.0",
      [LTI_CLAIM.deploymentId]: "nf-canvas-deploy-1",
      [LTI_CLAIM.data]: "opaque-platform-data",
    });
    expect(typeof payload.nonce).toBe("string");
    const items = payload[LTI_CLAIM.contentItems] as { type: string; url: string; title: string; custom: { educateos_link: string } }[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({ type: "ltiResourceLink", url: `${TOOL}/lti/launch` });
      // The platform sees an opaque link ID, never an activity ID.
      expect(item.custom.educateos_link).toMatch(/^dl-/);
      expect(JSON.stringify(item.custom)).not.toContain("act_");
    }

    const launched = await launchItem(world, BIO, { educateos_link: items[0]!.custom.educateos_link });
    expect(launched.activity).toBe("act_cell-lab");
    // An item the LMS kept from before the EducateOS rename names the parameter `schoolos_link` (SCHO-232). (rename-educateos: keep)
    expect((await launchItem(world, BIO, { schoolos_link: items[0]!.custom.educateos_link })).activity).toBe("act_cell-lab"); // rename-educateos: keep
  });

  it("does not resolve a deep-linked link ID copied into another offering's course", async () => {
    const world = await createWorld();
    const { session } = await deepLinkingRequest(world);
    const { jwt } = returnedJwt(await (await choose(world, session, ["act_cell-lab"]))!.text());
    const [item] = decodeJwt(jwt)[LTI_CLAIM.contentItems] as { custom: { educateos_link: string } }[];
    const elsewhere = await launchItem(world, "nf-canvas-course-eng9-p3", { educateos_link: item!.custom.educateos_link });
    expect(elsewhere.offeringId).toBe("off_nf-eng9-fall-p3");
    expect(elsewhere.activity).toBeUndefined();
    // Nor does a custom parameter that names an activity directly.
    expect((await launchItem(world, BIO, { educateos_link: "act_cell-lab" })).activity).toBeUndefined();
  });

  it("uses a deep linking session once", async () => {
    const world = await createWorld();
    const { session } = await deepLinkingRequest(world);
    expect((await choose(world, session, ["act_cell-lab"]))!.status).toBe(200);
    expect((await choose(world, session, ["act_cell-lab"]))!.status).toBe(401);
  });

  it("lets the host refuse a selection the principal may not place", async () => {
    const world = await createWorld({
      selectActivities: async () => {
        throw new EducateOsError("forbidden", "You cannot place that activity here.");
      },
    });
    const { session } = await deepLinkingRequest(world);
    const response = (await choose(world, session, ["act_cell-lab"]))!;
    expect(response.status).toBe(403);
  });

  it("honours accept_multiple and rejects malformed selections", async () => {
    const world = await createWorld();
    const settings = world.platforms.nfCanvas.claims({ sub: "x", nonce: "x", targetLinkUri: TOOL, messageType: "LtiDeepLinkingRequest" })[
      LTI_CLAIM.deepLinkingSettings
    ] as Record<string, unknown>;
    const { session } = await deepLinkingRequest(world, { [LTI_CLAIM.deepLinkingSettings]: { ...settings, accept_multiple: false } });
    expect((await choose(world, session, ["act_a", "act_b"]))!.status).toBe(400);

    const second = await deepLinkingRequest(world);
    expect((await choose(world, second.session, ["not-an-activity-id"]))!.status).toBe(400);
  });

  it("refuses a deep linking request without a usable return URL", async () => {
    const world = await createWorld();
    const settings = world.platforms.nfCanvas.claims({ sub: "x", nonce: "x", targetLinkUri: TOOL, messageType: "LtiDeepLinkingRequest" })[
      LTI_CLAIM.deepLinkingSettings
    ] as Record<string, unknown>;
    const platform = world.platforms.nfCanvas;
    const { state, nonce } = await startLogin(world, platform);
    const token = await platform.idToken({
      sub: "canvas-teacher-rivera",
      contextId: BIO,
      messageType: "LtiDeepLinkingRequest",
      nonce,
      targetLinkUri: `${TOOL}/lti/launch`,
      overrides: { [LTI_CLAIM.deepLinkingSettings]: { ...settings, deep_link_return_url: "javascript:alert(1)" } },
    });
    await expect(world.broker.launch(token, state, STATE_COOKIE_BINDING)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
