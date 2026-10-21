// Test worker for the workerd suite: a Durable Object that hosts the root's `CommerceService` over
// `DurableObjectCommerceStore`, the way the root's Worker does, so restarts, a crash mid-step and
// concurrent webhooks reach real Durable Object SQLite storage. Values cross the RPC boundary as
// JSON text, as they would from the network.

import { DurableObject } from "cloudflare:workers";
import { SigningIdentity } from "@schoolos/fleet";
import { CommerceService, FakePaymentProcessor, type ProcessorRef } from "../../src/index.ts";
import { DurableObjectCommerceStore } from "../../src/durable-object-store.ts";
import { CLERK, idsFor, PLANS } from "../support.ts";
import { NORTHFIELD } from "@schoolos/fixtures";

const { accountId } = idsFor(NORTHFIELD);
const DUE_IN_MS = 30 * 24 * 60 * 60_000;

/** A store that can be told to fail at the very end of the next webhook step, as an eviction would. */
class CrashableStore extends DurableObjectCommerceStore {
  crashNextMark = false;

  override async markEventProcessed(eventId: ProcessorRef): Promise<void> {
    if (this.crashNextMark) {
      this.crashNextMark = false;
      throw new Error("the object was evicted before the step committed");
    }
    await super.markEventProcessed(eventId);
  }
}

/** The root's commerce service for one synthetic district. */
export class TestCommerce extends DurableObject {
  readonly #store: CrashableStore;
  readonly #processor = new FakePaymentProcessor();
  #service: Promise<CommerceService>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new CrashableStore(ctx.storage);
    this.#service = SigningIdentity.generate().then((entitlementSigner) =>
      new CommerceService({ store: this.#store, processor: this.#processor, plans: PLANS, entitlementSigner }));
  }

  /** Opens Northfield's account, invoices it and charges the card; returns the invoice and the charge's webhook. */
  async chargedInvoice(): Promise<string> {
    const service = await this.#service;
    await service.openAccount({ accountId, districtLabel: NORTHFIELD.district.name }, CLERK);
    await service.ensureProcessorCustomer(accountId, CLERK);
    const invoice = await service.issueInvoice(
      { accountId, lines: [{ kind: "support", code: "onboarding", quantity: 1, unitAmountCents: 40_000 }], dueAt: new Date(Date.now() + DUE_IN_MS).toISOString() },
      CLERK,
    );
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    return JSON.stringify({ invoiceId: invoice.invoiceId, delivery: this.#processor.takeDeliveries()[0] });
  }

  /** Issues `count` small invoices at once. */
  async issueInvoices(count: number): Promise<void> {
    const service = await this.#service;
    await Promise.all(Array.from({ length: count }, (_, i) => service.issueInvoice(
      { accountId, lines: [{ kind: "support", code: `hours-${i}`, quantity: 1, unitAmountCents: 1_000 }], dueAt: new Date(Date.now() + DUE_IN_MS).toISOString() },
      CLERK,
    )));
  }

  /** Applies a webhook delivery, returning its outcome. */
  async deliver(delivery: string): Promise<string> {
    return (await (await this.#service).handleProcessorDelivery(JSON.parse(delivery))).outcome;
  }

  /** Makes the next webhook step fail just before it commits. */
  async crashNextMark(): Promise<void> {
    this.#store.crashNextMark = true;
  }

  /** What the books say, as JSON text: an invoice's status, the payments, the audit trail and its verification. */
  async books(invoiceId: string): Promise<string> {
    const service = await this.#service;
    return JSON.stringify({
      invoiceStatus: (await service.invoice(invoiceId as never)).status,
      payments: await service.payments(accountId),
      trail: await service.auditTrail(accountId),
      chain: await service.verifyAuditTrail(accountId),
    });
  }

  /** The audit chain's verification, as JSON text. */
  async chain(): Promise<string> {
    return JSON.stringify(await (await this.#service).verifyAuditTrail(accountId));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
