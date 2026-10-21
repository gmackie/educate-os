// The district administrator's identity-link service: who may decide, what approval writes, what
// the audit trail keeps, and how concurrent or interrupted decisions stay consistent.
import { describe, expect, it } from "vitest";
import { SchoolOsError, type DistrictId } from "@schoolos/contracts";
import { createDirectoryPrincipalResolver, planEmailKeyedMigration } from "@schoolos/identity";
import {
  InMemoryIdentityLinkStore,
  recordPendingAdoptions,
  recordPendingIdentityLink,
  type IdentityLinkStore,
  type IdentityRequestId,
} from "../src/index.ts";
import { accessLink, adoption, AT, caller, NF, NF_ACCESS, northfieldControl, P, WU } from "./support.ts";

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchoolOsError);
    return (error as SchoolOsError).code;
  }
  throw new Error("expected a SchoolOsError");
}

const morganAccess = { issuer: NF_ACCESS, subject: "access-uuid-1042", credential: "person" } as const;

async function proposeAdoption(store: IdentityLinkStore, principalId = P.morgan, workshopUserId = WU.morgan) {
  const [requestId] = await recordPendingAdoptions(store, {
    districtId: NF,
    entries: [{ outcome: "exact-single", email: "x@teachers.example", workshopUserId, pendingAdoption: adoption(principalId, workshopUserId) }],
  }, AT);
  return requestId!;
}

describe("authorization", () => {
  it("lets only the district admin list and decide, through the policy engine", async () => {
    const { store, service, policyAudit } = northfieldControl();
    const requestId = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042"));

    expect(await service.listPending(caller(P.admin))).toHaveLength(1);
    expect(policyAudit.at(-1)).toMatchObject({ effect: "allow", ruleId: "admin.district.identity-links", resourceKind: "identity-link" });

    // A school admin, the teacher being linked, and a student are all refused, and each refusal is audited.
    for (const who of [P.schoolAdmin, P.morgan, P.amara]) {
      expect(await codeOf(() => service.listPending(caller(who)))).toBe("forbidden");
      expect(await codeOf(() => service.approve(caller(who), requestId))).toBe("forbidden");
      expect(await codeOf(() => service.reject(caller(who), requestId))).toBe("forbidden");
      expect(policyAudit.at(-1)).toMatchObject({ principalId: who, effect: "deny" });
    }
    expect((await store.read()).request(requestId)?.status).toBe("pending");
  });

  it("refuses another district's administrator", async () => {
    const { store, service, policyAudit } = northfieldControl();
    const requestId = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042"));
    const riverbendAdmin = caller("prn_rb-district-admin" as never, "dst_riverbend" as DistrictId);
    expect(await codeOf(() => service.listPending(riverbendAdmin))).toBe("forbidden");
    expect(await codeOf(() => service.approve(riverbendAdmin, requestId))).toBe("forbidden");
    expect(policyAudit.at(-1)).toMatchObject({ effect: "deny", ruleId: "precheck.cross-district" });
  });

  it("refuses a malformed or unknown request ID", async () => {
    const { service } = northfieldControl();
    expect(await codeOf(() => service.approve(caller(P.admin), "morgan"))).toBe("validation-failed");
    expect(await codeOf(() => service.approve(caller(P.admin), "idr_nope"))).toBe("not-found");
  });
});

