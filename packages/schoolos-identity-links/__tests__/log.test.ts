// The identity-link log's own rules, which every store enforces before it commits: a store can
// never hold a decision that skipped a step, a second decision, or an event naming someone else.
import { describe, expect, it } from "vitest";
import { SchoolOsError } from "@schoolos/contracts";
import { IdentityLinkIndex, InMemoryIdentityLinkStore, type IdentityLinkEntry, type IdentityRequestId } from "../src/index.ts";
import { accessLink, adoption, AT, NF, NF_ACCESS, P, WU } from "./support.ts";

const LINK = "idr_link-1" as IdentityRequestId;
const ADOPT = "idr_adopt-1" as IdentityRequestId;

const requested: IdentityLinkEntry = { type: "link-requested", requestId: LINK, link: accessLink(P.morgan, "access-uuid-1042") };
const approvedEvent = {
  districtId: NF,
  actor: { principalId: P.admin },
  action: "identity-link.approved" as const,
  target: { principalId: P.morgan, identity: { districtId: NF, issuer: NF_ACCESS, subject: "access-uuid-1042" } },
  at: AT,
};
const proposed: IdentityLinkEntry = { type: "adoption-proposed", requestId: ADOPT, adoption: adoption(P.morgan, WU.morgan), proposedAt: AT };
const confirmedEvent = {
  districtId: NF,
  actor: { principalId: P.admin },
  action: "workshop-user-adoption.confirmed" as const,
  target: { principalId: P.morgan, workshopUserId: WU.morgan },
  at: AT,
};
const intent = { districtId: NF, workshopUserId: WU.morgan, principalId: P.morgan, confirmedBy: P.admin, confirmedAt: AT };

function refusal(entries: unknown[]): string {
  let folded: IdentityLinkIndex | undefined;
  try {
    folded = new IdentityLinkIndex(NF, entries as IdentityLinkEntry[]);
  } catch (error) {
    expect(error).toBeInstanceOf(SchoolOsError);
    return (error as SchoolOsError).code;
  }
  throw new Error(`expected the log to be refused, but it folded ${folded.entries.length} entries`);
}

describe("IdentityLinkIndex", () => {
  it("folds a full approval", () => {
    const index = new IdentityLinkIndex(NF, [
      requested,
      { type: "link-approval-started", requestId: LINK, actorId: P.admin, at: AT },
      { type: "link-decided", requestId: LINK, event: approvedEvent },
    ]);
    expect(index.request(LINK)?.status).toBe("approved");
    expect(index.auditEvents()).toEqual([approvedEvent]);
  });

  it("refuses an approval that never started, and a second decision", () => {
    expect(refusal([requested, { type: "link-decided", requestId: LINK, event: approvedEvent }])).toBe("conflict");
    const rejected = { ...approvedEvent, action: "identity-link.rejected" };
    expect(refusal([requested, { type: "link-decided", requestId: LINK, event: rejected }, { type: "link-decided", requestId: LINK, event: rejected }])).toBe("conflict");
  });

  it("refuses a decision whose audit event names someone else", () => {
    const elsewhere = { ...approvedEvent, target: { ...approvedEvent.target, principalId: P.rivera } };
    expect(refusal([
      requested,
      { type: "link-approval-started", requestId: LINK, actorId: P.admin, at: AT },
      { type: "link-decided", requestId: LINK, event: elsewhere },
    ])).toBe("conflict");
  });

  it("requires a confirmed adoption to carry its own rebind intent, and a rejection none", () => {
    expect(refusal([proposed, { type: "adoption-decided", requestId: ADOPT, event: confirmedEvent }])).toBe("conflict");
    expect(refusal([proposed, { type: "adoption-decided", requestId: ADOPT, event: confirmedEvent, rebindIntent: { ...intent, principalId: P.rivera } }])).toBe("conflict");
    const rejected = { ...confirmedEvent, action: "workshop-user-adoption.rejected" };
    expect(refusal([proposed, { type: "adoption-decided", requestId: ADOPT, event: rejected, rebindIntent: intent }])).toBe("conflict");
  });

  it("refuses entries of another district and entries carrying profile data", () => {
    const riverbend = { ...requested, link: { ...requested.link, districtId: "dst_riverbend", identity: { ...requested.link.identity, districtId: "dst_riverbend" } } };
    expect(refusal([riverbend])).toBe("validation-failed");
    expect(refusal([{ ...requested, email: "morgan.lee@teachers.example" }])).toBe("validation-failed");
    expect(refusal([{ ...proposed, adoption: { ...proposed.adoption, email: "morgan.lee@teachers.example" } }])).toBe("validation-failed");
  });

  it("refuses a reused request ID and a second open request for one link", () => {
    expect(refusal([requested, { ...proposed, requestId: LINK }])).toBe("conflict");
    expect(refusal([requested, { ...requested, requestId: "idr_link-2" }])).toBe("conflict");
  });
});

describe("InMemoryIdentityLinkStore", () => {
  it("commits a step's entries together or not at all", async () => {
    const store = new InMemoryIdentityLinkStore(NF);
    await expect(store.transact(() => ({ append: [requested, { type: "link-decided", requestId: LINK, event: approvedEvent }], result: undefined })))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await store.read()).entries).toEqual([]);
  });

  it("hands out snapshots that cannot change what is stored", async () => {
    const store = new InMemoryIdentityLinkStore(NF);
    await store.transact(() => ({ append: [requested], result: undefined }));
    const snapshot = await store.read();
    snapshot.apply({ type: "link-approval-started", requestId: LINK, actorId: P.admin, at: AT });
    expect((await store.read()).request(LINK)?.status).toBe("pending");
  });
});
