import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import {
  EntitlementCache,
  type EntitlementEvaluation,
  InMemoryEntitlementStore,
  type SignedEnvelope,
  signEnvelope,
  SigningIdentity,
} from "../src/index.ts";
import { DAY, instanceIdFor, manualClock } from "./support.ts";

const ISSUED = "2026-10-20T12:00:00.000Z";

async function setup() {
  const clock = manualClock(ISSUED);
  const root = await SigningIdentity.generate();
  const store = new InMemoryEntitlementStore();
  const cache = new EntitlementCache({
    instanceId: instanceIdFor(NORTHFIELD),
    rootPublicKey: root.publicKey,
    store,
    now: clock.now,
  });
  const entitlement = (overrides: Record<string, unknown> = {}, signer = root) =>
    signEnvelope(signer, "entitlement", {
      instanceId: instanceIdFor(NORTHFIELD),
      revision: 1,
      capabilityIds: ["core-learning"],
      issuedAt: ISSUED,
      validUntil: new Date(Date.parse(ISSUED) + 30 * DAY).toISOString(),
      graceUntil: new Date(Date.parse(ISSUED) + 44 * DAY).toISOString(),
      ...overrides,
    });
  return { clock, root, store, cache, entitlement };
}

const rootUnreachable = () => Promise.reject(new Error("connect ECONNREFUSED"));

// Classroom features never depend on the root; the type allows no other value.
function expectClassroomUnaffected(evaluation: EntitlementEvaluation) {
  const classroom: "unaffected" = evaluation.classroom;
  expect(classroom).toBe("unaffected");
}

describe("entitlement cache: root outage independence", () => {
  it("keeps the district running on its held entitlement while the root is unreachable, through the grace period", async () => {
    const { clock, cache, entitlement } = await setup();
    await cache.accept(await entitlement());

    clock.advance(20 * DAY);
    const during = await cache.refresh(rootUnreachable);
    expect(during.outcome).toBe("root-unreachable");
    expect(during.evaluation).toMatchObject({ state: "valid", rootManagedChanges: "allowed" });

    clock.advance(15 * DAY); // past validUntil, inside grace
    const grace = await cache.refresh(rootUnreachable);
    expect(grace.evaluation).toMatchObject({ state: "grace", rootManagedChanges: "allowed", capabilityIds: ["core-learning"] });
    expectClassroomUnaffected(grace.evaluation);
  });

  it("after the grace period stops only new root-managed changes", async () => {
    const { clock, cache, entitlement } = await setup();
    await cache.accept(await entitlement());
    clock.advance(45 * DAY);

    const { outcome, evaluation } = await cache.refresh(rootUnreachable);
    expect(outcome).toBe("root-unreachable");
    expect(evaluation).toMatchObject({ state: "lapsed", rootManagedChanges: "blocked" });
    expectClassroomUnaffected(evaluation);
  });

  it("with no entitlement at all blocks root-managed changes and nothing else", async () => {
    const { cache } = await setup();
    const evaluation = await cache.evaluate();
    expect(evaluation).toMatchObject({ state: "absent", rootManagedChanges: "blocked", capabilityIds: [] });
    expectClassroomUnaffected(evaluation);
  });

  it("takes a newer entitlement when the root comes back", async () => {
    const { clock, cache, entitlement } = await setup();
    await cache.accept(await entitlement());
    clock.advance(45 * DAY);
    const renewed = await entitlement({
      revision: 2,
      issuedAt: clock.now().toISOString(),
      validUntil: new Date(clock.now().getTime() + 30 * DAY).toISOString(),
      graceUntil: new Date(clock.now().getTime() + 44 * DAY).toISOString(),
    });
    const { outcome, evaluation } = await cache.refresh(async () => JSON.parse(JSON.stringify(renewed)));
    expect(outcome).toBe("updated");
    expect(evaluation).toMatchObject({ state: "valid", rootManagedChanges: "allowed" });
  });
});

describe("entitlement cache: what it accepts", () => {
  it("rejects an entitlement not signed by the pinned root key", async () => {
    const { cache, entitlement } = await setup();
    const forged = await entitlement({}, await SigningIdentity.generate());
    expect((await cache.refresh(async () => forged)).outcome).toBe("rejected");
    expect((await cache.evaluate()).state).toBe("absent");
  });

  it("rejects an entitlement for another instance", async () => {
    const { cache, entitlement } = await setup();
    const riverbends = await entitlement({ instanceId: instanceIdFor(RIVERBEND) });
    await expect(cache.accept(riverbends)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("refuses to roll back to an older revision", async () => {
    const { cache, entitlement } = await setup();
    const first = await entitlement();
    await cache.accept(await entitlement({ revision: 2 }));
    await expect(cache.accept(first)).rejects.toMatchObject({ code: "conflict" });
    expect((await cache.refresh(async () => first)).outcome).toBe("unchanged");
  });

  it("rejects a grace period that ends before validity does", async () => {
    const { cache, entitlement } = await setup();
    const inverted = await entitlement({ graceUntil: ISSUED });
    expect((await cache.refresh(async () => inverted)).outcome).toBe("rejected");
  });

  it("treats a locally tampered copy as absent rather than extending it", async () => {
    const { clock, store, cache, entitlement } = await setup();
    await cache.accept(await entitlement());
    const held = (await store.load()) as SignedEnvelope;
    await store.save({ ...held, payload: { ...(held.payload as object), graceUntil: "2099-01-01T00:00:00.000Z" } });
    clock.advance(60 * DAY);
    const evaluation = await cache.evaluate();
    expect(evaluation).toMatchObject({ state: "absent", rootManagedChanges: "blocked" });
    expectClassroomUnaffected(evaluation);
  });
});
