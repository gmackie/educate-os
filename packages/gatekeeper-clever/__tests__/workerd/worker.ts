// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { CleverGatekeeperProps } from "../../src/clever-gatekeeper.js";

export { default } from "../../src/clever.js";
export * from "../../src/clever.js";
import { CleverVerifier, GatekeeperUserImpl } from "../../src/clever.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` in memory here, decorated `WorkerEntrypoint` exports are not registered in
 * `ctx.exports`; the production build registers them. An undecorated subclass registers, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests: entrypoints re-exported with `export *` are not registered. */
export class TestVerifier extends CleverVerifier {}

export type GatekeeperProps = CleverGatekeeperProps;

type UserProps = { userObjectId: string };

type TestExports = {
  CleverGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestVerifier(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
};

const completed = new Map<string, number>();

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  async credentialsExpired(): Promise<void> {}

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async complete(): Promise<ConnectHandoff> {
    const id = this.ctx.props.userObjectId;
    completed.set(id, (completed.get(id) ?? 0) + 1);
    return { targetOrigin: "http://localhost:8787", ticket: `first-${id}` };
  }
}

/** An approval queue that records what it is asked, and refuses observations it is told to. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: ObservationDescription[] = [];
  refuseObservations = false;

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    this.observations.push(description);
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One call in a scenario: a method and its arguments. */
export type Step = [method: string, ...args: unknown[]];

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = {
  describe(): Promise<unknown>;
  startSession(queue: RecordingQueue): Promise<Callable>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
  addObserver(id: string, verifier: unknown): Promise<void>;
  removeObserver(id: string): Promise<void>;
};

class NullGitCache extends RpcTarget {}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /** The gatekeeper facet named `facetName`, made with `props` on first use. */
  #gatekeeper(facetName: string, props: GatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get(facetName, () => ({
      class: this.#exports.CleverGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  #queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, queue = new RecordingQueue());
    return queue;
  }

  /**
   * Opens a session and makes each call in `steps` on what the call before returned, starting with
   * the session. The last call's result comes back.
   */
  async run(facetName: string, props: GatekeeperProps, steps: Step[]): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const session = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method]!(...args);
          if (index === steps.length - 1) return result;
          target = result as Callable;
        }
        return undefined;
      } finally {
        session[Symbol.dispose]?.();
      }
    });
  }

  /** What the facet's approval queue has recorded. */
  queueLog(facetName: string): { submitted: RecordingQueue["submitted"]; observations: RecordingQueue["observations"] } {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations };
  }

  refuseObservations(facetName: string, refuse: boolean): void {
    this.#queue(facetName).refuseObservations = refuse;
  }

  async describe(facetName: string, props: GatekeeperProps): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).describe());
  }

  async applyAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, new NullGitCache()));
  }

  async rejectAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  /** `addObserver` with a verifier minted for `observerUserObjectId`'s account. */
  async addObserver(facetName: string, props: GatekeeperProps, observerId: string, observerUserObjectId: string):
      Promise<Outcome<void>> {
    const verifier = this.#exports.TestVerifier({ props: { userObjectId: observerUserObjectId } });
    return await outcome(() => this.#gatekeeper(facetName, props).addObserver(observerId, verifier));
  }

  // -- account ----------------------------------------------------------------------------

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string): Promise<void> {
    const callback = this.#exports.TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    await account.setCallback(callback, initiationNonce);
  }

  completions(userObjectId: string): number {
    return completed.get(userObjectId) ?? 0;
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestUser({ props: { userObjectId } })[method]!(...args));
  }

  /** Calls `method` on the account Durable Object, failures carried back as data. */
  async account(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await outcome(() => (account as unknown as Callable)[method]!(...args));
  }

  /** Calls `method` on the verifier for `userObjectId`. */
  async verifier(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestVerifier({ props: { userObjectId } })[method]!(...args));
  }
}
