// The district LTI stores over the in-memory record table: single-use takes, the passback ledger's
// claims, and the registration store's directory checks (SCHO-60). The same stores over the Durable
// Object table are exercised under concurrency in `workerd/`.
import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import { LoginState } from "@educateos/lti";
import { InMemoryRecordTable, LTI_COLLECTIONS, LtiStoredRecordError, TableSingleUseStore } from "../src/index.ts";
import { BIO, BIO_CONTEXT, canvasRegistration, CELL_LAB, createDistrict, ENG9, ESSAY, MATH7, NF_CANVAS, rejection } from "./setup.ts";

const login: LoginState = { issuer: NF_CANVAS, clientId: "10000000000001", nonce: "n-1", targetLinkUri: "https://educateos.example/lti/launch" };

describe("TableSingleUseStore", () => {
  it("gives a value to exactly one of many concurrent takes", async () => {
    const { stores, clock } = createDistrict();
    await stores.loginStates.put("state-1", login, clock.ms + 60_000);
    const taken = await Promise.all(Array.from({ length: 20 }, () => stores.loginStates.take("state-1")));
    expect(taken.filter((value) => value !== undefined)).toEqual([login]);
  });

  it("returns nothing once a value has expired, and purges expired values", async () => {
    const { stores, clock, table } = createDistrict();
    await stores.loginStates.put("state-1", login, clock.ms + 1_000);
    clock.ms += 1_000;
    expect(await stores.loginStates.take("state-1")).toBeUndefined();

    await stores.loginStates.put("state-2", login, clock.ms + 1_000);
    clock.ms += 5_000;
    await stores.loginStates.put("state-3", login, clock.ms + 1_000);
    expect(table.list(LTI_COLLECTIONS.loginStates).map(({ key }) => key)).toEqual(["state-3"]);
  });

  it("refuses a key already in use and a value that does not match its schema", async () => {
    const { stores, clock } = createDistrict();
    await stores.loginStates.put("state-1", login, clock.ms + 60_000);
    expect(await rejection(stores.loginStates.put("state-1", login, clock.ms + 60_000))).toBe("conflict");
    await expect(stores.loginStates.put("state-2", { ...login, extra: 1 } as LoginState, clock.ms + 60_000)).rejects.toThrow();
  });

  it("refuses to hand out a stored record that does not match its schema", async () => {
    const table = new InMemoryRecordTable();
    table.put(LTI_COLLECTIONS.loginStates, "tampered", { issuer: "http://insecure.example" }, Date.now() + 60_000);
    await expect(new TableSingleUseStore(table, LTI_COLLECTIONS.loginStates, LoginState).take("tampered")).rejects.toBeInstanceOf(LtiStoredRecordError);
  });
});

describe("TablePassbackLedger", () => {
  it("lets exactly one of many concurrent claims for a version deliver", async () => {
    const { stores } = createDistrict();
    const now = 1_000_000;
    const claims = await Promise.all(Array.from({ length: 20 }, () => stores.passbackLedger.claim("k", 1, 10, now, now + 120_000)));
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "in-progress")).toHaveLength(19);
  });

  it("keeps the shared ledger rules: posted, stale, released and expired leases", async () => {
    const { stores } = createDistrict();
    const ledger = stores.passbackLedger;
    expect(await ledger.claim("k", 2, 20, 0, 100)).toBe("claimed");
    expect(await ledger.claim("k", 1, 10, 0, 100)).toBe("stale");
    expect(await ledger.claim("k", 3, 20, 0, 100)).toBe("stale");
    await ledger.release("k", 2);
    expect(await ledger.claim("k", 2, 20, 1, 100)).toBe("claimed");
    expect(await ledger.claim("k", 2, 20, 200, 300)).toBe("claimed");
    await ledger.complete("k", 2);
    expect(await ledger.claim("k", 2, 20, 400, 500)).toBe("already-posted");
    expect(await ledger.claim("k", 3, 30, 400, 500)).toBe("claimed");
  });
});

