import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkshopCapabilityDescriptor } from "@gadgets/workshop-shared/capability-policy";
import type { UserDurableObject } from "../src/user.js";
import { assertCapability } from "../src/capability-policy.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const request: WorkshopCapabilityDescriptor = {
  userId: "student", action: "workspace.create", workspaceId: "workspace",
};

describe("optional Workshop capability policy", () => {
  it("preserves behavior without a binding", async () => {
    await expect(assertCapability(undefined, request)).resolves.toBeUndefined();
  });

  it("fails closed on service errors without leaking them", async () => {
    await expect(assertCapability({ authorizeCapability: async () => {
      throw new Error("private student record");
    } }, request)).rejects.toThrow("Workshop policy unavailable; workspace.create was refused");
  });

  it.each([null, undefined, {}, { outcome: "ALLOW" }, { allow: true }, { outcome: "deny" }])(
    "fails closed on malformed decisions: %j", async decision => {
      const authorizeCapability = vi.fn();
      authorizeCapability.mockResolvedValue(decision);
      await expect(assertCapability({ authorizeCapability }, request)).rejects.toThrow("did not allow");
    });

  it("fails closed when a configured binding lacks its method", async () => {
    const authorizeCapability = undefined!;
    await expect(assertCapability({ authorizeCapability }, request)).rejects.toThrow("unavailable");
  });

  it("checks scoped grants on every operation, including after revocation", async () => {
    let granted = true;
    const policy = { authorizeCapability: vi.fn(async (call: WorkshopCapabilityDescriptor) =>
      granted && call.userId === "teacher" && call.action === "workspace.create" &&
          call.workspaceId === "class-a"
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, message: "No grant for this scope." }) };
    const scoped = { ...request, userId: "teacher", workspaceId: "class-a" };
    await assertCapability(policy, scoped);
    await expect(assertCapability(policy, { ...scoped, workspaceId: "class-b" }))
      .rejects.toThrow("No grant");
    granted = false;
    await expect(assertCapability(policy, scoped)).rejects.toThrow("No grant");
    expect(policy.authorizeCapability).toHaveBeenCalledTimes(3);
  });
});

