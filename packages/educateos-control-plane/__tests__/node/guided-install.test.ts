// The guided install, end to end against the installer's Cloudflare fake: it installs the newest
// signed release from the bucket into the operator's account, records and optionally registers the
// installation, refuses an untrusted release or a taken slug before changing anything, and never
// lets the token into anything it reports.

import { describe, expect, it } from "vitest";
import { InMemoryInstanceRegistryStorage, InstanceRegistry } from "@educateos/fleet";
import { FakeCloudflare } from "@educateos/installer";
import { deriveRelease, goldenRelease, ROOT_TRUST, type TestRelease } from "../../../educateos-installer/__tests__/support.ts";
import { GuidedInstallForm, instanceIdFor, latestRelease, runGuidedInstall, type InstallEvent, type ReleaseBucket } from "../../src/guided-install.ts";
import type { RegistryReply } from "../../src/registry.ts";
import type { Installation, Operator, Reservation } from "../../src/store.ts";

const ACCOUNT = "d1".repeat(16);
const OPERATOR: Operator = {
  subject: "operator-1", accountId: `acct_${"9".repeat(32)}` as Operator["accountId"], email: "it@riverbend.example",
  firstSeenAt: "2026-10-26T00:00:00.000Z", lastSeenAt: "2026-10-26T00:00:00.000Z",
};

