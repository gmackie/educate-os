import { describe, expect, it } from "vitest";
import { cookiePair, createWorld, formPost, SHARED_SUB, TOOL, type World } from "./helpers.ts";
import type { FakePlatform, LaunchClaimsInput } from "./fake-platform.ts";

/** Runs login initiation through the handler, as the platform's browser redirect would. */
async function handlerLogin(world: World, platform: FakePlatform) {
  const query = new URLSearchParams({
    iss: platform.issuer,
    client_id: platform.clientId,
    login_hint: "opaque-login-hint",
    lti_message_hint: "opaque-message-hint",
    lti_deployment_id: platform.deploymentId,
    target_link_uri: `${TOOL}/lti/launch`,
    canvas_region: "us-east-1",
  });
  const response = (await world.handler(new Request(`${TOOL}/lti/login?${query}`)))!;
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  return { location, cookie: cookiePair(response.headers.get("set-cookie")) };
}

async function launchThroughHandler(
  world: World,
  platform: FakePlatform,
  claims: Omit<LaunchClaimsInput, "nonce" | "targetLinkUri">,
) {
  const { location, cookie } = await handlerLogin(world, platform);
  const state = location.searchParams.get("state")!;
  const idToken = await platform.idToken({ ...claims, nonce: location.searchParams.get("nonce")!, targetLinkUri: `${TOOL}/lti/launch` });
  const request = () => formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state]], cookie);
  return { response: (await world.handler(request()))!, replay: () => world.handler(request()) };
}

describe("LTI launch (I01 acceptance)", () => {
  it("sends the browser to the platform's authorization endpoint with a fresh state and nonce", async () => {
    const world = await createWorld();
    const { location, cookie } = await handlerLogin(world, world.platforms.nfCanvas);
    expect(`${location.origin}${location.pathname}`).toBe(world.platforms.nfCanvas.authLoginUrl);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: "10000000000001",
      redirect_uri: `${TOOL}/lti/launch`,
      login_hint: "opaque-login-hint",
      lti_message_hint: "opaque-message-hint",
    });
    const state = location.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("nonce")).not.toBe(state);
    expect(cookie).toBe(`__Host-lti-state-${state}=1`);
  });

  it("resolves a signed launch to the right district, principal and offering, and a replay fails", async () => {
    const world = await createWorld();
    const { response, replay } = await launchThroughHandler(world, world.platforms.nfCanvas, {
      sub: SHARED_SUB,
      contextId: "nf-canvas-course-bio-p2",
      resourceLinkId: "rl-cell-lab",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: {
        principal: {
          districtId: "dst_northfield",
          principalId: "prn_nf-student-amara",
          kind: "student",
          identity: { districtId: "dst_northfield", issuer: "https://canvas.northfield.example", subject: SHARED_SUB },
        },
        offeringId: "off_nf-bio-fall-p2",
        activity: "act_cell-lab",
        messageType: "LtiResourceLinkRequest",
      },
    });
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    const replayed = (await replay())!;
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("resolves the same LTI subject on another district's platform to that district's principal", async () => {
    const world = await createWorld();
    const { response } = await launchThroughHandler(world, world.platforms.rbCanvas, {
      sub: SHARED_SUB,
      contextId: "rb-canvas-course-bio-a",
    });
    expect(await response.json()).toMatchObject({
      accepted: { principal: { districtId: "dst_riverbend", principalId: "prn_rb-student-ines" }, offeringId: "off_rb-bio-a" },
    });
  });

  it("opens the offering without an activity when the link is not configured", async () => {
    const world = await createWorld();
    const { response } = await launchThroughHandler(world, world.platforms.nfCanvas, {
      sub: "canvas-teacher-rivera",
      contextId: "nf-canvas-course-bio-p2",
      resourceLinkId: "rl-course-nav",
    });
    const body = (await response.json()) as { accepted: Record<string, unknown> };
    expect(body.accepted).toMatchObject({ offeringId: "off_nf-bio-fall-p2" });
    expect(body.accepted).not.toHaveProperty("activity");
  });

  it("refuses a launch whose browser never started the login", async () => {
    const world = await createWorld();
    const { location } = await handlerLogin(world, world.platforms.nfCanvas);
    const idToken = await world.platforms.nfCanvas.idToken({
      sub: SHARED_SUB,
      contextId: "nf-canvas-course-bio-p2",
      nonce: location.searchParams.get("nonce")!,
      targetLinkUri: `${TOOL}/lti/launch`,
    });
    const state = location.searchParams.get("state")!;
    // The attacker's own state cookie name differs, so a victim's browser carries nothing matching.
    const response = (await world.handler(
      formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state]], "__Host-lti-state-someone-else=1"),
    ))!;
    expect(response.status).toBe(401);
  });

  it("refuses login from an unregistered issuer, client or deployment", async () => {
    const world = await createWorld();
    const base = { iss: "https://canvas.northfield.example", client_id: "10000000000001", login_hint: "h", target_link_uri: `${TOOL}/lti/launch` };
    for (const params of [
      { ...base, iss: "https://canvas.evil.example" },
      { ...base, client_id: "99999" },
      { ...base, lti_deployment_id: "unknown-deployment" },
    ]) {
      const response = (await world.handler(new Request(`${TOOL}/lti/login?${new URLSearchParams(params)}`)))!;
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("refuses a login whose target link points outside the tool", async () => {
    const world = await createWorld();
    const params = new URLSearchParams({
      iss: "https://canvas.northfield.example",
      client_id: "10000000000001",
      login_hint: "h",
      target_link_uri: "https://phish.example/lti/launch",
    });
    expect((await world.handler(new Request(`${TOOL}/lti/login?${params}`)))!.status).toBe(401);
  });

  it("serves only its own paths and methods", async () => {
    const world = await createWorld();
    expect(await world.handler(new Request(`${TOOL}/api/other`))).toBeUndefined();
    expect((await world.handler(new Request(`${TOOL}/lti/launch`)))!.status).toBe(405);
    expect((await world.handler(new Request(`${TOOL}/lti/jwks`, { method: "constructor" })))!.status).toBe(405);
  });
});
