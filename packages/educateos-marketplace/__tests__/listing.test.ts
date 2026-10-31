// Listing bundles (SCHO-209): what a district accepts and refuses, all offline against pinned keys.
import { EducateOsError } from "@educateos/contracts";
import { SigningIdentity, type SignedEnvelope } from "@educateos/fleet";
import { pinReleaseKeys, signReleaseMessage, type ReleaseTrust } from "@educateos/releases";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildListingBundle,
  CurriculumPackContent,
  listingContentDigest,
  type ListingBundle,
  type ListingBundleInput,
  openPublisherCredential,
  type PublisherCredential,
  signPublisherCredential,
  verifyListingBundle,
} from "../src/index.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

const PACK: CurriculumPackContent = {
  title: "Argument writing starter pack",
  subjects: ["english-language-arts"],
  gradeBands: ["6-8"],
  activities: [
    {
      key: "school-uniforms",
      template: {
        template: "writing-task",
        title: "Should schools require uniforms?",
        subject: "english-language-arts",
        gradeBand: "6-8",
        overview: "Take a position and support it with reasons and evidence.",
        aiHelp: "hints-only",
        due: { kind: "after-install", days: 7 },
        prompt: "Write an argument for or against school uniforms.",
        genre: "argument",
        minimumCitations: 0,
        codex: [{ kind: "note", id: "tips", title: "Tips", body: "State your claim first.", purpose: "context", visibility: "students" }],
      },
    },
    {
      key: "ratios",
      template: {
        template: "problem-set",
        title: "Ratio practice",
        subject: "mathematics",
        gradeBand: "6-8",
        overview: "Practice equivalent ratios.",
        aiHelp: "hints-only",
        due: { kind: "none" },
        problems: [{ prompt: "Simplify 6:9.", answer: "2:3" }],
        showWork: true,
      },
    },
  ],
} as CurriculumPackContent;

const LISTING = {
  listingId: "argument-writing-starter",
  publisherId: "educateos",
  kind: "curriculum-pack",
  version: "1.0.0",
  releasedAt: "2026-10-31T00:00:00.000Z",
  title: "Argument writing starter pack",
  summary: "Two ready-to-assign activities for middle school.",
  license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  pricing: { model: "free" },
} as const;

let releaseKey: SigningIdentity;
let publisherKey: SigningIdentity;
let trust: ReleaseTrust;

const credentialFor = (key: SigningIdentity, overrides: Partial<PublisherCredential> = {}): PublisherCredential => ({
  publisher: { publisherId: "educateos", displayName: "EducateOS", website: "https://educateos.io", key: { keyId: key.keyId, publicKey: key.publicKey } },
  issuedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2027-10-01T00:00:00.000Z",
  ...overrides,
});

