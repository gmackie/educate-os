// The district's durable stores against real Durable Object SQLite storage, for the paths the
// journeys in district.test.ts do not reach: refused commits store nothing, conflicts are detected
// in storage, and large content is split and reassembled.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { DurableObjectAcademicStore } from "@schoolos/academics/durable-object-store";
import {
  DurableObjectArtifactRecordStore,
  DurableObjectBlobBucket,
  DurableObjectCourseContentStorage,
  DISTRICT_TABLES,
  DurableObjectFundingAllocationStore,
  DurableObjectGuardianInvitationStore,
  DurableObjectGuardianRelationshipStore,
  DurableObjectGradebookStore,
  DurableObjectToolApprovalStore,
  DurableObjectWorkshopUserLinkStore,
} from "@schoolos/district-app/durable-stores";

let objects = 0;
/** A district object no other test has touched, whose storage the tests use directly. */
const fresh = () => env.DISTRICT.getByName(`stores-${objects++}`);

/** A funding allocation revision, over `previousRevisionId` when there is one. */
const revision = (id: string, number: number, previousRevisionId?: string) => ({
  id,
  number,
  allocations: { fpl_courses: "1000" },
  actorPrincipalId: "prn_nf-district-admin",
  appliedAt: "2026-10-22T12:00:00.000Z",
  ...(previousRevisionId === undefined ? {} : { previousRevisionId }),
}) as never;

/** A queued `create_term` call. */
const action = (id: string, idempotencyKey = "a".repeat(64)) => ({
  id,
  tool: "create_term",
  input: { name: "Spring 2027" },
  subject: { principalId: "prn_nf-district-admin", districtId: "dst_northfield" },
  channel: "agent",
  correlationId: "corr-1",
  needs: "confirmation",
  idempotencyKey,
  createdAt: "2026-10-22T12:00:00.000Z",
  expiresAt: "2026-10-29T12:00:00.000Z",
  state: "pending",
}) as never;

describe("DurableObjectAcademicStore", () => {
  it("is seeded once, keeps its directory across a restart, and holds one district", async () => {
    const object = fresh();
    await runInDurableObject(object, async (_instance, state) => {
      const store = DurableObjectAcademicStore.open(state.storage, NORTHFIELD);
      const { version, snapshot } = await store.load();
      expect(version).toBe(0);
      await store.commit({ ...snapshot, terms: snapshot.terms.map((t) => ({ ...t, name: `${t.name} (renamed)` })) }, 0);
      await expect(store.commit(snapshot, 0)).rejects.toMatchObject({ code: "conflict" });
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      // A second open keeps what is stored rather than reseeding.
      const { version, snapshot } = await DurableObjectAcademicStore.open(state.storage, NORTHFIELD).load();
      expect(version).toBe(1);
      expect(snapshot.terms.every((t) => t.name.endsWith("(renamed)"))).toBe(true);
      expect(snapshot.enrollments).toEqual(NORTHFIELD.enrollments);
      expect(() => DurableObjectAcademicStore.open(state.storage, RIVERBEND)).toThrow(/another district/);
    });
  });

  it("refuses a directory row edited outside the store", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = DurableObjectAcademicStore.open(state.storage, NORTHFIELD);
      state.storage.sql.exec("UPDATE academic_terms SET record_json = '{\"id\":\"nope\"}'");
      await expect(store.load()).rejects.toThrow(/unreadable at terms/);
    });
  });
});

describe("DurableObjectArtifactRecordStore", () => {
  it("commits only over the version it was planned against", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectArtifactRecordStore(state.storage);
      const { version, state: records } = await store.load();
      expect(version).toBe(0);
      await store.commit(records, 0);
      await expect(store.commit(records, 0)).rejects.toMatchObject({ code: "conflict" });
      expect((await store.load()).version).toBe(1);
    });
  });
});

