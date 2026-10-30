import { env, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
const hash = `sha256:${"a".repeat(64)}`;
const metadata = {
  id: "rsc_blueprint", version: "1.0.0", artifactDigest: hash,
  scope: { level: "district", districtId: "dst_demo" }, author: { id: "prn_author", kind: "staff" },
  instructionalIntent: "practice", gradeBand: "6-8", standards: [], requiredCapabilities: [], license: "MIT",
  provenance: { source: "original", sourceDigest: hash }, accessibility: { features: [], hazards: [], evidenceDigest: hash },
  evaluation: { outcome: "passed", evidenceDigest: hash },
};
const create = { operation: "create", metadata, attestation: { licenseRights: true, noCredentials: true, noLearnerData: true, noSourceChat: true } };
let serial = 0;
function setup() {
  const stub = env.BLUEPRINTS.getByName(`test-${serial++}`);
  const call = async (path = "", actor = "admin", body?: unknown) => {
    const response = await stub.fetch(new Request(`https://district/api/blueprints${path}`, {
    headers: { Authorization: actor }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    }));
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  };
  const execute = (command: unknown, expectedRevision: number, actor = "author") => call("/commands", actor, { command, expectedRevision });
  const step = (action: string, revision: number, actor = "reviewer", requestId = action) => execute({ operation: "transition", id: metadata.id, version: metadata.version, action, requestId }, revision, actor);
  return { stub, call, execute, step };
}
it("persists review and audit across DO eviction, idempotency and revocation; never downloads revoked versions", async () => {
  const { stub, call, execute, step } = setup();
  const retries = await Promise.all(Array.from({ length: 10 }, () => execute(create, 0)));
  expect(retries.every((r) => r.status === 200)).toBe(true);
  expect((await call("/review?id=rsc_blueprint&version=1.0.0", "reviewer")).status).toBe(200);
  expect((await step("submitted", 1, "author")).status).toBe(200);
  expect((await step("reviewed", 2)).status).toBe(200);
  expect((await step("approved", 3)).status).toBe(200);
  await evictDurableObject(stub);
  const before = await (await call()).json() as { revision: number; entries: unknown[] };
  const recovered = await (await call("/review?id=rsc_blueprint&version=1.0.0", "reviewer")).json() as { snapshot: { metadata: unknown; history: unknown[] } };
  expect(recovered.snapshot.metadata).toEqual(metadata);
  expect(recovered.snapshot.history).toHaveLength(3);
  expect(await stub.foreignStorage()).toBe(false);
  expect(before.revision).toBe(4); expect(before.entries).toHaveLength(1);
  expect(JSON.stringify(before.entries)).not.toMatch(/prn_|dst_|Private|actor|attestation|sourceChat/);
  expect((await call("/download?id=rsc_blueprint&version=1.0.0")).status).toBe(200);
  expect((await step("revoked", 4)).status).toBe(200);
  expect((await step("approved", 3)).status).toBe(200);
  await evictDurableObject(stub);
  expect(await (await call()).json()).toEqual({ revision: 5, entries: [] });
  expect((await call("/download?id=rsc_blueprint&version=1.0.0")).status).toBe(403);
  const audit = await (await call("/audit")).json() as { revision: number; command: unknown }[];
  expect(audit).toHaveLength(5);
  expect(audit.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5]);
  expect(audit[0]!.command).toEqual(create);
  expect((await call()).headers.get("Cache-Control")).toBe("no-store");
  expect(await stub.rewrite()).toBe(false);
});
it("serializes concurrent different drafts and rolls back the losing command", async () => {
  const { call, execute } = setup();
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => execute({ ...create, metadata: { ...metadata, version: `1.0.${i}` } }, 0)));
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
  expect(await (await call("/audit")).json()).toHaveLength(1);
});
it("denies cross-district, anonymous and self approval; refuses body actor escalation and incomplete rights/data attestations", async () => {
  const { call, execute, step } = setup();
  expect((await call("", "foreign")).status).toBe(403);
  expect((await call("", "unknown")).status).toBe(401);
  for (const command of [{ ...create, actor: {} }, { ...create, attestation: {} }, { ...create, attestation: { ...create.attestation, noSourceChat: false } }, { ...create, metadata: { ...metadata, license: undefined } }, { ...create, metadata: { ...metadata, credentials: "secret" } }]) {
    expect((await execute(command, 0)).status).toBe(400);
  }
  await execute(create, 0); await step("submitted", 1, "author");
  expect((await step("reviewed", 2, "author")).status).toBe(403);
  expect((await step("approved", 2)).status).toBe(403);
  expect((await call("/audit", "author")).status).toBe(403);
  await step("reviewed", 2);
  expect((await step("approved", 3, "reviewer", "reviewed")).status).toBe(403);
  expect(await (await call("/audit")).json()).toHaveLength(3);
});
it("imports public entries only into quarantine without conveying approval", async () => {
  const a = setup(); await a.execute(create, 0); await a.step("submitted", 1, "author"); await a.step("reviewed", 2); await a.step("approved", 3);
  const { entries } = await (await a.call()).json() as { entries: Record<string, unknown>[] };
  const b = setup();
  expect((await b.call("/imports", "admin", entries)).status).toBe(200);
  expect((await b.call("/imports", "admin", entries)).status).toBe(200);
  await evictDurableObject(b.stub);
  expect(await (await b.call()).json()).toEqual({ revision: 0, entries: [] });
  expect((await b.call("/imports", "author", entries)).status).toBe(403);
  for (const extra of [{ state: "draft" }, { state: "revoked" }, { sourceChat: "private" }, { credentials: {} }, { learnerData: [] }, { license: undefined }]) {
    expect((await b.call("/imports", "admin", [{ ...entries[0], ...extra }])).status).toBe(400);
  }
  expect((await b.call("/imports", "admin", [{ ...entries[0], artifactDigest: `sha256:${"b".repeat(64)}` }])).status).toBe(403);
});