describe("TableRegistrationStore", () => {
  it("stores a registration whose offerings and activities exist", async () => {
    const { stores } = createDistrict();
    const registration = canvasRegistration({ activityLinks: [{ offeringId: BIO, linkId: "rl-1", activityId: CELL_LAB }] });
    await stores.registrations.save(registration);
    expect(await stores.registrations.get(registration)).toEqual(registration);
    expect(await stores.registrations.listByIssuer(NF_CANVAS)).toEqual([registration]);
    expect(await rejection(stores.registrations.save(registration))).toBe("conflict");
  });

  it("refuses an unknown offering, an unknown activity, or an activity from another offering", async () => {
    const { stores } = createDistrict();
    const ghost = OfferingId.parse("off_nf-ghost");
    expect(await rejection(stores.registrations.save(canvasRegistration({ offerings: [{ contextId: "c", offeringId: ghost }] })))).toBe("not-found");
    expect(
      await rejection(stores.registrations.save(canvasRegistration({ activityLinks: [{ offeringId: BIO, linkId: "rl-1", activityId: "act_ghost" as never }] }))),
    ).toBe("not-found");
    expect(
      await rejection(stores.registrations.save(canvasRegistration({ activityLinks: [{ offeringId: BIO, linkId: "rl-1", activityId: ESSAY }] }))),
    ).toBe("not-found");
    expect(await stores.registrations.list()).toEqual([]);
  });

  it("refuses an issuer the district does not trust, and another district's registration", async () => {
    const { stores } = createDistrict();
    const untrusted = canvasRegistration({ issuer: "https://canvas.unknown.example" });
    expect(await rejection(stores.registrations.save(untrusted))).toBe("conflict");
    expect(await rejection(stores.registrations.save(canvasRegistration({ districtId: "dst_riverbend" as never })))).toBe("forbidden");
  });

  it("adds deep-linked activities only inside offerings the registration maps, and never overwrites a link", async () => {
    const { stores, activities } = createDistrict();
    const fractions = "act_fractions" as never;
    activities.activities.set(fractions, { scope: { level: "activity", districtId: "dst_northfield", schoolId: "sch_nf-middle", offeringId: MATH7, activityId: fractions } as never, title: "Fractions" });
    await stores.registrations.save(canvasRegistration());
    const key = canvasRegistration();
    await Promise.all([
      stores.registrations.addActivityLink(key, { offeringId: BIO, linkId: "dl-1", activityId: CELL_LAB }),
      stores.registrations.addActivityLink(key, { offeringId: ENG9, linkId: "dl-2", activityId: ESSAY }),
    ]);
    expect((await stores.registrations.get(key))?.activityLinks).toHaveLength(2);
    expect(await rejection(stores.registrations.addActivityLink(key, { offeringId: BIO, linkId: "dl-1", activityId: CELL_LAB }))).toBe("conflict");
    // Math 7 exists but this registration does not map it.
    expect(await rejection(stores.registrations.addActivityLink(key, { offeringId: MATH7, linkId: "dl-3", activityId: fractions }))).toBe("conflict");
    expect(await rejection(stores.registrations.addActivityLink(key, { offeringId: BIO, linkId: "dl-4", activityId: ESSAY }))).toBe("not-found");
  });
});

const services = (membershipsUrl: string) => ({
  registration: { issuer: NF_CANVAS, clientId: "10000000000001" },
  contextId: BIO_CONTEXT,
  nrps: { membershipsUrl },
});

describe("TableGradeColumnStore and TableContextServicesStore", () => {
  it("refuses to move a column binding to another assignment", async () => {
    const { stores } = createDistrict();
    const column = "https://canvas.northfield.example/api/lti/courses/1/line_items/7";
    await stores.gradeColumns.bind({ offeringId: BIO, column, assignmentId: "asg_cell-lab" as never });
    await stores.gradeColumns.bind({ offeringId: BIO, column, assignmentId: "asg_cell-lab" as never });
    expect(await rejection(stores.gradeColumns.bind({ offeringId: BIO, column, assignmentId: "asg_other" as never }))).toBe("conflict");
    expect(await rejection(stores.gradeColumns.bind({ offeringId: BIO, column: `${column}0`, assignmentId: "asg_cell-lab" as never }))).toBe("conflict");
    expect(await stores.gradeColumns.assignmentFor(BIO, column)).toBe("asg_cell-lab");
    expect(await stores.gradeColumns.assignmentFor(ENG9, column)).toBeUndefined();
  });

  it("keeps the newest services a launch reported for a context", async () => {
    const { stores } = createDistrict();
    await stores.contextServices.record({ offeringId: BIO, services: services(`${NF_CANVAS}/new`), observedAt: "2026-10-21T10:00:00Z" });
    await stores.contextServices.record({ offeringId: BIO, services: services(`${NF_CANVAS}/old`), observedAt: "2026-10-21T09:00:00Z" });
    expect((await stores.contextServices.list(BIO)).map((r) => r.services.nrps?.membershipsUrl)).toEqual([`${NF_CANVAS}/new`]);
    expect(await stores.contextServices.list(ENG9)).toEqual([]);
  });
});

describe("InMemoryRecordTable", () => {
  it("keeps none of a step's writes when the step throws", () => {
    const table = new InMemoryRecordTable();
    table.put("c", "a", 1);
    expect(() =>
      table.atomically(() => {
        table.put("c", "a", 2);
        table.put("c", "b", 3);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(table.list("c")).toEqual([{ key: "a", row: { value: 1, expiresAt: undefined } }]);
  });
});