describe("DurableObjectBlobBucket", () => {
  it("splits a large object into parts and reads back exactly its bytes", async () => {
    const object = fresh();
    const bytes = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => i % 251);
    const hex = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
    await runInDurableObject(object, async (_instance, state) => {
      const bucket = new DurableObjectBlobBucket(state.storage);
      await bucket.put("sha256/large", bytes, { sha256: hex });
      await expect(bucket.put("sha256/wrong", bytes, { sha256: "0".repeat(64) })).rejects.toThrow(/do not match/);
      expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM schoolos_artifact_blob_parts WHERE key = 'sha256/large'").one().n)).toBe(3);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const bucket = new DurableObjectBlobBucket(state.storage);
      expect(await bucket.head("sha256/large")).toEqual({ size: bytes.byteLength });
      expect(new Uint8Array(await (await bucket.get("sha256/large"))!.arrayBuffer())).toEqual(bytes);
      expect(await bucket.get("sha256/wrong")).toBeNull();
      await bucket.put("other/x", new Uint8Array([1]));
      expect((await bucket.list({ prefix: "sha256/" })).objects.map((o) => o.key)).toEqual(["sha256/large"]);
      await bucket.delete("sha256/large");
      expect(await bucket.head("sha256/large")).toBeNull();
    });
  });
});

describe("DurableObjectFundingAllocationStore", () => {
  it("appends a revision only over the head the administrator saw", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectFundingAllocationStore(state.storage);
      await store.append(revision("far_one", 1), undefined);
      await expect(store.append(revision("far_two", 2), undefined)).rejects.toMatchObject({ code: "conflict" });
      await store.append(revision("far_two", 2, "far_one"), "far_one");
      expect((await store.list()).map((r) => r.id)).toEqual(["far_one", "far_two"]);
    });
  });
});

describe("DurableObjectWorkshopUserLinkStore", () => {
  it("refuses a link that does not match its schema, and stores nothing of it", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectWorkshopUserLinkStore(state.storage);
      await expect(store.add({ nope: true } as never)).rejects.toThrow();
      expect(await store.list()).toEqual([]);
    });
  });
});

describe("DurableObjectToolApprovalStore", () => {
  it("returns the open action for a repeated call, and lets one of two transitions win", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectToolApprovalStore(state.storage);
      const first = await store.insertUnlessOpen(action("apr_one"));
      expect(await store.insertUnlessOpen(action("apr_two"))).toEqual(first);
      const claimed = { ...(first as object), state: "claimed" } as never;
      expect(await store.transition("apr_one" as never, "pending", claimed)).toBe(true);
      expect(await store.transition("apr_one" as never, "pending", claimed)).toBe(false);
      // Once it is no longer open, the same call queues a new action.
      const declined = { ...(first as object), state: "declined" } as never;
      expect(await store.transition("apr_one" as never, "claimed", declined)).toBe(true);
      expect(await store.insertUnlessOpen(action("apr_two"))).toMatchObject({ id: "apr_two", state: "pending" });
      expect((await store.list()).map((a) => a.id)).toEqual(["apr_one", "apr_two"]);
    });
  });
});

describe("DurableObjectCourseContentStorage", () => {
  const outline = (revision: number, body: string) => ({
    offeringId: "off_nf-bio-fall-p2",
    revision,
    modules: [
      { id: "cmod_b", title: "Unit 2", published: false, items: [{ kind: "page", id: "cit_2", pageId: "cpg_z" }] },
      { id: "cmod_a", title: "Unit 1", published: true, items: [{ kind: "page", id: "cit_1", pageId: "cpg_a" }, { kind: "activity", id: "cit_3", activityId: "act_bio-cells" }] },
    ],
    pages: [{ id: "cpg_z", title: "Later", body }, { id: "cpg_a", title: "First", body: "# Hello" }],
    updated: { by: "prn_nf-morgan-lee", at: "2026-10-23T12:00:00.000Z" },
  }) as never;

  it("keeps modules and pages in order across a restart, and commits only over the revision it read", async () => {
    const object = fresh();
    // A page near the length limit, in characters that take three bytes each in UTF-8.
    const long = "\u2603".repeat(19_000);
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectCourseContentStorage(state.storage);
      expect(await store.load("off_nf-bio-fall-p2" as never)).toBeUndefined();
      await store.commit(outline(1, long), 0);
      await expect(store.commit(outline(2, "x"), 0)).rejects.toMatchObject({ code: "conflict" });
      await store.commit(outline(2, long), 1);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const stored = await new DurableObjectCourseContentStorage(state.storage).load("off_nf-bio-fall-p2" as never);
      expect(stored).toStrictEqual(outline(2, long));
      expect(await new DurableObjectCourseContentStorage(state.storage).load("off_nf-eng9-fall-p3" as never)).toBeUndefined();
    });
  });

  it("refuses an outline that does not match its schema, and stores nothing of it", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectCourseContentStorage(state.storage);
      await expect(store.commit({ ...(outline(1, "<script>x</script>") as object), revision: 1 } as never, 0)).rejects.toThrow();
      expect(await store.load("off_nf-bio-fall-p2" as never)).toBeUndefined();
    });
  });
});