/** A release bucket holding the given releases, laid out as upload-release.ts lays one out. */
function bucketOf(...releases: TestRelease[]): ReleaseBucket {
  return {
    async list({ prefix }) {
      return { delimitedPrefixes: prefix === "releases/" ? releases.map((r) => `releases/${r.manifest.releaseId}/`) : [], truncated: false };
    },
    async get(key) {
      const bytes = await (async () => {
        for (const release of releases) {
          if (key === `releases/${release.manifest.releaseId}/manifest.json`) return release.bytes;
          if (key === `releases/${release.manifest.releaseId}/manifest.signed.json`) return new TextEncoder().encode(JSON.stringify(release.signedManifest));
          if (key.startsWith("blobs/modules/")) return await release.artifacts.blob(key.slice("blobs/modules/".length)).catch(() => undefined);
          if (key.startsWith("blobs/assets/")) return await release.artifacts.asset(key.slice("blobs/assets/".length)).catch(() => undefined);
        }
        return undefined;
      })();
      return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
  };
}

/** The installer's signed test release, under a published release ID. */
async function published(releaseId = "r000001-aaaaaaa"): Promise<TestRelease> {
  return await deriveRelease(await goldenRelease(), releaseId);
}

function riverbend() {
  const fake = new FakeCloudflare({ accountId: ACCOUNT, accessTeam: "riverbend", zones: [{ name: "riverbend.example" }, { name: "educateos.io" }] });
  return { fake, token: fake.issueToken() };
}

function formFor(token: string, overrides: Record<string, string> = {}) {
  return GuidedInstallForm.parse({
    slug: "riverbend", accountId: ACCOUNT, baseDomain: "riverbend.example", accessTeam: "riverbend",
    allowedEmailDomains: "riverbend.example", admins: "it@riverbend.example", token, ...overrides,
  });
}

/**
 * The control plane's slug reservations, as the store keeps them (the store's own tests cover its
 * SQL): one holder per slug, a run lease, and the instance ID a slug was first reserved under.
 */
class Reservations {
  readonly held = new Map<string, { operator: string; accountId: string; instanceId: string; running: boolean }>();
  reserve(operator: string, slug: string, accountId: string, proposed: string): Reservation {
    const held = this.held.get(slug);
    if (held === undefined) {
      this.held.set(slug, { operator, accountId, instanceId: proposed, running: true });
      return { ok: true, instanceId: proposed };
    }
    if (held.operator !== operator || held.accountId !== accountId) return { ok: false, reason: "taken" };
    if (held.running) return { ok: false, reason: "running" };
    held.running = true;
    return { ok: true, instanceId: held.instanceId };
  }
}

async function run(
  form: GuidedInstallForm,
  fake: FakeCloudflare,
  bucket: ReleaseBucket,
  options: { trust?: unknown; reservations?: Reservations; operator?: string; recordFails?: boolean } = {},
) {
  const reservations = options.reservations ?? new Reservations();
  const operator = options.operator ?? OPERATOR.subject;
  const released: boolean[] = [];
  const events: InstallEvent[] = [];
  const recorded: Installation[] = [];
  const registrations: unknown[] = [];
  // The real registry, vouching for this operator's account, as the control plane's does once the
  // installation is recorded.
  const registry = new InstanceRegistry({
    storage: new InMemoryInstanceRegistryStorage(),
    accountVerifier: {
      verifyRegistration: async ({ commercialAccountId, instanceId }) =>
        commercialAccountId === OPERATOR.accountId && recorded.some((r) => r.instanceId === instanceId)
          ? { outcome: "verified" } : { outcome: "refused", reason: "instance-not-confirmed" },
    },
  });
  await runGuidedInstall(form, {
    operator: OPERATOR,
    bucket,
    trust: options.trust ?? ROOT_TRUST,
    reserve: async (slug, accountId, proposed) => reservations.reserve(operator, slug, accountId, proposed),
    end: async (slug, release) => {
      released.push(release);
      if (release) reservations.held.delete(slug);
      else reservations.held.get(slug)!.running = false;
    },
    record: async (installation) => {
      if (options.recordFails) return false;
      recorded.push(installation);
      return true;
    },
    register: async (envelope): Promise<RegistryReply> => {
      registrations.push(envelope);
      return { ok: true, body: await registry.register(envelope) };
    },
    cloudflareApi: (tokens) => fake.api(tokens),
  }, (event) => events.push(event));
  return { events, recorded, registrations, released, reservations };
}

describe("the guided install", () => {
  it("installs the newest signed release into the operator's account and records it, never reporting the token", async () => {
    const golden = await goldenRelease();
    const older = await deriveRelease(golden, "r000001-aaaaaaa");
    const newest = await deriveRelease(golden, "r000002-bbbbbbb");
    const { fake, token } = riverbend();

    const { events, recorded, registrations } = await run(formFor(token), fake, bucketOf(older, newest));

    expect(events[0]).toEqual({ kind: "release", releaseId: "r000002-bbbbbbb", version: "0.2.0" });
    expect(events.at(-1)).toMatchObject({ kind: "done", installation: { slug: "riverbend", hostname: "riverbend.educateos.io", accountId: ACCOUNT } });
    expect(events.filter((event) => event.kind === "step").length).toBeGreaterThan(5);
    expect(fake.serving("riverbend.educateos.io")?.scriptName).toBe("educateos-riverbend-router");
    expect(recorded).toEqual([expect.objectContaining({ instanceId: "ins_riverbend", releaseVersion: "0.2.0" })]);
    // Registration is opt-in: not asked for, so not done.
    expect(registrations).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("registers the installation only when the operator asks, under the operator's account, after recording it", async () => {
    const { fake, token } = riverbend();
    const { events, recorded, registrations } = await run(formFor(token, { register: "on" }), fake, bucketOf(await published()));
    expect(events.find((event) => event.kind === "registration")).toEqual({ kind: "registration", status: "registered" });
    expect(recorded).toHaveLength(1);
    expect(registrations).toEqual([expect.objectContaining({ payload: expect.objectContaining({ commercialAccountId: OPERATOR.accountId, instanceId: "ins_riverbend" }) })]);
  });

  it("refuses a release signed by keys educateos.io doesn't pin, before changing anything", async () => {
    const { fake, token } = riverbend();
    const otherTrust = { ...ROOT_TRUST, keys: [{ ...ROOT_TRUST.keys[0]!, keyId: "ed25519-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }] };
    const before = JSON.stringify(fake.inventory());
    const { events, recorded, released } = await run(formFor(token), fake, bucketOf(await published()), { trust: otherTrust });
    expect(events).toEqual([{ kind: "failed", message: expect.stringMatching(/^unauthenticated: /) }]);
    expect(recorded).toEqual([]);
    expect(JSON.stringify(fake.inventory())).toBe(before);
    // Nothing changed, so the slug is given back.
    expect(released).toEqual([true]);
  });

  it("refuses a slug another operator holds, and says when no release is published", async () => {
    const { fake, token } = riverbend();
    const before = JSON.stringify(fake.inventory());
    const reservations = new Reservations();
    reservations.held.set("riverbend", { operator: "someone-else", accountId: ACCOUNT, instanceId: "ins_riverbend", running: false });
    expect((await run(formFor(token), fake, bucketOf(await published()), { reservations })).events)
      .toEqual([{ kind: "failed", message: "riverbend.educateos.io is already taken." }]);
    expect((await run(formFor(token), fake, bucketOf())).events)
      .toEqual([{ kind: "failed", message: "unavailable: No signed release is published yet." }]);
    expect(JSON.stringify(fake.inventory())).toBe(before);
  });

  it("refuses a second run of a slug while one is running, so a double submit never installs twice", async () => {
    const { fake, token } = riverbend();
    const reservations = new Reservations();
    const release = bucketOf(await published());
    const [first, second] = await Promise.all([
      run(formFor(token), fake, release, { reservations }),
      run(formFor(token), fake, release, { reservations }),
    ]);
    const outcomes = [first, second].map((r) => r.events.at(-1)!.kind).toSorted();
    expect(outcomes).toEqual(["done", "failed"]);
    expect([first, second].find((r) => r.events.at(-1)!.kind === "failed")!.events)
      .toEqual([{ kind: "failed", message: "An install of riverbend.educateos.io is already running. Wait for it to finish." }]);
  });

  it("resumes an interrupted install as the same instance, even for a slug longer than an instance ID", async () => {
    const { fake, token } = riverbend();
    const reservations = new Reservations();
    const release = bucketOf(await published());
    const slug = "riverbend-unified-district";
    fake.interruptMutation(4, { effectApplied: true });
    const interrupted = await run(formFor(token, { slug }), fake, release, { reservations });
    expect(interrupted.events.at(-1)).toMatchObject({ kind: "failed" });
    // The account may have changed, so the slug stays this operator's.
    expect(interrupted.released).toEqual([false]);
    const resumed = await run(formFor(token, { slug }), fake, release, { reservations });
    expect(resumed.events.at(-1)).toMatchObject({ kind: "done", installation: { instanceId: reservations.held.get(slug)!.instanceId } });
    expect(fake.serving(`${slug}.educateos.io`)).toBeDefined();
  });

  it("says plainly when the install landed but educateos.io couldn't record it", async () => {
    const { fake, token } = riverbend();
    const { events } = await run(formFor(token), fake, bucketOf(await published()), { recordFails: true });
    expect(events.at(-1)).toEqual({ kind: "failed", message: expect.stringContaining("is installed in your account, but educateos.io couldn't record it") });
    expect(fake.serving("riverbend.educateos.io")).toBeDefined();
  });

  it("changes nothing when the token is refused, and never echoes it", async () => {
    const { fake } = riverbend();
    const wrong = "w".repeat(40);
    const before = JSON.stringify(fake.inventory());
    const { events, recorded } = await run(formFor(wrong), fake, bucketOf(await published()));
    expect(events.find((event) => event.kind === "report")).toMatchObject({ blocking: [expect.stringMatching(/^credential\./)] });
    expect(events.at(-1)).toEqual({ kind: "failed", message: "Preflight found blocking issues, so nothing was changed." });
    expect(JSON.stringify(fake.inventory())).toBe(before);
    expect(JSON.stringify(events)).not.toContain(wrong);
    expect(recorded).toEqual([]);
  });

  it("picks the newest release by ID and ignores anything that isn't one", async () => {
    const golden = await goldenRelease();
    const a = await deriveRelease(golden, "r000009-ccccccc");
    const b = await deriveRelease(golden, "r000010-ddddddd");
    const bucket = bucketOf(b, a);
    const original = bucket.list;
    bucket.list = async (options) => ({ ...(await original(options)), delimitedPrefixes: [...(await original(options)).delimitedPrefixes, "releases/latest/"] });
    expect((await latestRelease(bucket))?.releaseId).toBe("r000010-ddddddd");
  });
});

describe("the install form", () => {
  it("normalises lists and refuses reserved slugs, bad account IDs and anything that isn't a token", () => {
    expect(formFor("t".repeat(40), { allowedEmailDomains: " Riverbend.example, staff.riverbend.example ", admins: "A@riverbend.example" }))
      .toMatchObject({ allowedEmailDomains: ["riverbend.example", "staff.riverbend.example"], admins: ["a@riverbend.example"], register: false });
    const issues = GuidedInstallForm.safeParse({
      slug: "app", accountId: "nope", baseDomain: "riverbend.example", accessTeam: "riverbend",
      allowedEmailDomains: "riverbend.example", admins: "it@riverbend.example", token: "short",
    }).error?.issues.map((issue) => issue.path[0]);
    expect(issues).toEqual(expect.arrayContaining(["slug", "accountId", "token"]));
  });

  it("proposes the same instance ID for a slug every time, within the installer's 20 characters", async () => {
    expect(await instanceIdFor("riverbend")).toBe("ins_riverbend");
    const long = await instanceIdFor("a-very-long-district-slug-name");
    expect(long).toMatch(/^ins_a-very-long-d-[0-9a-f]{6}$/);
    expect(long.length - 4).toBeLessThanOrEqual(20);
    expect(await instanceIdFor("a-very-long-district-slug-name")).toBe(long);
    expect(await instanceIdFor("a-very-long-district-slug-other")).not.toBe(long);
  });
});
