// Test worker for the workerd suite: Durable Objects that host the district's release manager and
// the root's rollout store the way deployed Workers do, so restarts and concurrent requests reach
// real Durable Object SQLite storage. Values cross the RPC boundary as JSON text, as they would
// from the network.

import { DurableObject } from "cloudflare:workers";
import { InstanceId } from "@schoolos/contracts";
import { ReleaseChannel } from "@schoolos/fleet";
import { DistrictReleaseManager, InstalledRelease, ReleaseTrust } from "../../src/index.ts";
import { DurableObjectDistrictReleaseStore, DurableObjectRolloutStore } from "../../src/durable-object-store.ts";
import { entitlementIn } from "../support.ts";

/** One district's release manager over Durable Object storage. */
export class TestDistrict extends DurableObject {
  readonly #store: DurableObjectDistrictReleaseStore;
  #manager: DistrictReleaseManager | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new DurableObjectDistrictReleaseStore(ctx.storage);
  }

  /** Pins the trust and running release the manager starts from when its store is empty. */
  async pin(trust: string, installed: string): Promise<void> {
    this.#manager = new DistrictReleaseManager({
      instanceId: InstanceId.parse("ins_northfield"),
      policy: { channel: "stable", autoApply: false },
      store: this.#store,
      initial: { trust: ReleaseTrust.parse(JSON.parse(trust)), installed: InstalledRelease.parse(JSON.parse(installed)) },
      entitlement: entitlementIn("valid"),
    });
  }

  /** Receives a signed offer, returning the record's status. */
  async receiveOffer(offer: string): Promise<string> {
    return (await this.#required().receiveOffer(JSON.parse(offer))).status;
  }

  /** Declines an offer. */
  async decline(offerSequence: number, reason: string): Promise<void> {
    await this.#required().decline(offerSequence, reason);
  }

  /** The stored state, as JSON text. */
  async state(): Promise<string> {
    return JSON.stringify(await this.#required().state());
  }

  #required(): DistrictReleaseManager {
    if (this.#manager === undefined) throw new Error("pin the manager first");
    return this.#manager;
  }
}

/** The root's rollout store over Durable Object storage. */
export class TestRollout extends DurableObject {
  readonly #store: DurableObjectRolloutStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new DurableObjectRolloutStore(ctx.storage);
  }

  /** The next offer sequence for an instance. */
  async nextOfferSequence(instanceId: string): Promise<number> {
    return this.#store.nextOfferSequence(InstanceId.parse(instanceId));
  }

  /** A channel's state, as JSON text. */
  async channel(channel: string): Promise<string> {
    return JSON.stringify(await this.#store.channel(ReleaseChannel.parse(channel)));
  }

  /** Replaces a channel's state, given as JSON text. */
  async saveChannel(channel: string, state: string): Promise<void> {
    await this.#store.saveChannel(ReleaseChannel.parse(channel), JSON.parse(state));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
