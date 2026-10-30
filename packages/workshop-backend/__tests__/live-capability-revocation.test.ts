// Live-capability revocation under a capability policy (SCHO-309). A principal who loses standing
// -- deactivated in the district, or no longer allowed by policy -- loses everything they hold,
// within the recheck bound, because the objects hosting it restart: the workspace's gadget stubs,
// facets, callbacks, gatekeeper sessions and turns, and the user's own sessions. A reconnect is
// admitted afresh, and refused. A check that fails restarts rather than allows.
//
// Runs real gadget facets and real user and workspace Durable Objects in workerd, and lets the
// real scheduleAccessRestart() abort them. Capabilities are minted over real RPC (test-worker.ts),
// so the test holds them from outside the workspace, as a client would. The district is a synthetic
// policy and principal resolver installed on the objects' shared env. Synthetic data only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { WorkshopCapabilityDescriptor } from "@gadgets/workshop-shared/capability-policy";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { STANDING_RECHECK_MS } from "../src/capability-policy.js";
import { PRINCIPAL_STANDING_LOST_MESSAGE } from "../src/auth/principal-sign-in.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const GADGET_ID = 1;

const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  hello() {
    return "hi";
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

// The synthetic district: who is inactive, what the policy refuses, and whether it can answer.
const district = {
  inactive: new Set<string>(),
  denied: new Set<string>(),
  failing: false,
};

const resolver = {
  async resolveAccessSignIn() {
    return { outcome: "unauthenticated" };
  },
  async principalStanding(principalId: string) {
    if (district.failing) throw new Error("synthetic district outage");
    return { outcome: district.inactive.has(principalId) ? "inactive" : "active" };
  },
};

const policy = {
  async authorizeCapability(request: WorkshopCapabilityDescriptor) {
    if (district.failing) throw new Error("synthetic district outage");
    return district.denied.has(`${request.userId} ${request.action}`)
      ? { outcome: "deny", message: "Synthetic revocation." }
      : { outcome: "allow" };
  },
};

// Every Durable Object in this isolate shares one env object.
async function setDistrict(bound: boolean): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName("district-installer"), instance => {
    let shared = Reflect.get(instance, "env");
    Reflect.set(shared, "WORKSHOP_CAPABILITY_POLICY", bound ? policy : undefined);
    Reflect.set(shared, "PRINCIPAL_RESOLVER", bound ? resolver : undefined);
  });
}

let counter = 0;

type Principal = { id: string; name: string; userId: string; user: DurableObjectStub<UserDurableObject> };

// A principal-keyed user, signed in as a principal resolver's sign-in records it.
async function principal(label: string): Promise<Principal> {
  let id = `prn_${label}-${++counter}`;
  let name = `principal:${id}`;
  let user = env.TEST_USER.getByName(name);
  await user.authenticateFromCfAccess(name, true, label, name);
  return { id, name, userId: env.TEST_USER.idFromName(name).toString(), user };
}

