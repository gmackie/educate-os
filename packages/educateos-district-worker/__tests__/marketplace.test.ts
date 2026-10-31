// SCHO-209: a district installs a curriculum pack from a signed marketplace listing through its own
// Worker, verified against the release keys its MARKETPLACE_TRUST var pins, and keeps it across a
// restart. The bundle is signed in the test with this run's release key, as the publish script signs one.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { Ed25519PrivateJwk, SigningIdentity } from "@educateos/fleet";
import { buildListingBundle, signPublisherCredential, verifyListingBundle, type CurriculumPackContent } from "@educateos/marketplace";
import { DurableObjectMarketplacePackStore } from "@educateos/district-app/durable-stores";
import { ROUTES, routePath, type RouteInput, type RouteName } from "@educateos/district-app/routes";
import { readMarketplaceTrust } from "../src/district.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const RIVERA = "prn_nf-teacher-rivera";
const ENG9 = "off_nf-eng9-fall-p3";

const PACK = {
  title: "Argument writing starter pack",
  subjects: ["english-language-arts"],
  gradeBands: ["9"],
  activities: [{
    key: "later-start",
    template: {
      template: "writing-task",
      title: "Should the school day start later?",
      subject: "english-language-arts",
      gradeBand: "9",
      overview: "Write an argument for or against a later start to the school day.",
      prompt: "Take a position and support it with reasons.",
      genre: "argument",
      minimumCitations: 0,
      aiHelp: "hints-only",
      due: { kind: "none" },
    },
  }],
} as CurriculumPackContent;

/** A bundle for the pack, its credential signed by `releaseKey`. */
async function bundle(releaseKey: SigningIdentity) {
  const publisherKey = await SigningIdentity.generate();
  return buildListingBundle({
    credential: await signPublisherCredential(releaseKey, {
      publisher: { publisherId: "educateos", displayName: "EducateOS", key: { keyId: publisherKey.keyId, publicKey: publisherKey.publicKey } },
      issuedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    publisherKey,
    listing: {
      listingId: "argument-writing-starter",
      publisherId: "educateos",
      kind: "curriculum-pack",
      version: "1.0.0",
      releasedAt: "2026-10-31T00:00:00.000Z",
      title: "Argument writing starter pack",
      summary: "A ready-to-assign argument essay for grade 9.",
      license: { name: "CC BY 4.0" },
      pricing: { model: "free" },
    },
    content: PACK,
  });
}

const releaseKey = () => SigningIdentity.fromJwk(Ed25519PrivateJwk.parse(JSON.parse(env.TEST_MARKETPLACE_RELEASE_JWK)));

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Calls a route through the Worker, reading the whole body so nothing stays open in the object. */
async function call<N extends RouteName>(principalId: string, name: N, input: RouteInput<N> = {} as RouteInput<N>): Promise<{ status: number; body: unknown }> {
  const spec = ROUTES[name];
  const parts = input as { params?: Record<string, string>; body?: unknown };
  const response = await SELF.fetch(new Request(new URL(routePath(spec.path, parts.params), "https://district.example"), {
    method: spec.method,
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signIn(principalId) },
    ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
  }));
  return { status: response.status, body: await response.json() };
}

describe("marketplace installs (SCHO-209)", () => {
  it("installs a pack signed under the pinned release key, and keeps it across a restart", async () => {
    const installed = await call(ADMIN, "admin.installMarketplacePack", { body: await bundle(await releaseKey()) as never });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ listingId: "argument-writing-starter", version: "1.0.0", installed: { by: ADMIN } });

    await evictDurableObject(env.DISTRICT.getByName(NORTHFIELD.district.id));
    const listed = await call(ADMIN, "admin.listMarketplacePacks");
    expect(listed.body).toStrictEqual([installed.body]);
    const templates = await call(RIVERA, "teacher.marketplacePacks", { params: { offeringId: ENG9 } });
    expect(templates.body).toMatchObject([{ listingId: "argument-writing-starter", activities: [{ key: "later-start" }] }]);
  });

  it("refuses a pack whose credential another key signed", async () => {
    const refused = await call(ADMIN, "admin.installMarketplacePack", { body: await bundle(await SigningIdentity.generate()) as never });
    expect(refused.status).toBe(401);
  });
});

describe("readMarketplaceTrust", () => {
  it("reads a pin, treats unset as none, and refuses anything malformed without quoting it", () => {
    expect(readMarketplaceTrust(undefined)).toBeUndefined();
    expect(readMarketplaceTrust("")).toBeUndefined();
    expect(readMarketplaceTrust(env.MARKETPLACE_TRUST)?.keys).toHaveLength(1);
    expect(() => readMarketplaceTrust("{not json")).toThrow("MARKETPLACE_TRUST is not JSON");
    expect(() => readMarketplaceTrust(JSON.stringify({ keys: "secret-looking" }))).toThrow(/^MARKETPLACE_TRUST is not a release trust$/);
  });
});

describe("DurableObjectMarketplacePackStore", () => {
  it("keeps one entry per version of a listing", async () => {
    const object = env.DISTRICT.getByName("marketplace-store");
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectMarketplacePackStore(state.storage);
      const verified = await verifyListingBundle(await bundle(await releaseKey()), readMarketplaceTrust(env.MARKETPLACE_TRUST)!, new Date());
      const pack = { ...verified, installedBy: ADMIN, installedAt: "2026-11-01T00:00:00.000Z" } as never;
      expect(await store.add(pack)).toStrictEqual(pack);
      const again = { ...(pack as object), installedAt: "2026-11-02T00:00:00.000Z" } as never;
      expect(await store.add(again)).toStrictEqual(pack);
      expect(await store.list()).toStrictEqual([pack]);
    });
  });
});
