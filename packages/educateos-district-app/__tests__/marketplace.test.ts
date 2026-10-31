// SCHO-209: a district administrator installs a curriculum pack from a signed marketplace listing,
// verified offline against the keys the district pins, and a teacher creates an activity from it.
import { beforeAll, describe, expect, it } from "vitest";
import { SigningIdentity } from "@educateos/fleet";
import { buildListingBundle, signPublisherCredential, type CurriculumPackContent, type ListingBundle, type ListingStatement } from "@educateos/marketplace";
import { pinReleaseKeys, type ReleaseTrust } from "@educateos/releases";
import { bootDistrict, expectError, NF } from "./support.ts";

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
      due: { kind: "after-install", days: 7 },
    },
  }],
} as CurriculumPackContent;

const LISTING: Omit<ListingStatement, "contentDigest"> = {
  listingId: "argument-writing-starter",
  publisherId: "educateos",
  kind: "curriculum-pack",
  version: "1.0.0",
  releasedAt: "2026-10-31T00:00:00.000Z",
  title: "Argument writing starter pack",
  summary: "A ready-to-assign argument essay for grade 9.",
  license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  pricing: { model: "free" },
};

let trust: ReleaseTrust;
let bundle: ListingBundle;
let releaseKey: SigningIdentity;
let publisherKey: SigningIdentity;

const bundleFor = async (signer: SigningIdentity, overrides: Partial<typeof LISTING> = {}, content: CurriculumPackContent = PACK) => buildListingBundle({
  credential: await signPublisherCredential(signer, {
    publisher: { publisherId: "educateos", displayName: "EducateOS", key: { keyId: publisherKey.keyId, publicKey: publisherKey.publicKey } },
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }),
  publisherKey,
  listing: { ...LISTING, ...overrides },
  content,
});

beforeAll(async () => {
  releaseKey = await SigningIdentity.generate();
  publisherKey = await SigningIdentity.generate();
  const root = await SigningIdentity.generate();
  trust = await pinReleaseKeys({ releaseKeys: [releaseKey.publicKey], root: { threshold: 1, publicKeys: [root.publicKey] } });
  bundle = await bundleFor(releaseKey);
});

describe("marketplace packs (SCHO-209)", () => {
  it("installs a verified pack once, lists it, and lets a teacher create an activity from it", async () => {
    const district = await bootDistrict(undefined, { marketplaceTrust: trust });
    const admin = district.tokenFor(NF.admin);
    const installed = await district.ok(admin, "admin.installMarketplacePack", { body: bundle as never });
    expect(installed).toMatchObject({
      publisher: { publisherId: "educateos", displayName: "EducateOS" },
      listingId: "argument-writing-starter",
      version: "1.0.0",
      pricing: { model: "free" },
      activities: [{ key: "later-start", template: "writing-task", title: "Should the school day start later?" }],
      installed: { by: NF.admin },
    });
    // Installing it again changes nothing.
    expect(await district.ok(admin, "admin.installMarketplacePack", { body: bundle as never })).toStrictEqual(installed);
    expect(await district.ok(admin, "admin.listMarketplacePacks")).toStrictEqual([installed]);

    const rivera = district.tokenFor(NF.rivera);
    const [pack] = await district.ok(rivera, "teacher.marketplacePacks", { params: { offeringId: NF.eng9 } });
    expect(pack).toMatchObject({ listingId: "argument-writing-starter", version: "1.0.0" });
    const draft = await district.ok(rivera, "teacher.createActivity", { params: { offeringId: NF.eng9 }, body: { activity: pack!.activities[0]!.template } });
    expect(draft.content.title).toBe("Should the school day start later?");
  });

  it("lists only the latest installed version of each listing to teachers", async () => {
    const district = await bootDistrict(undefined, { marketplaceTrust: trust });
    const admin = district.tokenFor(NF.admin);
    await district.ok(admin, "admin.installMarketplacePack", { body: bundle as never });
    const next = await bundleFor(releaseKey, { version: "1.1.0" }, { ...PACK, title: "Argument writing starter pack, revised" });
    await district.ok(admin, "admin.installMarketplacePack", { body: next as never });
    expect((await district.ok(admin, "admin.listMarketplacePacks")).map((p) => p.version)).toStrictEqual(["1.0.0", "1.1.0"]);
    const packs = await district.ok(district.tokenFor(NF.rivera), "teacher.marketplacePacks", { params: { offeringId: NF.eng9 } });
    expect(packs.map((p) => p.version)).toStrictEqual(["1.1.0"]);
  });

  it("refuses a listing whose credential no pinned key signed, and installs nothing", async () => {
    const district = await bootDistrict(undefined, { marketplaceTrust: trust });
    const admin = district.tokenFor(NF.admin);
    const forged = await bundleFor(await SigningIdentity.generate());
    expectError(await district.call(admin, "admin.installMarketplacePack", { body: forged as never }), 401, "unauthenticated");
    expect(await district.ok(admin, "admin.listMarketplacePacks")).toStrictEqual([]);
  });

  it("refuses the same version with other content", async () => {
    const district = await bootDistrict(undefined, { marketplaceTrust: trust });
    const admin = district.tokenFor(NF.admin);
    await district.ok(admin, "admin.installMarketplacePack", { body: bundle as never });
    const changed = await bundleFor(releaseKey, {}, { ...PACK, title: "Something else" });
    expectError(await district.call(admin, "admin.installMarketplacePack", { body: changed as never }), 409, "conflict");
  });

  it("installs nothing in a district that pins no marketplace keys", async () => {
    const district = await bootDistrict();
    expectError(await district.call(district.tokenFor(NF.admin), "admin.installMarketplacePack", { body: bundle as never }), 503, "unavailable");
  });

  it("lets only administrators install and list, and only a class's teachers read its templates", async () => {
    const district = await bootDistrict(undefined, { marketplaceTrust: trust });
    const rivera = district.tokenFor(NF.rivera);
    expectError(await district.call(rivera, "admin.installMarketplacePack", { body: bundle as never }), 403, "forbidden");
    expectError(await district.call(rivera, "admin.listMarketplacePacks"), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.marketplacePacks", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.chen), "teacher.marketplacePacks", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
  });
});
