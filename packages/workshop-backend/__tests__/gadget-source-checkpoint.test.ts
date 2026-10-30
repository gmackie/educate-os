import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { createGadgetSourceCheckpoint } from "../src/gadget-source-checkpoint.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const source = new Map([["server.js", "export default { fetch() { return new Response('hello'); } }"]]);
const identity = {workspaceId: "workspace", gadgetId: 1, commitId: "a".repeat(40),
  blueprint: {id: "blueprint", commitId: "b".repeat(40)}};

describe("source-only checkpoint policy", () => {
  it("hashes canonical complete source, without retaining mutable inputs", async () => {
    const files = new Map([...source, ["client.js", "export const answer = 42;"]]);
    const checkpoint = await createGadgetSourceCheckpoint(identity, files);
    expect(checkpoint).toEqual(await createGadgetSourceCheckpoint(identity, new Map([...files].toReversed())));
    files.set("server.js", "changed");
    expect(checkpoint.files.find(([path]) => path === "server.js")?.[1]).toBe(source.get("server.js"));
    expect(checkpoint.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(checkpoint).toSorted()).toEqual([
      "blueprint", "commitId", "files", "format", "gadgetId", "policy", "sourceDigest", "workspaceId",
    ]);
  });

  it.each([".env", "chat.json", "bindings.js", "hidden-tests.js", "teacher/rubric.ts", "fixtures/data.ts",
    "../private.js", "credentials.js", "other.json", "data.bin", "node_modules/a.js"])(
    "refuses the entire snapshot for %s", async path => {
      await expect(createGadgetSourceCheckpoint(identity, new Map([...source, [path, "private value"]])))
        .rejects.toThrow("unsupported or sensitive");
    });

  it.each(["const apiKey = 'secret-example-value';", "const token = 'ghp_abcdefghijklmnopqrstuvwxyz';",
    "const key = '-----BEGIN RSA PRIVATE KEY-----';", "const password = 'secret-example-value';"])(
    "refuses suspicious source without disclosing it in the error", async content => {
      await expect(createGadgetSourceCheckpoint(identity, new Map([["server.js", content]])))
        .rejects.toThrow(/^Checkpoint export refused: source contains an unsupported or sensitive file\.$/);
    });

  it("refuses oversized and incomplete executable trees", async () => {
    await expect(createGadgetSourceCheckpoint(identity, new Map([["server.js", "x".repeat(128 * 1024)]])))
      .rejects.toThrow("128 KiB");
    await expect(createGadgetSourceCheckpoint(identity, new Map([["client.js", "hello"]])))
      .rejects.toThrow("server.js");
  });
});

let nextId = 0;
async function withCheckpoint(fn: (impl: any, caller: any) => Promise<void>) {
  const stub = env.TEST_OVERSEER.getByName(`source-checkpoint-${++nextId}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    impl.ownerId = "owner-id";
    const commitId = await impl.gitStore.writeFilesAsCommit(source, {
      parents: [], author: {name: "Student", email: "student@example.com"},
      message: "checkpoint", timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({type: "gadget", id: 1, title: "Assessment", bindingName: "APP",
      created: new Date(0), commitId, upstream: {blueprintId: "blueprint", commitId: "b".repeat(40)},
      bindings: {SCHOOL: {target: 2}}});
    impl.storage.gatekeepers.put({id: 2,
      creationSpec: {type: "ambient", vendorId: "educateos", accountId: 1}});
    const caller = {from: "gadget", gadgetId: 1, sourceCommitId: commitId};
    await fn(impl, caller);
  });
}

describe("owner-scoped checkpoint capability in workerd", () => {
  it("stamps the exact committed executable into runtime bindings", () => withCheckpoint(async (impl, caller) => {
    let loadedCaller: unknown;
    const bindings = impl.getEnvForLoader.bind(impl);
    impl.getEnvForLoader = (gadgetId: number, runtimeCaller: unknown) => {
      loadedCaller = runtimeCaller;
      // No gatekeeper RPC is made by this simple source tree; the real loader still executes it.
      return bindings(gadgetId, runtimeCaller);
    };
    const response = await impl.loadGadgetWorker(1).getEntrypoint().fetch(new Request("https://gadget/"));
    expect(await response.text()).toBe("hello");
    expect(loadedCaller).toEqual({...caller, chatId: undefined});
  }));

  it("reads actual Git source through the trusted approval queue", () => withCheckpoint(async (impl, caller) => {
    const checkpoint = await impl.openGatekeeperSession(2, {
      startSession: (queue: any) => queue.getCurrentGadgetCheckpoint(),
    }, caller);
    expect(checkpoint.commitId).toBe(caller.sourceCommitId);
    expect(checkpoint.files).toEqual([...source]);
    expect(checkpoint.blueprint).toEqual(identity.blueprint);
  }));

  it.each([{from: "agent", chatId: 1}, {from: "hook"}, {from: "user"},
    {from: "gadget", gadgetId: 99}, {from: "gadget", gadgetId: 1}])(
    "refuses unscoped/foreign callers %j", caller => withCheckpoint(async impl => {
      await expect(impl.getCurrentGadgetCheckpoint(2, caller)).rejects.toThrow();
    }));

  it("refuses previews, stale revisions, foreign gatekeepers and unknown origins", () => withCheckpoint(async (impl, caller) => {
    await expect(impl.getCurrentGadgetCheckpoint(2, {...caller, chatId: 1})).rejects.toThrow();
    await expect(impl.getCurrentGadgetCheckpoint(2, {...caller, sourceCommitId: "c".repeat(40)})).rejects.toThrow();
    await expect(impl.getCurrentGadgetCheckpoint(3, caller)).rejects.toThrow();
    const gadget = impl.storage.gadgets.get(1);
    impl.storage.gadgets.put({...gadget, upstream: undefined});
    await expect(impl.getCurrentGadgetCheckpoint(2, caller)).rejects.toThrow();
  }));

  it("refuses a bound non-owner account and sharing", () => withCheckpoint(async (impl, caller) => {
    impl.storage.gatekeepers.put({id: 2,
      creationSpec: {type: "gatekeeper", vendorId: "educateos", typeUrlPattern: "https://school/*"}});
    await expect(impl.getCurrentGadgetCheckpoint(2, caller)).rejects.toThrow();
    impl.storage.gatekeepers.put({id: 2, creationSpec: {type: "ambient", vendorId: "educateos", accountId: 1}});
    impl.storage.shareKeys.put({id: "link", role: "use"});
    await expect(impl.getCurrentGadgetCheckpoint(2, caller)).rejects.toThrow();
  }));

  it("rechecks access after asynchronous source reads", () => withCheckpoint(async (impl, caller) => {
    const read = impl.gitStore.readCommitFiles.bind(impl.gitStore);
    impl.gitStore.readCommitFiles = async (commit: string) => {
      const files = await read(commit);
      impl.storage.gadgets.put({...impl.storage.gadgets.get(1), commitId: "c".repeat(40)});
      return files;
    };
    await expect(impl.getCurrentGadgetCheckpoint(2, caller)).rejects.toThrow("changed");
  }));
});