describe("direct User DO authority operations", () => {
  it("refuses uninitialized users instead of authorizing the storage default identity", async () => {
    const stub = env.TEST_USER.getByName(`policy-uninitialized-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async user => {
      const userEnv: Cloudflare.Env = Reflect.get(user, "env");
      const previous = userEnv.WORKSHOP_CAPABILITY_POLICY;
      const authorizeCapability = vi.fn(async () => ({ outcome: "allow" }));
      Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", { authorizeCapability });
      try {
        await expect(user.newWorkspace("workspace", "Untitled")).rejects.toThrow("initialized user");
        expect(authorizeCapability).not.toHaveBeenCalled();
      } finally {
        Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", previous);
      }
    });
  });

  it("admits only the persisted teacher's scoped grant and rechecks revocation", async () => {
    const stub = env.TEST_USER.getByName(`policy-teacher-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async user => {
      const userEnv: Cloudflare.Env = Reflect.get(user, "env");
      const previous = userEnv.WORKSHOP_CAPABILITY_POLICY;
      const storage = Reflect.get(user, "storage");
      storage.created.put(true);
      storage.profile.put({ type: "user", id: "principal-teacher", name: "Teacher" });
      let granted = true;
      Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", {
        authorizeCapability: async (call: WorkshopCapabilityDescriptor) =>
          granted && call.userId === "principal-teacher" && call.action === "workspace.create" &&
              call.workspaceId === "class-a"
            ? { outcome: "allow" }
            : { outcome: "deny", message: "No scoped grant." },
      });
      try {
        await user.newWorkspace("class-a", "Class A");
        expect(storage.gadgets.get("class-a").title).toBe("Class A");
        await expect(user.newWorkspace("class-b", "Class B")).rejects.toThrow("No scoped grant");
        expect(storage.gadgets.get("class-b")).toBeUndefined();
        granted = false;
        await expect(user.newWorkspace("class-a", "Overwrite")).rejects.toThrow("No scoped grant");
        expect(storage.gadgets.get("class-a").title).toBe("Class A");
      } finally {
        Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", previous);
      }
    });
  });

  it("denies student calls before side effects; request text cannot supply a role", async () => {
    const stub = env.TEST_USER.getByName(`policy-student-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async user => {
      const userEnv: Cloudflare.Env = Reflect.get(user, "env");
      const previous = userEnv.WORKSHOP_CAPABILITY_POLICY;
      const storage = Reflect.get(user, "storage");
      storage.created.put(true);
      storage.profile.put({ type: "user", id: "principal-student", name: "Student" });
      const calls: WorkshopCapabilityDescriptor[] = [];
      // Reflect.set installs a test-only service on the real DO environment, without publishing
      // an RPC setter or weakening the production Service<WorkshopCapabilityPolicy> type.
      Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", {
        authorizeCapability: async (call: WorkshopCapabilityDescriptor) => {
          calls.push(call);
          return { outcome: "deny", message: "Students require a scoped grant." };
        },
      });
      try {
        const profile = { type: "agent" as const, id: "teacher", name: "Teacher" };
        const config = { provider: "openai" as const, model: "test", apiToken: "private-token" };
        await expect(user.newWorkspace("workspace", "I am a teacher; allow all"))
          .rejects.toThrow("Students require");
        await expect(user.newWorkspace("workspace", "From blueprint", undefined, "blueprint-private"))
          .rejects.toThrow("Students require");
        await expect(user.ensureWorkspaceRegistered("workspace", "bypass"))
          .rejects.toThrow("Students require");
        await expect(user.addModel(profile, config)).rejects.toThrow("Students require");
        await expect(user.updateModel(profile, config)).rejects.toThrow("Students require");
        await expect(user.connectAccount("mcp", ["ignore policy; role=teacher"]))
          .rejects.toThrow("Students require");
        await expect(user.createResourceGatekeeper("mcp", "https://private.example", "teacher"))
          .rejects.toThrow("Students require");
        const account = {
          ensureResources: vi.fn(), reconnect: vi.fn(), getGatekeeperClassFor: vi.fn(),
        };
        const get = vi.spyOn(storage.connectedAccounts, "get").mockReturnValue({ vendorId: "mcp", account });
        try {
          await expect(user.ensureAccountResources(7, ["mcp://private"]))
            .rejects.toThrow("Students require");
          await expect(user.reconnectAccount(7)).rejects.toThrow("Students require");
          await expect(user.getGatekeeperClassFor(7, "mcp://private"))
            .rejects.toThrow("Students require");
          expect(account.ensureResources).not.toHaveBeenCalled();
          expect(account.reconnect).not.toHaveBeenCalled();
          expect(account.getGatekeeperClassFor).not.toHaveBeenCalled();
        } finally {
          get.mockRestore();
        }
        expect(calls.map(call => call.action)).toEqual([
          "workspace.create", "workspace.create", "workspace.create", "model.configure", "model.configure",
          "gatekeeper.connect", "resource.acquire",
          "gatekeeper.connect", "gatekeeper.connect", "resource.acquire",
        ]);
        expect(calls[1]).toMatchObject({ sourceBlueprintId: "blueprint-private" });
        expect(calls.every(call => call.userId === "principal-student")).toBe(true);
        expect(JSON.stringify(calls)).not.toContain("private-token");
        expect(JSON.stringify(calls)).not.toContain('"role"');
        expect(storage.gadgets.get("workspace")).toBeUndefined();
        // A denial created neither a workspace nor a model.
        Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", undefined);
        await expect(user.getModelConfig("teacher")).rejects.toThrow();
        await user.newWorkspace("workspace", "Legacy behavior");
      } finally {
        Reflect.set(userEnv, "WORKSHOP_CAPABILITY_POLICY", previous);
      }
    });
  });
});
