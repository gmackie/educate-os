// The workerd suite's main module: the gatekeeper's own exports, Northfield's district service as
// the injected `EDUCATEOS_DISTRICT` binding, a stand-in for the Workshop's connect callback, and a
// hook Durable Object that runs the gatekeeper facet the way the overseer does, through ctx.facets.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  GatekeeperConnectCallback,
  ConnectHandoff,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GitCache,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { VerifiedPrincipal } from "@educateos/contracts";
import type { SchoolToolService } from "../../src/district.ts";
import type { SchoolAppApi } from "../../src/school-app-api.ts";
import type { SchoolToolCallResult } from "../../src/session.ts";
import type { EducateOsGatekeeper } from "../../src/worker.ts";
import { northfieldDistrict } from "../district.ts";

export { default } from "../../src/worker.ts";
// Named one by one: Vitest's ctx.exports analyzer does not follow `export *`.
export { GatekeeperVendor, EducateOsAccount, EducateOsAccountObject, EducateOsGatekeeper, EducateOsVerifier } from "../../src/worker.ts";

/** Northfield, shared by every test in this isolate. */
export const district = northfieldDistrict();

/** Northfield's district service, as the district deployment would expose it. */
export class FakeDistrict extends WorkerEntrypoint implements SchoolToolService {
  authenticate(request: Request) {
    return district.service.authenticate(request);
  }
  listTools() {
    return district.service.listTools();
  }
  callTool(subject: VerifiedPrincipal, name: string, args: unknown) {
    return district.service.callTool(subject, name, args);
  }
  approveChange(approver: VerifiedPrincipal, approvalId: string) {
    return district.service.approveChange(approver, approvalId);
  }
  declineChange(decider: VerifiedPrincipal, approvalId: string, reason: string) {
    return district.service.declineChange(decider, approvalId, reason);
  }
  serveAs(principal: VerifiedPrincipal, request: Request) {
    return district.service.serveAs(principal, request);
  }
}

/** How many accounts the Workshop's connect callback was handed. */
export const completions = { count: 0 };

/** Stands in for the Workshop's connect callback. */
export class TestConnectCallback extends WorkerEntrypoint {
  async complete(_user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    completions.count += 1;
    return { targetOrigin: "https://district.example", ticket: `ticket-${completions.count}` };
  }
}

// The test-only entrypoint, which the generated exports type (from src/worker.ts) does not know.
type TestExports = { TestConnectCallback(options: object): Fetcher<GatekeeperConnectCallback> };

/** Stands in for collaborators' verifiers and the overseer's git cache, neither of which is called. */
class Unused extends RpcTarget {}

/** Records what a session sends the Workshop's approval queue. */
class TestApprovalQueue extends RpcTarget {
  readonly observations: ObservationDescription[] = [];
  readonly actions: { id: number; description: ActionDescription }[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.actions.push({ id, description });
  }
}

/** What one tool call through the facet did. */
export interface FacetCall {
  result: SchoolToolCallResult;
  observations: string[];
  actions: { id: number; title: string; autoApprovable: boolean }[];
}

/** What following a connect link answered. */
export interface LinkResponse {
  status: number;
  body: string;
}

/**
 * Runs the Worker as the Workshop and the overseer do: starting connect flows and following their
 * links, and installing an account's gatekeeper facet through ctx.facets.
 */
export class TestHooks extends DurableObject<Cloudflare.Env> {
  /** Starts a connect flow, as the Workshop does, and returns the link. */
  async startConnect(): Promise<string> {
    const callback = (this.ctx.exports as unknown as TestExports).TestConnectCallback({});
    const { url } = await this.ctx.exports.GatekeeperVendor({}).connectAccount(callback);
    return url;
  }

  /** Follows a connect link in a browser signed in to the district as `who`, if anyone. */
  async follow(url: string, method: "GET" | "POST", who?: string): Promise<LinkResponse> {
    const headers: Record<string, string> = who === undefined ? {} : { "x-test-principal": who };
    const response = await this.ctx.exports.default.fetch(new Request(url, { method, headers }));
    return { status: response.status, body: await response.text() };
  }

  /** Revokes an account, as the Workshop does when the person disconnects it. */
  /** Opens the account's School app and sends one request through it, or returns why it was refused. */
  async schoolAppRequest(accountObjectId: string, method: "GET" | "POST", path: string, body: string | null):
      Promise<{ html: string; title: string | undefined; reply?: { status: number; body: string }; refused?: string }> {
    const account = this.ctx.exports.EducateOsAccount({ props: { accountObjectId } });
    const description = await account.describe();
    // The School app redeems no picker tickets, so any service stands in for the exchange.
    const exchange = (this.ctx.exports as unknown as TestExports).TestConnectCallback({}) as never;
    const frame = await account.startAppUi({ isAdmin: false, userSelectionExchange: exchange });
    // The frame's capability, as the School app calls it.
    const ui = frame.ui as unknown as SchoolAppApi & Disposable;
    const result = { html: frame.iframeHtml, title: description.providesUi?.title };
    try {
      const reply = await ui.request(method, path, body);
      return { ...result, reply: { status: reply.status, body: reply.body } };
    } catch (error) {
      return { ...result, refused: String(error) };
    } finally {
      ui[Symbol.dispose]();
    }
  }

  async revoke(accountObjectId: string): Promise<void> {
    await this.ctx.exports.EducateOsAccount({ props: { accountObjectId } }).revoke();
  }

  async #facet(accountObjectId: string) {
    const account = this.ctx.exports.EducateOsAccount({ props: { accountObjectId } });
    const facetClass = await account.getSingletonGatekeeperClass();
    return this.ctx.facets.get<EducateOsGatekeeper>(`school-${accountObjectId}`, () => ({ class: facetClass }));
  }

  /** Calls one tool through a fresh session, with the agent's name and arguments. */
  async callTool(accountObjectId: string, name: string, args: Record<string, unknown>): Promise<FacetCall> {
    const queue = new TestApprovalQueue();
    // Only the two methods a session calls are implemented.
    using session = await (await this.#facet(accountObjectId)).startSession(new RpcStub(queue) as unknown as ApprovalQueue);
    const result = await session.callTool(name, args);
    return {
      result,
      observations: queue.observations.map((o) => o.title),
      actions: queue.actions.map(({ id, description }) => ({ id, title: description.title, autoApprovable: description.autoApprovable === true })),
    };
  }

  /** Calls one tool, expecting the session to throw. Returns the message. */
  async callToolFailure(accountObjectId: string, name: string, args: Record<string, unknown>): Promise<string> {
    try {
      await this.callTool(accountObjectId, name, args);
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The action kinds the facet would let the Workshop approve without a person. */
  async autoApprovableKinds(accountObjectId: string): Promise<string[]> {
    return (await (await this.#facet(accountObjectId)).getAutoApprovableActions()).map((kind) => kind.tag);
  }

  /** A person's approval in the Workshop. Returns the error message, or null. */
  async apply(accountObjectId: string, actionId: number): Promise<string | null> {
    try {
      // The overseer always passes a git cache; school changes never touch it.
      const cache = new RpcStub(new Unused()) as unknown as RpcStub<GitCache>;
      await (await this.#facet(accountObjectId)).applyAction(actionId, cache);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** A collaborator opening the workspace. Returns the refusal, or null. */
  async addObserver(accountObjectId: string): Promise<string | null> {
    try {
      const verifier = new RpcStub(new Unused()) as unknown as Fetcher<GatekeeperUserVerifier>;
      await (await this.#facet(accountObjectId)).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
