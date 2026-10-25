// `DurableObjectIdentityLinkStore` in workerd, against real Durable Object SQLite storage: a
// restarted control object replays to the same requests, decisions and audit trail; concurrent
// decisions never adopt one principal twice or duplicate a request; and history cannot be
// rewritten, nor a tampered log trusted.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectIdentityLinkStore, IDENTITY_LINK_ENTRIES_TABLE, IdentityLinkLogCorruptionError } from "../../src/durable-object-store.ts";
import { accessLink, adoption, NF, P, WU } from "../support.ts";

let controls = 0;
const fresh = () => env.IDENTITY_CONTROL.getByName(`dst_northfield-${controls++}`);

const value = <T>(result: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
};

const plan = (pairs: [typeof P[keyof typeof P], typeof WU[keyof typeof WU]][]) => ({
  districtId: NF,
  entries: pairs.map(([principalId, workshopUserId]) => ({
    outcome: "exact-single",
    email: "someone@teachers.example",
    workshopUserId,
    pendingAdoption: adoption(principalId, workshopUserId),
  })),
});

describe("DurableObjectIdentityLinkStore", () => {
  it("replays a restarted control object to the same requests, decisions and audit trail", async () => {
    const control = fresh();
    const link = value(await control.recordLink(accessLink(P.morgan, "access-uuid-1042")));
    const [adopt] = value(await control.proposeAdoptions(plan([[P.rivera, WU.rivera]])));
    value(await control.approve(P.admin, link));
    value(await control.approve(P.admin, adopt!));
    const entries = await control.entries();
    const audit = await control.auditEvents();
    const intents = await control.rebindIntents();
    expect(audit.map((e) => e.action)).toEqual(["identity-link.approved", "workshop-user-adoption.confirmed"]);
    expect(intents).toEqual([expect.objectContaining({ principalId: P.rivera, workshopUserId: WU.rivera, confirmedBy: P.admin })]);

    await evictDurableObject(control);
    expect(await control.entries()).toEqual(entries);
    expect(await control.auditEvents()).toEqual(audit);
    expect(await control.rebindIntents()).toEqual(intents);
    // ...and still knows both are decided.
    expect(await control.approve(P.admin, link)).toEqual({ ok: false, code: "conflict" });
    expect(await control.reject(P.admin, adopt!)).toEqual({ ok: false, code: "conflict" });
    expect(value(await control.listPending(P.admin))).toEqual([]);
  });

  it("keeps one open request when the same sign-in arrives many times at once", async () => {
    const control = fresh();
    const ids = await Promise.all(Array.from({ length: 20 }, () => control.recordLink(accessLink(P.morgan, "access-uuid-1042"))));
    expect(new Set(ids.map(value)).size).toBe(1);
    expect(await control.entries()).toHaveLength(1);
  });

  it("confirms exactly one of two concurrent adoptions into the same principal", async () => {
    const control = fresh();
    const ids = value(await control.proposeAdoptions(plan([[P.morgan, WU.morgan], [P.morgan, WU.rivera]])));
    const results = await Promise.all(ids.map((id) => control.approve(P.admin, id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "conflict" }]);
    await evictDurableObject(control);
    expect(await control.rebindIntents()).toHaveLength(1);
  });

  it("decides a request once when an approval and a rejection race", async () => {
    const control = fresh();
    const id = value(await control.recordLink(accessLink(P.morgan, "access-uuid-1042")));
    const [approved, rejected] = await Promise.all([control.approve(P.admin, id), control.reject(P.admin, id)]);
    expect([approved.ok, rejected.ok].filter(Boolean)).toHaveLength(1);
    expect(await control.auditEvents()).toHaveLength(1);
  });

  it("keeps the log append-only at the storage layer", async () => {
    const control = fresh();
    value(await control.recordLink(accessLink(P.morgan, "access-uuid-1042")));
    await runInDurableObject(control, (_, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${IDENTITY_LINK_ENTRIES_TABLE} SET entry_type = 'link-decided'`)).toThrow(/append-only/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${IDENTITY_LINK_ENTRIES_TABLE}`)).toThrow(/append-only/);
    });
    expect(await control.entries()).toHaveLength(1);
  });

  it("refuses to load a log whose rows break its rules", async () => {
    const control = fresh();
    const id = value(await control.recordLink(accessLink(P.morgan, "access-uuid-1042")));
    await runInDurableObject(control, async (_, state) => {
      // A decision inserted behind the store's back, skipping the approval's start.
      const forged = {
        type: "link-decided",
        requestId: id,
        event: {
          districtId: NF,
          actor: { principalId: P.morgan },
          action: "identity-link.approved",
          target: { principalId: P.morgan, identity: accessLink(P.morgan, "access-uuid-1042").identity },
          at: "2026-10-21T09:00:00.000Z",
        },
      };
      state.storage.sql.exec(
        `INSERT INTO ${IDENTITY_LINK_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (1, 'link-decided', ?, ?)`,
        id,
        JSON.stringify(forged),
      );
      await expect(new DurableObjectIdentityLinkStore(state.storage, NF).read()).rejects.toThrow(IdentityLinkLogCorruptionError);
    });
  });

  it("refuses a row of an unknown schema version", async () => {
    const control = fresh();
    value(await control.recordLink(accessLink(P.morgan, "access-uuid-1042")));
    await runInDurableObject(control, async (_, state) => {
      state.storage.sql.exec(`INSERT INTO ${IDENTITY_LINK_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (9, 'link-requested', 'idr_x', '{}')`);
      await expect(new DurableObjectIdentityLinkStore(state.storage, NF).read()).rejects.toThrow(/unknown entry schema version 9/);
    });
  });
});
