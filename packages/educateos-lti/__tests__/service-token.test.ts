import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createToolKeySet, generateToolKey, importToolKey, LTI_SCOPES, LtiServiceClient, PlatformJwksCache, rotateToolKeys } from "../src/index.ts";
import { servicesFetch } from "./fake-services.ts";
import { rejection } from "./helpers.ts";
import { createServicesWorld } from "./services-helpers.ts";

const NRPS = [LTI_SCOPES.contextMembershipReadonly];
const SCORE = [LTI_SCOPES.score];

async function registrationOf(world: Awaited<ReturnType<typeof createServicesWorld>>) {
  return (await world.registrations.get({ issuer: world.canvas.platform.issuer, clientId: world.canvas.platform.clientId }))!;
}

describe("LTI service tokens", () => {
  it("never follows a redirect, and asks fetch for `manual`, which the Workers runtime accepts", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    const modes: (RequestRedirect | undefined)[] = [];
    const redirecting = (async (_input: string | URL | Request, init?: RequestInit) => {
      modes.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    }) as typeof fetch;
    const client = new LtiServiceClient({ fetch: redirecting, toolKeys: world.getToolKeys, now: world.clock.now });
    expect(await rejection(client.accessToken(registration, NRPS))).toBe("unavailable");
    expect(await rejection(new PlatformJwksCache({ fetch: redirecting }).getKey(registration.jwksUrl, "kid"))).toBe("unavailable");
    expect(modes).toEqual(["manual", "manual"]);
  });


  it("signs a client assertion the platform verifies against the tool JWKS", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    expect(await world.services.accessToken(registration, NRPS)).toBe("token-1");

    const [request] = world.canvas.tokenRequests;
    const form = new URLSearchParams(request!.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe(LTI_SCOPES.contextMembershipReadonly);
    const assertion = form.get("client_assertion")!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", kid: world.getToolKeys().signing.kid });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: registration.clientId,
      sub: registration.clientId,
      aud: registration.authTokenUrl,
    });
  });

  it("is refused when the assertion is signed by a key the tool does not publish", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    // The platform reads the world's tool JWKS; this client signs with a key that is not in it.
    const rogue = createToolKeySet(await importToolKey(await generateToolKey()));
    const client = new LtiServiceClient({ fetch: servicesFetch([world.canvas]), toolKeys: () => rogue, now: world.clock.now });
    expect(await rejection(client.accessToken(registration, NRPS))).toBe("unavailable");
    expect(world.canvas.tokenRequests).toHaveLength(1);
  });

  it("verifies after a tool key rotation, because the retired key stays published", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    world.setToolKeys(rotateToolKeys(world.getToolKeys(), await importToolKey(await generateToolKey())));
    await expect(world.services.accessToken(registration, NRPS)).resolves.toBe("token-1");
  });

  it("caches a token per scope set until shortly before it expires", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    world.canvas.tokenLifetime = 600;

    const first = await world.services.accessToken(registration, NRPS);
    world.clock.advance(60);
    expect(await world.services.accessToken(registration, NRPS)).toBe(first);
    // A different service gets its own token: an NRPS token is never used for AGS.
    const scoreToken = await world.services.accessToken(registration, SCORE);
    expect(scoreToken).not.toBe(first);
    expect(world.canvas.tokenRequests).toHaveLength(2);

    // Inside the last minute of its life, the token is renewed rather than used.
    world.clock.advance(600 - 60 - 60 - 1);
    expect(await world.services.accessToken(registration, NRPS)).toBe(first);
    world.clock.advance(2);
    const renewed = await world.services.accessToken(registration, NRPS);
    expect(renewed).not.toBe(first);
    expect(world.canvas.tokenRequests).toHaveLength(3);
  });

  it("shares one token request between concurrent callers", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    const tokens = await Promise.all([1, 2, 3].map(() => world.services.accessToken(registration, NRPS)));
    expect(new Set(tokens).size).toBe(1);
    expect(world.canvas.tokenRequests).toHaveLength(1);
  });

  it("refuses a token that does not carry every requested scope", async () => {
    const world = await createServicesWorld();
    const registration = await registrationOf(world);
    world.canvas.grantScopes = () => [LTI_SCOPES.lineItemReadonly];
    expect(await rejection(world.services.accessToken(registration, SCORE))).toBe("forbidden");
  });

  it("drops a revoked cached token and retries a service call once with a new one", async () => {
    const world = await createServicesWorld();
    world.canvas.members.set("nf-canvas-course-bio-p2", [{ user_id: "lti-user-0007", roles: [] }]);
    const services = world.canvas.contextServices("nf-canvas-course-bio-p2");
    await world.nrps.rosterProjection(services);
    world.canvas.revokeTokens();
    await world.nrps.rosterProjection(services);
    expect(world.canvas.tokenRequests).toHaveLength(2);
  });
});
