import { InstanceId } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { canonicalJson, InMemoryInstanceRegistryStorage, InstanceRegistry, DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import { GENESIS_AUDIT_HASH, hashFinanceAuditEvent, InMemoryCommerceStore, type ProcessorRef, verifyFinanceAuditChain } from "../src/index.ts";
import { CLERK, DAY, idsFor, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();

/** A store that fails once, at the very end of a webhook's step, as a crash before commit would. */
class CrashingStore extends InMemoryCommerceStore {
  crashNextMark = false;

  override async markEventProcessed(eventId: ProcessorRef): Promise<void> {
    if (this.crashNextMark) {
      this.crashNextMark = false;
      throw new Error("the object was evicted before the step committed");
    }
    await super.markEventProcessed(eventId);
  }
}

async function chargedInvoice(store?: InMemoryCommerceStore) {
  const context = await setup({ store });
  const { service, accountId } = context;
  await service.ensureProcessorCustomer(accountId, CLERK);
  const subscription = await context.subscribe({ paymentMethod: "card" });
  await service.activate(subscription.subscriptionId, CLERK);
  const invoice = await service.issueInvoice(
    { accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }], dueAt: DUE_AT },
    CLERK,
  );
  await service.chargeInvoice(invoice.invoiceId, CLERK);
  const [delivery] = context.processor.takeDeliveries();
  return { ...context, subscription, invoice, delivery };
}

describe("SCHO-99 a webhook is recorded atomically with its effects", () => {
  it("leaves nothing behind when the step fails after its effects, and applies the redelivery exactly once", async () => {
    const store = new CrashingStore();
    const { service, accountId, invoice, delivery } = await chargedInvoice(store);
    const trail = await service.auditTrail(accountId);
    const records = store.dump();

    store.crashNextMark = true;
    await expect(service.handleProcessorDelivery(delivery)).rejects.toThrow("evicted");
    // The payment, the invoice's settlement and their audit events rolled back with the mark.
    expect(store.dump()).toEqual(records);
    expect(await service.auditTrail(accountId)).toEqual(trail);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("open");

    expect(await service.handleProcessorDelivery(delivery)).toMatchObject({ outcome: "applied" });
    expect(await service.handleProcessorDelivery(delivery)).toMatchObject({ outcome: "duplicate" });
    expect(await service.payments(accountId)).toHaveLength(1);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("paid");
    expect(await service.verifyAuditTrail(accountId)).toMatchObject({ intact: true });
  });

  it("applies one of many concurrent redeliveries of the same event", async () => {
    const { service, accountId, delivery } = await chargedInvoice();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.handleProcessorDelivery(delivery)));
    expect(outcomes.filter((outcome) => outcome.outcome === "applied")).toHaveLength(1);
    expect(await service.payments(accountId)).toHaveLength(1);
  });

  it("counts an operation once when the processor reports it under a second event ID", async () => {
    const { service, accountId, delivery } = await chargedInvoice();
    const { event } = delivery as { event: { eventId: string } };
    await service.handleProcessorDelivery(delivery);
    const again = { tag: "fake-processor", event: { ...event, eventId: "evt_reported-again" } };
    expect(await service.handleProcessorDelivery(again)).toMatchObject({ outcome: "duplicate" });
    expect(await service.payments(accountId)).toHaveLength(1);
  });
});

async function lifecycleTrail() {
  const { service, accountId, delivery } = await chargedInvoice();
  await service.handleProcessorDelivery(delivery);
  return { service, accountId, trail: await service.auditTrail(accountId) };
}