const input = async (overrides: Partial<ListingBundleInput> = {}): Promise<ListingBundleInput> => ({
  credential: await signPublisherCredential(releaseKey, credentialFor(publisherKey)),
  publisherKey,
  listing: LISTING,
  content: PACK,
  ...overrides,
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EducateOsError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

beforeAll(async () => {
  releaseKey = await SigningIdentity.generate();
  publisherKey = await SigningIdentity.generate();
  const root = await SigningIdentity.generate();
  trust = await pinReleaseKeys({ releaseKeys: [releaseKey.publicKey], root: { threshold: 1, publicKeys: [root.publicKey] } });
});

describe("verifyListingBundle", () => {
  it("accepts a bundle whose credential, listing and content all check out", async () => {
    const bundle = await buildListingBundle(await input());
    const verified = await verifyListingBundle(JSON.parse(JSON.stringify(bundle)), trust, NOW);
    expect(verified.publisher.publisherId).toBe("educateos");
    expect(verified.credentialKeyId).toBe(releaseKey.keyId);
    expect(verified.listing).toMatchObject({ listingId: "argument-writing-starter", version: "1.0.0", pricing: { model: "free" } });
    expect(verified.listing.contentDigest).toBe(await listingContentDigest(bundle.content));
    expect(verified.content.activities.map((a) => a.key)).toEqual(["school-uniforms", "ratios"]);
  });

  it("refuses a credential signed by a key the district does not pin", async () => {
    const stranger = await SigningIdentity.generate();
    const bundle = await buildListingBundle(await input({ credential: await signPublisherCredential(stranger, credentialFor(publisherKey)) }));
    expect(await code(verifyListingBundle(bundle, trust, NOW))).toBe("unauthenticated");
  });

  it("refuses a credential outside its validity window", async () => {
    const credential = await signPublisherCredential(releaseKey, credentialFor(publisherKey, { expiresAt: "2026-10-31T00:00:00.000Z" }));
    const bundle = await buildListingBundle(await input({ credential }));
    expect(await code(verifyListingBundle(bundle, trust, NOW))).toBe("unauthenticated");
    expect(await code(verifyListingBundle(bundle, trust, new Date("2026-09-01T00:00:00Z")))).toBe("unauthenticated");
  });

  it("refuses a release key's signature over another message kind", async () => {
    const envelope = await signReleaseMessage(releaseKey, "catalog-release", credentialFor(publisherKey));
    const bundle = await buildListingBundle(await input({ credential: envelope }));
    expect(await code(verifyListingBundle(bundle, trust, NOW))).toBe("unauthenticated");
  });

  it("refuses a listing signed by any key but the credentialed one", async () => {
    const other = await SigningIdentity.generate();
    const bundle = await buildListingBundle(await input({ publisherKey: other }));
    expect(await code(verifyListingBundle(bundle, trust, NOW))).toBe("unauthenticated");
    // Presenting the other key's signature under the credentialed key's ID fails too.
    const relabelled: ListingBundle = { ...bundle, listing: { ...bundle.listing, keyId: publisherKey.keyId } as SignedEnvelope };
    expect(await code(verifyListingBundle(relabelled, trust, NOW))).toBe("unauthenticated");
  });

  it("refuses a listing for another publisher than the credential names", async () => {
    const bundle = await buildListingBundle(await input({ listing: { ...LISTING, publisherId: "someone-else" } }));
    expect(await code(verifyListingBundle(bundle, trust, NOW))).toBe("unauthenticated");
  });

  it("refuses an edited listing statement", async () => {
    const bundle = await buildListingBundle(await input());
    const edited = { ...bundle, listing: { ...bundle.listing, payload: { ...(bundle.listing.payload as object), version: "9.9.9" } } };
    expect(await code(verifyListingBundle(edited, trust, NOW))).toBe("unauthenticated");
  });

  it("refuses content that does not match the listing's digest", async () => {
    const bundle = await buildListingBundle(await input());
    const content = JSON.parse(JSON.stringify(bundle.content)) as { title: string };
    content.title = "Something else";
    expect(await code(verifyListingBundle({ ...bundle, content }, trust, NOW))).toBe("validation-failed");
  });

  it("refuses a paid listing, even when its signature is genuine", async () => {
    const bundle = await buildListingBundle(await input());
    const payload = { ...(bundle.listing.payload as object), pricing: { model: "paid", priceId: "price_123" } };
    // Sign the paid statement the way a future publisher tool would.
    const { canonicalJson } = await import("@educateos/fleet");
    const bytes = new TextEncoder().encode(`educateos-marketplace/v1\0listing\0${canonicalJson(payload)}`).slice();
    const paid = { ...bundle, listing: { payload, keyId: publisherKey.keyId, signature: await publisherKey.sign(bytes) } as SignedEnvelope };
    expect(await code(verifyListingBundle(paid, trust, NOW))).toBe("conflict");
  });

  it("refuses a malformed bundle", async () => {
    expect(await code(verifyListingBundle({ format: "something" }, trust, NOW))).toBe("validation-failed");
    expect(await code(verifyListingBundle(null, trust, NOW))).toBe("validation-failed");
  });
});

describe("pack content", () => {
  const activity = PACK.activities[0]!;
  const withTemplate = (template: Record<string, unknown>) => ({ ...PACK, activities: [{ key: "a", template: { ...activity.template, ...template } }] });

  it("refuses references to the publisher's own registry", () => {
    expect(CurriculumPackContent.safeParse(withTemplate({ resources: [{ resourceId: "res_1", version: "1.0.0" }] })).success).toBe(false);
    expect(CurriculumPackContent.safeParse(withTemplate({ alignments: [{ frameworkKey: "ccss-ela", competencyUri: "https://example.org/x" }] })).success).toBe(false);
    expect(CurriculumPackContent.safeParse(withTemplate({ structureRubric: { rubricId: "rub_1", version: 1 } })).success).toBe(false);
  });

  it("refuses duplicate activity keys", () => {
    expect(CurriculumPackContent.safeParse({ ...PACK, activities: [PACK.activities[0], PACK.activities[0]] }).success).toBe(false);
  });

  it("refuses to sign content that is not an installable pack", async () => {
    await expect(buildListingBundle(await input({ content: { ...PACK, activities: [] } }))).rejects.toThrow();
  });
});

describe("publisher credentials", () => {
  it("refuse a credential whose key ID does not match its key", async () => {
    const other = await SigningIdentity.generate();
    const mismatched = credentialFor(publisherKey, { publisher: { ...credentialFor(publisherKey).publisher, key: { keyId: other.keyId, publicKey: publisherKey.publicKey } } });
    await expect(signPublisherCredential(releaseKey, mismatched)).rejects.toThrow(EducateOsError);
    const forged = await signReleaseMessage(releaseKey, "marketplace-publisher", mismatched);
    expect(await openPublisherCredential(forged, trust, NOW)).toBeUndefined();
  });

  it("open only for a trusted, current release key", async () => {
    const envelope = await signPublisherCredential(releaseKey, credentialFor(publisherKey));
    expect((await openPublisherCredential(envelope, trust, NOW))?.publisher.publisherId).toBe("educateos");
    const retired: ReleaseTrust = { ...trust, keys: trust.keys.map((key) => ({ ...key, retiresAt: "2026-10-15T00:00:00Z" })) };
    expect(await openPublisherCredential(envelope, retired, NOW)).toBeUndefined();
    expect(await openPublisherCredential({ not: "an envelope" }, trust, NOW)).toBeUndefined();
  });
});