describe("identity links", () => {
  it("links the identity only on approval, and persists the audit event without any email", async () => {
    const { store, directory, service } = northfieldControl();
    const requestId = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042", WU.morgan));
    const resolve = async () => createDirectoryPrincipalResolver((await directory.load()).snapshot).resolve(morganAccess);
    await expect(resolve()).rejects.toMatchObject({ code: "unauthenticated" });

    const outcome = await service.approve(caller(P.admin), requestId);
    expect(outcome.event).toEqual({
      districtId: NF,
      actor: { principalId: P.admin },
      action: "identity-link.approved",
      target: { principalId: P.morgan, identity: { districtId: NF, issuer: NF_ACCESS, subject: "access-uuid-1042" } },
      at: AT,
    });
    await expect(resolve()).resolves.toMatchObject({ principalId: P.morgan });

    const index = await store.read();
    expect(index.auditEvents()).toEqual([outcome.event]);
    expect(index.open()).toEqual([]);
    expect(JSON.stringify(index.entries)).not.toMatch(/@/);
    // A decided request stays decided.
    expect(await codeOf(() => service.approve(caller(P.admin), requestId))).toBe("conflict");
    expect(await codeOf(() => service.reject(caller(P.admin), requestId))).toBe("conflict");
  });

  it("rejects without touching the directory", async () => {
    const { store, directory, service } = northfieldControl();
    const before = (await directory.load()).snapshot;
    const requestId = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042"));
    const { event } = await service.reject(caller(P.admin), requestId);
    expect(event.action).toBe("identity-link.rejected");
    expect((await directory.load()).snapshot).toEqual(before);
    expect((await store.read()).auditEvents()).toEqual([event]);
  });

  it("refuses an identity linked to someone else while it waited, and releases the request for rejection", async () => {
    const { store, service } = northfieldControl();
    const forMorgan = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042"));
    const forRivera = await recordPendingIdentityLink(store, accessLink(P.rivera, "access-uuid-1042"));
    await service.approve(caller(P.admin), forRivera);

    expect(await codeOf(() => service.approve(caller(P.admin), forMorgan))).toBe("conflict");
    expect((await store.read()).request(forMorgan)?.status).toBe("pending");
    await expect(service.reject(caller(P.admin), forMorgan)).resolves.toMatchObject({ event: { action: "identity-link.rejected" } });
  });

  it("finishes an approval interrupted after the directory was written, without linking twice", async () => {
    const inner = new InMemoryIdentityLinkStore(NF);
    let failDecision = true;
    // The store loses the final decision once, as a crash between the two writes would.
    const flaky: IdentityLinkStore = {
      districtId: NF,
      read: () => inner.read(),
      transact: (decide) => inner.transact((index) => {
        const step = decide(index);
        if (failDecision && step.append.some((e) => e.type === "link-decided")) {
          failDecision = false;
          throw new Error("storage went away");
        }
        return step;
      }),
    };
    const { directory, service } = northfieldControl(flaky);
    const requestId = await recordPendingIdentityLink(flaky, accessLink(P.morgan, "access-uuid-1042"));
    await expect(service.approve(caller(P.admin), requestId)).rejects.toThrow("storage went away");

    // The link is in the directory, and the request is mid-approval: it cannot now be rejected.
    expect((await service.listPending(caller(P.admin))).map((r) => r.status)).toEqual(["approving"]);
    expect(await codeOf(() => service.reject(caller(P.admin), requestId))).toBe("conflict");

    await expect(service.approve(caller(P.admin), requestId)).resolves.toMatchObject({ event: { action: "identity-link.approved" } });
    const morgan = (await directory.load()).snapshot.principals.find((p) => p.id === P.morgan)!;
    expect(morgan.externalIdentities.filter((i) => i.issuer === NF_ACCESS)).toHaveLength(1);
  });

  it("records one open request however often the same sign-in repeats", async () => {
    const { store } = northfieldControl();
    const first = await recordPendingIdentityLink(store, accessLink(P.morgan, "access-uuid-1042"));
    const again = await recordPendingIdentityLink(store, { ...accessLink(P.morgan, "access-uuid-1042"), requestedAt: "2026-10-21T10:00:00.000Z" });
    expect(again).toBe(first);
    expect((await store.read()).entries).toHaveLength(1);
  });

  it("refuses to record a link of another district or carrying extra fields", async () => {
    const { store } = northfieldControl();
    const riverbend = { ...accessLink(P.morgan, "x"), districtId: "dst_riverbend", identity: { districtId: "dst_riverbend", issuer: NF_ACCESS, subject: "x" } };
    expect(await codeOf(() => recordPendingIdentityLink(store, riverbend))).toBe("validation-failed");
    expect(await codeOf(() => recordPendingIdentityLink(store, { ...accessLink(P.morgan, "x"), email: "morgan.lee@teachers.example" }))).toBe("validation-failed");
    expect((await store.read()).entries).toEqual([]);
  });
});