// Guardians (ADR-0012, SCHO-188)

/** A guardian relationship of Amara's, in `status`. */
const relationship = (status: "pending" | "active", guardian = "prn_nf-guardian-gina") => ({
  id: "grl_gina-amara",
  districtId: "dst_northfield",
  guardianPrincipalId: guardian,
  studentPrincipalId: "prn_nf-student-amara",
  status,
  readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
  consent: "not-required",
  validFrom: "2026-10-22T12:00:00.000Z",
  created: { by: "prn_nf-district-admin", at: "2026-10-22T12:00:00.000Z" },
  ...(status === "active" ? { confirmed: { by: "prn_nf-district-admin", at: "2026-10-22T13:00:00.000Z" } } : {}),
}) as never;

/** The audit event of `change` on {@link relationship}. */
const event = (change: string, guardian = "prn_nf-guardian-gina") => ({
  districtId: "dst_northfield",
  actor: { principalId: "prn_nf-district-admin" },
  action: `guardian-relationship.${change}`,
  target: { relationshipId: "grl_gina-amara", guardianPrincipalId: guardian, studentPrincipalId: "prn_nf-student-amara" },
  at: "2026-10-22T13:00:00.000Z",
}) as never;

describe("DurableObjectGuardianRelationshipStore", () => {
  it("commits a change with its audit event only over the record it was planned against, and keeps both across a restart", async () => {
    const object = fresh();
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGuardianRelationshipStore(state.storage);
      await store.commit(relationship("pending"), event("recorded"), undefined);
      // A second "first" commit, and one planned against a record that has since changed, are refused.
      await expect(store.commit(relationship("pending"), event("recorded"), undefined)).rejects.toMatchObject({ code: "conflict" });
      await store.commit(relationship("active"), event("confirmed"), relationship("pending"));
      await expect(store.commit(relationship("active"), event("confirmed"), relationship("pending"))).rejects.toMatchObject({ code: "conflict" });
      // An event that names another relationship is refused before anything is written.
      await expect(store.commit(relationship("active"), event("revoked", "prn_nf-guardian-gus"), relationship("active"))).rejects.toThrow();
      // The history is append-only in storage, whatever writes to it.
      expect(() => state.storage.sql.exec(`DELETE FROM ${DISTRICT_TABLES.guardianRelationshipEvents}`)).toThrow(/append-only/);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGuardianRelationshipStore(state.storage);
      expect(await store.get("grl_gina-amara" as never)).toMatchObject({ status: "active" });
      expect((await store.listForGuardian("prn_nf-guardian-gina" as never)).map((r) => r.id)).toEqual(["grl_gina-amara"]);
      expect((await store.listForStudent("prn_nf-student-amara" as never)).map((r) => r.id)).toEqual(["grl_gina-amara"]);
      expect(await store.listForGuardian("prn_nf-guardian-gus" as never)).toEqual([]);
      expect((await store.history("grl_gina-amara" as never)).map((e) => e.action)).toEqual(["guardian-relationship.recorded", "guardian-relationship.confirmed"]);
    });
  });

  it("refuses to decide on a stored relationship that no longer matches its schema", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectGuardianRelationshipStore(state.storage);
      await store.commit(relationship("pending"), event("recorded"), undefined);
      state.storage.sql.exec(`UPDATE ${DISTRICT_TABLES.guardianRelationships} SET relationship_json = ?`, JSON.stringify({ status: "active" }));
      await expect(store.listForGuardian("prn_nf-guardian-gina" as never)).rejects.toThrow(/schema/);
    });
  });
});