// A workspace owned by `owner`, with one committed gadget.
async function workspace(owner: Principal): Promise<DurableObjectStub<OverseerDurableObject>> {
  let stub = env.TEST_OVERSEER.getByName(`revocation-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Owner", email: "owner@example.com" },
      message: "synthetic gadget",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });
    impl.ownerId = owner.userId;
    impl.storage.ownerId.put(owner.userId);
  });
  await owner.user.newWorkspace(stub.id.toString(), "Synthetic workspace");
  return stub;
}

// What a client call admits first (OverseerImpl.admitPrincipal), run in the workspace.
async function admit(stub: DurableObjectStub<OverseerDurableObject>, who: Principal,
                     action?: "gadget.execute" | "agent.execute"): Promise<void> {
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await (instance as unknown as { impl: any }).impl.admitPrincipal(who.userId, action);
  });
}

// A stub that saw its object restart stays broken; reconnecting takes a new one.
function reconnect(stub: DurableObjectStub<OverseerDurableObject>): DurableObjectStub<OverseerDurableObject> {
  return env.TEST_OVERSEER.get(stub.id);
}

async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    return `ok:${String(await call)}`;
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

// Waits for a capability to stop working, as the restart's abort lands.
async function expectRevoked(call: () => Promise<unknown>): Promise<void> {
  await vi.waitFor(async () => {
    expect(await outcome(call())).toMatch(/^error:/);
  }, { timeout: 5_000, interval: 50 });
}

beforeEach(async () => {
  district.inactive.clear();
  district.denied.clear();
  district.failing = false;
  await setDistrict(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setDistrict(false);
});

describe("revoking what an owner minted while allowed", () => {
  it("restarts within the recheck bound, ending the root stub, its callback and a gatekeeper session",
      async () => {
    let owner = await principal("owner");
    let ws = await workspace(owner);
    let admittedAt = Date.now();
    await admit(ws, owner, "gadget.execute");

    // The next recheck is scheduled within the bound.
    let alarm = await runInDurableObject(ws, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + STANDING_RECHECK_MS);
    expect(alarm!).toBeGreaterThanOrEqual(admittedAt);

    using gadget = await ws.testGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("allowed");
    expect(await callback.ping()).toBe("pong:allowed");
    using session = await ws.testSpawnerSession(owner.userId);
    using agent = await session.spawnCallable("Helper", {
      types: "interface Helper { help(): void; }", mainType: "Helper",
    });
    expect(agent).toBeDefined();

    district.inactive.add(owner.id);
    // The recheck alarm, run once its time has come.
    vi.spyOn(Date, "now").mockReturnValue(alarm! + 1);
    expect(await runDurableObjectAlarm(ws)).toBe(true);
    vi.restoreAllMocks();

    await expectRevoked(() => callback.ping());
    expect(await outcome(gadget.hello())).toMatch(/^error:/);
    expect(await outcome(session.spawnCallable("Again", {
      types: "interface Helper { help(): void; }", mainType: "Helper",
    }))).toMatch(/^error:/);

    // The restarted workspace holds nothing for anyone until it admits them again.
    ws = reconnect(ws);
    expect(await outcome(ws.testGadgetFacet(GADGET_ID))).toMatch(/needs an admitted principal/);
    // A reconnect is admitted afresh, and refused.
    expect(await outcome(ws.open(owner.userId, owner.name, () => {}))).toBe(
        `error:${PRINCIPAL_STANDING_LOST_MESSAGE}`);
    // The persistent callable stub's entry point readmits its initiator, and refuses them.
    let [chat] = await runInDurableObject(ws, (instance: OverseerDurableObject) =>
        [...(instance as unknown as { impl: any }).impl.storage.chatMeta.list()]);
    expect(await outcome(runInDurableObject(ws, (instance: OverseerDurableObject) =>
        (instance as unknown as { impl: any }).impl.deliverAgentCallback(
            chat.id, "help", [], owner.userId, null)))).toBe(`error:${PRINCIPAL_STANDING_LOST_MESSAGE}`);
  });

  it("restarts when a policy check errors, rather than allowing", async () => {
    let owner = await principal("owner");
    let ws = await workspace(owner);
    await admit(ws, owner, "gadget.execute");
    using gadget = await ws.testGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("allowed");
    expect(await callback.ping()).toBe("pong:allowed");

    district.failing = true;
    await runInDurableObject(ws, (instance: OverseerDurableObject) =>
        (instance as unknown as { impl: any }).impl.recheckStanding());

    await expectRevoked(() => callback.ping());
    expect(await outcome(admit(reconnect(ws), owner, "gadget.execute"))).toMatch(/can't be reached/);
  });

  it("refuses execution on a fresh check once the policy no longer allows it", async () => {
    let owner = await principal("owner");
    let ws = await workspace(owner);
    await admit(ws, owner, "gadget.execute");
    using gadget = await ws.testGadgetFacet(GADGET_ID);
    expect(await gadget.hello()).toBe("hi");

    // Regraded rather than deactivated: the next client call's fresh admission is refused, and,
    // since it refuses something already held here, restarts the workspace.
    district.denied.add(`${owner.name} gadget.execute`);
    expect(await outcome(admit(ws, owner, "gadget.execute"))).toMatch(/Synthetic revocation/);
    await expectRevoked(() => gadget.hello());
  });
});

describe("revoking a collaborator", () => {
  it("restarts every workspace they hold capabilities in when their user object learns they left",
      async () => {
    let owner = await principal("owner");
    let student = await principal("collaborator");
    let ws = await workspace(owner);
    await student.user.recordSharedWorkspaceOpen(
        ws.id.toString(), "Synthetic workspace", { type: "user", id: owner.name, name: "owner" }, "build");
    await admit(ws, owner, "gadget.execute");
    await admit(ws, student, "gadget.execute");
    using gadget = await ws.testGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("collaborator");
    expect(await callback.ping()).toBe("pong:collaborator");

    // Any standing check that finds the collaborator gone revokes everything they hold, at once:
    // their user object restarts each workspace it lists, and then itself.
    district.inactive.add(student.id);
    expect(await outcome(student.user.assertWorkshopStanding(ws.id.toString(), [])))
        .toBe(`error:${PRINCIPAL_STANDING_LOST_MESSAGE}`);

    await expectRevoked(() => callback.ping());
    ws = reconnect(ws);
    // Their reconnect's admission (open() admits after its sharing checks) is refused.
    expect(await outcome(admit(ws, student))).toBe(`error:${PRINCIPAL_STANDING_LOST_MESSAGE}`);
    // The owner, still in standing, is admitted again after the restart.
    await admit(ws, owner, "gadget.execute");
    using fresh = await ws.testGadgetFacet(GADGET_ID);
    expect(await fresh.hello()).toBe("hi");
  });

  it("restarts on the workspace's own recheck when the collaborator is regraded", async () => {
    let owner = await principal("owner");
    let student = await principal("collaborator");
    let ws = await workspace(owner);
    await admit(ws, student, "gadget.execute");
    using gadget = await ws.testGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("collaborator");
    expect(await callback.ping()).toBe("pong:collaborator");

    district.denied.add(`${student.name} gadget.execute`);
    await runInDurableObject(ws, (instance: OverseerDurableObject) =>
        (instance as unknown as { impl: any }).impl.recheckStanding());
    await expectRevoked(() => callback.ping());
  });
});

describe("watched API sessions", () => {
  it("drops a principal's session within the recheck bound once they lose standing", async () => {
    let student = await principal("student");
    let dropped = false;
    let notifyClosed = () => {};
    (notifyClosed as any)[Symbol.dispose] = () => { dropped = true; };
    using _lease = await student.user.watchSessionStanding(notifyClosed);
    let alarm = await runInDurableObject(student.user, (_instance, state) => state.storage.getAlarm());
    expect(alarm!).toBeLessThanOrEqual(Date.now() + STANDING_RECHECK_MS);

    // Still in standing: the recheck keeps the session.
    vi.spyOn(Date, "now").mockReturnValue(alarm! + 1);
    await runDurableObjectAlarm(student.user);
    vi.restoreAllMocks();
    expect(dropped).toBe(false);

    district.inactive.add(student.id);
    alarm = await runInDurableObject(student.user, (_instance, state) => state.storage.getAlarm());
    vi.spyOn(Date, "now").mockReturnValue(alarm! + 1);
    await outcome(runDurableObjectAlarm(student.user));
    vi.restoreAllMocks();
    await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 5_000, interval: 50 });
  });

  it("drops the session when the district cannot answer", async () => {
    let student = await principal("student");
    let dropped = false;
    let notifyClosed = () => {};
    (notifyClosed as any)[Symbol.dispose] = () => { dropped = true; };
    using _lease = await student.user.watchSessionStanding(notifyClosed);
    district.failing = true;
    let alarm = await runInDurableObject(student.user, (_instance, state) => state.storage.getAlarm());
    vi.spyOn(Date, "now").mockReturnValue(alarm! + 1);
    await runDurableObjectAlarm(student.user);
    vi.restoreAllMocks();
    await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 5_000, interval: 50 });
  });
});

describe("without a capability policy", () => {
  it("admits, executes and schedules nothing new, as before", async () => {
    await setDistrict(false);
    let owner = await principal("generic");
    let ws = await workspace(owner);
    await admit(ws, owner, "gadget.execute");
    expect(await runInDurableObject(ws, (_instance, state) => state.storage.getAlarm())).toBeNull();
    using gadget = await ws.testGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("generic");
    district.inactive.add(owner.id);
    await runInDurableObject(ws, (instance: OverseerDurableObject) =>
        (instance as unknown as { impl: any }).impl.recheckStanding());
    expect(await callback.ping()).toBe("pong:generic");
    expect(await outcome(owner.user.watchSessionStanding(() => {}))).toMatch(/needs a capability policy/);
  });
});