describe("Workshop user adoptions", () => {
  it("records only exact-single plan entries, and no email", async () => {
    const { store, directory } = northfieldControl();
    const plan = planEmailKeyedMigration({
      directory: (await directory.load()).snapshot,
      otherDirectories: [],
      users: [
        { email: "sam.rivera@northfield.example", workshopUserId: WU.rivera },
        // Amara and Chidi share a family address: ambiguous, never proposed.
        { email: "family.okafor@northfield.example", workshopUserId: "aa00" },
        { email: "nobody@elsewhere.example", workshopUserId: "bb00" },
      ],
    });
    const ids = await recordPendingAdoptions(store, plan, AT);
    expect(ids).toHaveLength(1);
    const [request] = (await store.read()).open();
    expect(request).toMatchObject({ kind: "workshop-user-adoption", status: "pending", adoption: { principalId: P.rivera, workshopUserId: WU.rivera } });
    expect(JSON.stringify((await store.read()).entries)).not.toMatch(/@/);
    // Re-running the plan proposes nothing new.
    expect(await recordPendingAdoptions(store, plan, AT)).toEqual([]);
  });

  it("records the rebind intent on confirmation and deletes nothing", async () => {
    const { store, directory, service } = northfieldControl();
    const before = (await directory.load()).snapshot;
    const requestId = await proposeAdoption(store);
    const outcome = await service.approve(caller(P.admin), requestId);

    expect(outcome.rebindIntent).toEqual({ districtId: NF, workshopUserId: WU.morgan, principalId: P.morgan, confirmedBy: P.admin, confirmedAt: AT });
    expect(outcome.event).toEqual({
      districtId: NF,
      actor: { principalId: P.admin },
      action: "workshop-user-adoption.confirmed",
      target: { principalId: P.morgan, workshopUserId: WU.morgan },
      at: AT,
    });
    const index = await store.read();
    expect(index.rebindIntents()).toEqual([outcome.rebindIntent]);
    expect(index.auditEvents()).toEqual([outcome.event]);
    // Confirming an adoption is a record of intent: the directory is untouched.
    expect((await directory.load()).snapshot).toEqual(before);
  });

  it("adopts a Workshop user into one principal, and a principal adopts one Workshop user", async () => {
    const { store, service } = northfieldControl();
    await service.approve(caller(P.admin), await proposeAdoption(store, P.morgan, WU.morgan));
    // The same principal again, from a second Workshop user.
    const second = await proposeAdoption(store, P.morgan, WU.rivera);
    expect(await codeOf(() => service.approve(caller(P.admin), second))).toBe("conflict");
    // An adopted Workshop user cannot be proposed again.
    expect(await recordPendingAdoptions(store, {
      districtId: NF,
      entries: [{ outcome: "exact-single", email: "x@teachers.example", workshopUserId: WU.morgan, pendingAdoption: adoption(P.rivera, WU.morgan) }],
    }, AT)).toEqual([]);
    expect((await store.read()).rebindIntents()).toHaveLength(1);
  });

  it("records a rejection with no rebind intent", async () => {
    const { store, service } = northfieldControl();
    const requestId: IdentityRequestId = await proposeAdoption(store);
    const outcome = await service.reject(caller(P.admin), requestId);
    expect(outcome).toMatchObject({ event: { action: "workshop-user-adoption.rejected" } });
    expect(outcome.rebindIntent).toBeUndefined();
    expect((await store.read()).rebindIntents()).toEqual([]);
  });
});