describe("DurableObjectGuardianInvitationStore", () => {
  const invitation = {
    id: "gin_00000000-0000-4000-8000-000000000001",
    districtId: "dst_northfield",
    studentPrincipalId: "prn_nf-student-amara",
    relationshipId: "grl_gina-amara",
    reservedGuardianPrincipalId: "prn_g-gina",
    guardianDisplayName: "Gina Okafor",
    tokenDigest: "a".repeat(64),
    created: { by: "prn_nf-district-admin", at: "2026-10-22T12:00:00.000Z" },
    expiresAt: "2026-10-29T12:00:00.000Z",
  } as never;
  const redemption = { at: "2026-10-23T12:00:00.000Z", outcome: "awaiting-approval", guardianPrincipalId: "prn_g-gina", requestId: "idr_one" } as never;

  it("is found by its token's digest, and claimed exactly once, across a restart", async () => {
    const object = fresh();
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGuardianInvitationStore(state.storage);
      await store.add(invitation);
      await expect(store.add(invitation)).rejects.toThrow();
      expect(await store.claim((invitation as { id: never }).id, redemption)).toBe(true);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGuardianInvitationStore(state.storage);
      expect(await store.claim((invitation as { id: never }).id, redemption)).toBe(false);
      expect(await store.claim("gin_00000000-0000-4000-8000-000000000002" as never, redemption)).toBe(false);
      expect(await store.findByTokenDigest("a".repeat(64))).toMatchObject({ redeemed: { outcome: "awaiting-approval", requestId: "idr_one" } });
      expect(await store.findByTokenDigest("b".repeat(64))).toBeUndefined();
      expect((await store.listForStudent("prn_nf-student-amara" as never)).map((i) => i.id)).toEqual([(invitation as { id: string }).id]);
    });
  });
});

// Gradebook (SCHO-187)
describe("DurableObjectGradebookStore", () => {
  const BIO = "off_nf-bio-fall-p2" as never;
  const settings = (weight: number) => ({
    weighting: "group-weights",
    calculation: "points",
    missing: "zero",
    groups: [{ id: "grp_labs", name: "Labs", weight, dropLowest: 1, assignmentIds: ["asg_lab-1", "asg_lab-2"] }],
    scale: [{ letter: "A", minPercent: 90 }, { letter: "F", minPercent: 0 }],
  }) as never;
  const updated = { by: "prn_nf-morgan-lee", at: "2026-10-23T12:00:00.000Z" } as never;
  const marker = (assignmentId: string, studentPrincipalId: string, kind: string) =>
    ({ assignmentId, studentPrincipalId, marker: kind, setBy: "prn_nf-morgan-lee", setAt: "2026-10-23T12:00:00.000Z" }) as never;

  it("keeps settings and markers across a restart, and saves settings only over the revision read", async () => {
    const object = fresh();
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGradebookStore(state.storage);
      expect(await store.load(BIO)).toStrictEqual({ revision: 0, markers: [] });
      expect(await store.saveSettings(BIO, settings(60), updated, 0)).toBe(1);
      await expect(store.saveSettings(BIO, settings(70), updated, 0)).rejects.toMatchObject({ code: "conflict" });
      expect(await store.saveSettings(BIO, settings(80), updated, 1)).toBe(2);
      await store.setMarker(BIO, "asg_lab-2" as never, "prn_nf-student-amara" as never, marker("asg_lab-2", "prn_nf-student-amara", "late"));
      await store.setMarker(BIO, "asg_lab-1" as never, "prn_nf-student-elena" as never, marker("asg_lab-1", "prn_nf-student-elena", "excused"));
      // A second marker on a cell replaces the first; clearing removes it.
      await store.setMarker(BIO, "asg_lab-2" as never, "prn_nf-student-amara" as never, marker("asg_lab-2", "prn_nf-student-amara", "missing"));
      await store.setMarker(BIO, "asg_lab-1" as never, "prn_nf-student-elena" as never, undefined);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectGradebookStore(state.storage);
      expect(await store.load(BIO)).toStrictEqual({ revision: 2, settings: settings(80), updated, markers: [marker("asg_lab-2", "prn_nf-student-amara", "missing")] });
      expect(await store.load("off_nf-eng9-fall-p3" as never)).toStrictEqual({ revision: 0, markers: [] });
    });
  });

  it("refuses settings that do not match their schema and a marker for another cell, storing nothing", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectGradebookStore(state.storage);
      await expect(store.saveSettings(BIO, { ...(settings(50) as object), scale: [] } as never, updated, 0)).rejects.toThrow();
      await expect(store.setMarker(BIO, "asg_lab-1" as never, "prn_nf-student-amara" as never, marker("asg_lab-2", "prn_nf-student-amara", "late"))).rejects.toMatchObject({ code: "validation-failed" });
      expect(await store.load(BIO)).toStrictEqual({ revision: 0, markers: [] });
    });
  });
});
