import { describe, expect, it } from "vitest";
import { importJWK, jwtVerify, SignJWT } from "jose";
import {
  createToolKeySet,
  generateToolKey,
  importToolKey,
  PlatformJwksCache,
  rotateToolKeys,
  toolJwks, STATE_COOKIE_BINDING,
} from "../src/index.ts";
import { generatePlatformKey } from "./fake-platform.ts";
import { createWorld, rejection, SHARED_SUB, startLogin, TOOL, type World } from "./helpers.ts";

const BIO = "nf-canvas-course-bio-p2";

async function launchSignedBy(world: World, key = world.platforms.nfCanvas.signingKey) {
  const platform = world.platforms.nfCanvas;
  const { state, nonce } = await startLogin(world, platform);
  const token = await platform.idToken({ sub: SHARED_SUB, contextId: BIO, nonce, targetLinkUri: `${TOOL}/lti/launch` }, key);
  return world.broker.launch(token, state, STATE_COOKIE_BINDING);
}

describe("platform JWKS", () => {
  it("fetches once and serves later launches from the cache", async () => {
    const world = await createWorld();
    await launchSignedBy(world);
    await launchSignedBy(world);
    expect(world.calls.get(world.platforms.nfCanvas.jwksUrl)).toBe(1);
  });

  it("picks up a rotated platform key by refetching on the unknown kid", async () => {
    const world = await createWorld();
    await launchSignedBy(world);
    world.clock.advance(60);
    const old = world.platforms.nfCanvas.signingKey;
    await world.platforms.nfCanvas.rotate(false);
    await expect(launchSignedBy(world)).resolves.toBeDefined();
    expect(world.calls.get(world.platforms.nfCanvas.jwksUrl)).toBe(2);
    // The old key is still published, so tokens minted just before the rotation still verify.
    await expect(launchSignedBy(world, old)).resolves.toBeDefined();
  });

  it("stops accepting a withdrawn key once the cached set expires", async () => {
    const world = await createWorld();
    const old = world.platforms.nfCanvas.signingKey;
    await launchSignedBy(world);
    await world.platforms.nfCanvas.rotate(true);
    world.clock.advance(10 * 60);
    expect(await rejection(launchSignedBy(world, old))).toBe("unauthenticated");
    await expect(launchSignedBy(world)).resolves.toBeDefined();
  });

  it("rate-limits refetches caused by unknown key IDs", async () => {
    const world = await createWorld();
    await launchSignedBy(world);
    const stranger = await generatePlatformKey();
    expect(await rejection(launchSignedBy(world, stranger))).toBe("unauthenticated");
    expect(await rejection(launchSignedBy(world, stranger))).toBe("unauthenticated");
    expect(world.calls.get(world.platforms.nfCanvas.jwksUrl)).toBe(1);
  });

  it("skips keys shorter than 2048 bits and fails closed when the JWKS is unreachable", async () => {
    const weak = await generatePlatformKey(1024);
    const jwks = { keys: [{ ...weak.publicJwk, kid: weak.kid }] };
    const cache = new PlatformJwksCache({ fetch: (async () => Response.json(jwks)) as typeof fetch });
    expect(await rejection(cache.getKey("https://lms.example/jwks", weak.kid))).toBe("unauthenticated");

    const down = new PlatformJwksCache({ fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
    expect(await rejection(down.getKey("https://lms.example/jwks", "any"))).toBe("unavailable");
  });
});

describe("tool keys", () => {
  it("publishes only public key material", async () => {
    const set = createToolKeySet(await importToolKey(await generateToolKey()));
    const [published] = toolJwks(set).keys;
    expect(Object.keys(published!).toSorted()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("rotates: the new key signs, the previous key stays published, older keys drop off", async () => {
    const first = await importToolKey(await generateToolKey());
    const second = await importToolKey(await generateToolKey());
    const third = await importToolKey(await generateToolKey());
    const rotated = rotateToolKeys(rotateToolKeys(createToolKeySet(first), second), third);
    expect(rotated.signing.kid).toBe(third.kid);
    expect(toolJwks(rotated).keys.map((key) => key.kid)).toEqual([third.kid, second.kid]);

    // A platform holding the published JWKS verifies a message signed before the last rotation.
    const signedBySecond = await new SignJWT({ hello: "platform" }).setProtectedHeader({ alg: "RS256", kid: second.kid }).sign(second.privateKey);
    const published = toolJwks(rotated).keys.find((key) => key.kid === second.kid)!;
    await expect(jwtVerify(signedBySecond, await importJWK(published, "RS256"))).resolves.toBeDefined();
  });

  it("serves the current key set at /lti/jwks, including after a rotation", async () => {
    const world = await createWorld();
    const before = world.getToolKeys().signing.kid;
    world.setToolKeys(rotateToolKeys(world.getToolKeys(), await importToolKey(await generateToolKey())));
    const response = (await world.handler(new Request(`${TOOL}/lti/jwks`)))!;
    const body = (await response.json()) as { keys: { kid: string; d?: string }[] };
    expect(body.keys.map((key) => key.kid)).toEqual([world.getToolKeys().signing.kid, before]);
    expect(body.keys.some((key) => key.d !== undefined)).toBe(false);
  });
});