describe("SCHO-99 hash-chained finance audit", () => {
  it("links every event to the one before it, from the genesis hash", async () => {
    const { service, accountId, trail } = await lifecycleTrail();
    expect(trail.map((event) => event.sequence)).toEqual(trail.map((_, i) => i + 1));
    expect(trail[0]!.previousHash).toBe(GENESIS_AUDIT_HASH);
    for (let i = 1; i < trail.length; i++) expect(trail[i]!.previousHash).toBe(trail[i - 1]!.hash);
    expect(await service.verifyAuditTrail(accountId)).toEqual({ intact: true, length: trail.length, headHash: trail.at(-1)!.hash });
  });

  it("finds an edited, removed, reordered or foreign event, at the first event that no longer fits", async () => {
    const { trail } = await lifecycleTrail();
    const edited = structuredClone(trail);
    edited[3]!.after = { ...edited[3]!.after, amountCents: 1 };
    expect(await verifyFinanceAuditChain(edited)).toEqual({ intact: false, index: 3, reason: "hash" });

    const rehashed = structuredClone(edited);
    rehashed[3]!.hash = "f".repeat(64);
    expect(await verifyFinanceAuditChain(rehashed)).toMatchObject({ intact: false, index: 3 });

    expect(await verifyFinanceAuditChain([...trail.slice(0, 2), ...trail.slice(3)])).toEqual({ intact: false, index: 2, reason: "sequence" });
    expect(await verifyFinanceAuditChain([trail[1], trail[0], ...trail.slice(2)])).toEqual({ intact: false, index: 0, reason: "sequence" });

    const riverbend = await setup({ snapshot: RIVERBEND });
    const [foreign] = await riverbend.service.auditTrail(riverbend.accountId);
    expect(await verifyFinanceAuditChain([foreign, ...trail.slice(1)])).toMatchObject({ intact: false, index: 1 });
    expect(await verifyFinanceAuditChain([{ ...trail[0], note: "x" }])).toEqual({ intact: false, index: 0, reason: "malformed" });
  });

  it("verifies a trail begun before the EducateOS rename, hashed in the legacy context (SCHO-232)", async () => {
    const { trail } = await lifecycleTrail();
    const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // The first three events as the code before the rename chained them, then the rest chained on after it.
    const rechained: typeof trail = [];
    for (const [index, event] of trail.entries()) {
      const { hash: _hash, ...fields } = { ...event, previousHash: rechained.at(-1)?.hash ?? GENESIS_AUDIT_HASH };
      const hash = index < 3 ? await sha256(`schoolos-finance-audit/v1\0${canonicalJson(fields)}`) : await hashFinanceAuditEvent(fields); // rename-educateos: keep
      rechained.push({ ...fields, hash });
    }
    expect(rechained[0]!.hash).not.toBe(trail[0]!.hash);
    expect(await verifyFinanceAuditChain(rechained)).toEqual({ intact: true, length: trail.length, headHash: rechained.at(-1)!.hash });
    const edited = structuredClone(rechained);
    edited[1]!.after = { ...edited[1]!.after, amountCents: 1 };
    expect(await verifyFinanceAuditChain(edited)).toEqual({ intact: false, index: 1, reason: "hash" });
  });

  it("stays one unbroken chain under concurrent operations", async () => {
    const { service, accountId } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      service.issueInvoice({ accountId, lines: [{ kind: "support", code: `hours-${i}`, quantity: 1, unitAmountCents: 1_000 }], dueAt: DUE_AT }, CLERK)));
    expect(await service.verifyAuditTrail(accountId)).toMatchObject({ intact: true, length: 12 });
  });
});

describe("SCHO-41 commerce vouches for fleet registrations", () => {
  it("lets the registry accept an instance staff linked to an account with a contact, and refuses the rest", async () => {
    const { service, accountId, instanceId } = await setup({ contactRefs: ["cnt_nf-tech-admin"] });
    const riverbend = idsFor(RIVERBEND);
    await service.openAccount({ accountId: riverbend.accountId, districtLabel: RIVERBEND.district.name }, CLERK);
    await service.linkInstance(riverbend.accountId, riverbend.instanceId, CLERK);
    const registry = new InstanceRegistry({ storage: new InMemoryInstanceRegistryStorage(), accountVerifier: service });

    const register = async (id: InstanceId, account: typeof accountId, label: string) => {
      const agent = new DistrictAgent({ identity: await SigningIdentity.generate(), instanceId: id, sequence: new InMemorySequenceCounter(), sharesAggregateSpend: false });
      return registry.register(await agent.register({
        districtLabel: label, releaseVersion: "0.1.0", capabilityIds: [], contactRole: "district-technology-admin", commercialAccountId: account,
      }));
    };
    await expect(register(instanceId, accountId, NORTHFIELD.district.name)).resolves.toMatchObject({ instanceId });
    // Riverbend's account has no contact on record; an instance nobody linked is refused too.
    await expect(register(riverbend.instanceId, riverbend.accountId, RIVERBEND.district.name)).rejects.toMatchObject({ code: "forbidden" });
    await expect(register(InstanceId.parse("ins_unlinked"), accountId, NORTHFIELD.district.name)).rejects.toMatchObject({ code: "forbidden" });
    expect(await service.verifyRegistration({ commercialAccountId: riverbend.accountId, instanceId: riverbend.instanceId, contactRole: "district-billing" }))
      .toEqual({ outcome: "refused", reason: "contact-unverified" });
  });
});
