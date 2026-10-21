import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { LTI_CLAIM } from "../src/index.ts";
import { generatePlatformKey, type ClaimOverrides, type FakePlatform } from "./fake-platform.ts";
import { createWorld, rejection, SHARED_SUB, startLogin, TOOL, type World } from "./helpers.ts";

const BIO = "nf-canvas-course-bio-p2";

/** Logs in on `platform` and launches with the given claim overrides. */
async function launchWith(world: World, overrides: ClaimOverrides = {}, platform: FakePlatform = world.platforms.nfCanvas) {
  const { state, nonce } = await startLogin(world, platform);
  const idToken = await platform.idToken({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch`, overrides });
  return world.broker.launch(idToken, state);
}

describe("id_token validation", () => {
  it("accepts a well-formed launch (the baseline the other cases vary)", async () => {
    const world = await createWorld();
    await expect(launchWith(world)).resolves.toMatchObject({ launch: { principal: { principalId: "prn_nf-student-amara" } } });
  });

  it("refuses a forged signature", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas);
    // Signed by a key the attacker made up but labelled with the platform's real key ID.
    const forger = await generatePlatformKey();
    const claims = world.platforms.nfCanvas.claims({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch` });
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: world.platforms.nfCanvas.signingKey.kid })
      .sign(forger.privateKey);
    expect(await rejection(world.broker.launch(forged, state))).toBe("unauthenticated");
  });

  it("refuses a token whose payload was altered after signing", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas);
    const token = await world.platforms.nfCanvas.idToken({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch` });
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    claims.sub = "canvas-admin-avery";
    const tampered = [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");
    expect(await rejection(world.broker.launch(tampered, state))).toBe("unauthenticated");
  });

  it("refuses alg none and HS256 tokens", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas);
    const claims = world.platforms.nfCanvas.claims({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch` });
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: world.platforms.nfCanvas.signingKey.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect(await rejection(world.broker.launch(none, state))).toBe("unauthenticated");

    const second = await startLogin(world, world.platforms.nfCanvas);
    const hs = await new SignJWT({ ...claims, nonce: second.nonce })
      .setProtectedHeader({ alg: "HS256", kid: world.platforms.nfCanvas.signingKey.kid })
      .sign(new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!!"));
    expect(await rejection(world.broker.launch(hs, second.state))).toBe("unauthenticated");
  });

  it("refuses the wrong audience", async () => {
    const world = await createWorld();
    expect(await rejection(launchWith(world, { aud: "some-other-tool" }))).toBe("unauthenticated");
  });

  it("requires azp to name this tool when there are several audiences", async () => {
    const world = await createWorld();
    const client = world.platforms.nfCanvas.clientId;
    expect(await rejection(launchWith(world, { aud: [client, "other-tool"] }))).toBe("unauthenticated");
    expect(await rejection(launchWith(world, { aud: [client, "other-tool"], azp: "other-tool" }))).toBe("unauthenticated");
    expect(await rejection(launchWith(world, { azp: "other-tool" }))).toBe("unauthenticated");
    await expect(launchWith(world, { aud: [client, "other-tool"], azp: client })).resolves.toBeDefined();
  });

  it("refuses a token from another registered platform presented against this login", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas);
    // Moodle signs a perfectly valid token for itself; the login was for Northfield's Canvas.
    const moodle = await world.platforms.nfMoodle.idToken({ sub: SHARED_SUB, contextId: "moodle-bio", nonce, targetLinkUri: `${TOOL}/lti/launch` });
    expect(await rejection(world.broker.launch(moodle, state))).toBe("unauthenticated");
  });

  it("refuses an unknown deployment", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas, { lti_deployment_id: undefined });
    const token = await world.platforms.nfCanvas.idToken({
      sub: SHARED_SUB,
      contextId: BIO,
      nonce,
      targetLinkUri: `${TOOL}/lti/launch`,
      deploymentId: "rogue-deployment",
    });
    expect(await rejection(world.broker.launch(token, state))).toBe("unauthenticated");
  });

  it("refuses a launch through a different deployment than its login named", async () => {
    const world = await createWorld();
    // Northfield's Canvas registration has both deployments; the login named the first.
    expect(await rejection(launchWith(world, { [LTI_CLAIM.deploymentId]: "nf-canvas-deploy-2" }))).toBe("unauthenticated");
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas, { lti_deployment_id: undefined });
    const token = await world.platforms.nfCanvas.idToken({
      sub: SHARED_SUB,
      contextId: BIO,
      nonce,
      targetLinkUri: `${TOOL}/lti/launch`,
      deploymentId: "nf-canvas-deploy-2",
    });
    await expect(world.broker.launch(token, state)).resolves.toBeDefined();
  });

  it("refuses an expired token, within and beyond the skew limit", async () => {
    const world = await createWorld();
    const now = Math.floor(world.clock.ms / 1000);
    await expect(launchWith(world, { iat: now - 120, exp: now - 30 })).resolves.toBeDefined();
    expect(await rejection(launchWith(world, { iat: now - 300, exp: now - 61 }))).toBe("unauthenticated");
  });

  it("refuses a token issued in the future, not yet valid, or too old", async () => {
    const world = await createWorld();
    const now = Math.floor(world.clock.ms / 1000);
    expect(await rejection(launchWith(world, { iat: now + 120, exp: now + 600 }))).toBe("unauthenticated");
    expect(await rejection(launchWith(world, { nbf: now + 120 }))).toBe("unauthenticated");
    expect(await rejection(launchWith(world, { iat: now - 3600, exp: now + 3600 }))).toBe("unauthenticated");
    expect(await rejection(launchWith(world, { iat: undefined }))).toBe("unauthenticated");
  });

  it("refuses a reused nonce, even with a fresh state", async () => {
    const world = await createWorld();
    const first = await startLogin(world, world.platforms.nfCanvas);
    const token = await world.platforms.nfCanvas.idToken({ sub: SHARED_SUB, contextId: BIO, nonce: first.nonce, targetLinkUri: `${TOOL}/lti/launch` });
    await world.broker.launch(token, first.state);

    // Replaying the captured token against a new login: the state is fresh but the nonce is not.
    const second = await startLogin(world, world.platforms.nfCanvas);
    expect(await rejection(world.broker.launch(token, second.state))).toBe("unauthenticated");
    // And the second login's state was consumed by the failed attempt, so it cannot be retried.
    const retry = await world.platforms.nfCanvas.idToken({ sub: SHARED_SUB, contextId: BIO, nonce: second.nonce, targetLinkUri: `${TOOL}/lti/launch` });
    expect(await rejection(world.broker.launch(retry, second.state))).toBe("unauthenticated");
  });

  it("refuses a state that has expired", async () => {
    const world = await createWorld();
    const { state, nonce } = await startLogin(world, world.platforms.nfCanvas);
    world.clock.advance(11 * 60);
    const token = await world.platforms.nfCanvas.idToken({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch` });
    expect(await rejection(world.broker.launch(token, state))).toBe("unauthenticated");
  });

  it("refuses an unknown or missing message type or version, never defaulting them", async () => {
    const world = await createWorld();
    for (const overrides of [
      { [LTI_CLAIM.messageType]: "LtiSubmissionReviewRequest" },
      { [LTI_CLAIM.messageType]: undefined },
      { [LTI_CLAIM.version]: "1.1" },
      { [LTI_CLAIM.version]: undefined },
      { [LTI_CLAIM.resourceLink]: undefined },
      { sub: undefined },
    ]) {
      expect(await rejection(launchWith(world, overrides))).toBe("unauthenticated");
    }
  });

  it("refuses a target link that differs from the one the login named", async () => {
    const world = await createWorld();
    expect(await rejection(launchWith(world, { [LTI_CLAIM.targetLinkUri]: `${TOOL}/lti/other` }))).toBe("unauthenticated");
  });

  it("refuses a course the registration does not map to an offering", async () => {
    const world = await createWorld();
    expect(await rejection(launchWith(world, { [LTI_CLAIM.context]: { id: "nf-canvas-course-unmapped" } }))).toBe("forbidden");
    expect(await rejection(launchWith(world, { [LTI_CLAIM.context]: undefined }))).toBe("forbidden");
    // A context mapped by a different registration of the same district does not leak across.
    expect(await rejection(launchWith(world, { [LTI_CLAIM.context]: { id: "moodle-bio" } }))).toBe("forbidden");
  });

  it("accepts a login without client_id only when the issuer has a single registration", async () => {
    const world = await createWorld();
    const { redirectUrl } = await world.broker.login({ iss: world.platforms.rbCanvas.issuer, login_hint: "h", target_link_uri: `${TOOL}/lti/launch` });
    expect(new URL(redirectUrl).searchParams.get("client_id")).toBe(world.platforms.rbCanvas.clientId);
  });
});
