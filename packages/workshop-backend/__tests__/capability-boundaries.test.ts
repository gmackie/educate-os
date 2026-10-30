import { describe, expect, it, vi } from "vitest";
import type { WorkshopCapabilityDescriptor, WorkshopCapabilityScope } from "@gadgets/workshop-shared/capability-policy";
import { assertCapability } from "../src/capability-policy.js";
import { openFakeOverseer } from "./fixtures.js";

// Exercise the real RPC interface methods, with no frontend visibility checks involved.
async function client(principal: string, role: "build" | "use" = "build") {
  let granted = principal === "teacher";
  const requests: WorkshopCapabilityDescriptor[] = [];
  const sideEffect = vi.fn(async () => ({ key: "key", linkId: "link" }));
  const policy = { authorizeCapability: async (request: WorkshopCapabilityDescriptor) => {
    requests.push(request);
    return granted ? { outcome: "allow" as const }
      : { outcome: "deny" as const, message: "No grant." };
  } };
  const user = {
    whoami: async () => ({ id: principal, name: principal }),
    recordSharedWorkspaceOpen: async () => {},
    assertWorkshopCapability: async (scope: WorkshopCapabilityScope) =>
      assertCapability(policy, { ...scope, userId: principal }),
  };
  const api = await openFakeOverseer({}, { role, impl: {
    env: { WORKSHOP_CAPABILITY_POLICY: policy },
    users: { idFromString: (id: string) => id, get: () => user },
    // What the real OverseerImpl.admitPrincipal asks the user object for (SCHO-309); its standing
    // rechecks and restarts are covered by live-capability-revocation.test.ts.
    admitPrincipal: async (_userId: string, action?: "gadget.execute" | "agent.execute") => {
      if (action) await user.assertWorkshopCapability({ action, workspaceId: "workspace-id" });
    },
    getGadgetRecord: () => ({ type: "gadget", id: 1 }),
    getSharingManager: async () => ({ createShareLink: sideEffect }),
    getGadgetUiBundle: sideEffect,
    getGadgetFacet: sideEffect,
    getGadgetExportFormats: sideEffect,
    exportGadget: sideEffect,
  } });
  return { api, requests, sideEffect, revoke: () => { granted = false; } };
}

describe("policy checks at retained Workshop RPC boundaries", () => {
  it("denies direct student publication, invitations and agent execution before side effects", async () => {
    const { api, requests, sideEffect } = await client("student");
    await expect(api.createGadget("student gadget")).rejects.toThrow("No grant");
    await expect(api.addCollaborator("teacher", "build", "role=teacher")).rejects.toThrow("No grant");
    await expect(api.createShareLink("build")).rejects.toThrow("No grant");
    await expect(api.newShareLinkKey("link")).rejects.toThrow("No grant");
    await expect(api.updateBlueprint("blueprint", { title: "private" })).rejects.toThrow("No grant");
    await expect(api.retryBlueprintPublish("blueprint")).rejects.toThrow("No grant");
    await expect(api.newChat("private student prompt", null)).rejects.toThrow("No grant");
    await expect(api.sendChatMessage(1, "private student prompt", null)).rejects.toThrow("No grant");
    await expect(api.retryAgent(1, "model")).rejects.toThrow("No grant");
    const gadget = await api.getGadget(1);
    await expect(gadget.createBlueprint("private title")).rejects.toThrow("No grant");
    await expect(gadget.applyBlueprint("blueprint", { modelId: null })).rejects.toThrow("No grant");
    expect(requests).toHaveLength(11);
    expect(requests.every(r => r.userId === "student" && "workspaceId" in r && r.workspaceId === "workspace-id")).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/private|role=teacher/);
    expect(sideEffect).not.toHaveBeenCalled();
    gadget[Symbol.dispose]();
    api[Symbol.dispose]();
  });

  it.each(["build", "use"] as const)("rechecks retained %s gadget clients after revocation", async role => {
    const { api, requests, sideEffect, revoke } = await client("teacher", role);
    const gadget = await api.getGadget(1);
    await gadget.getUiBundle();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    revoke();
    await expect(gadget.getUiBundle()).rejects.toThrow("No grant");
    await expect(gadget.connectToGadget()).rejects.toThrow("No grant");
    await expect(gadget.getExportFormats()).rejects.toThrow("No grant");
    await expect(gadget.export("format")).rejects.toThrow("No grant");
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(requests.every(r => r.action === "gadget.execute")).toBe(true);
    gadget[Symbol.dispose]();
    api[Symbol.dispose]();
  });

  it("allows teacher sharing and refuses the same session after grant revocation", async () => {
    const { api, sideEffect, revoke } = await client("teacher");
    await expect(api.createShareLink("build")).resolves.toEqual({ key: "key", linkId: "link" });
    revoke();
    await expect(api.createShareLink("build")).rejects.toThrow("No grant");
    expect(sideEffect).toHaveBeenCalledTimes(1);
    api[Symbol.dispose]();
  });
});


it("refuses direct retained RPC when required school policy binding is missing", async () => {
  const sideEffect = vi.fn();
  const env = { REQUIRE_WORKSHOP_CAPABILITY_POLICY: "true" };
  // open() admits the caller under policy (SCHO-309), so a missing required binding refuses there.
  await expect(openFakeOverseer({}, { role: "build", impl: { env, getSharingManager: sideEffect } }))
    .rejects.toThrow("Required Workshop capability policy");
  // A session opened while the binding was present is refused once it is missing.
  const live = { REQUIRE_WORKSHOP_CAPABILITY_POLICY: "true" } as Record<string, unknown>;
  live.WORKSHOP_CAPABILITY_POLICY = { authorizeCapability: async () => ({ outcome: "allow" }) };
  const api = await openFakeOverseer({}, { role: "build", impl: {
    env: live, getSharingManager: sideEffect, admitPrincipal: async () => {},
  } });
  delete live.WORKSHOP_CAPABILITY_POLICY;
  try {
    await expect(api.createGadget("student")).rejects.toThrow("Required Workshop capability policy");
    await expect(api.createShareLink("build")).rejects.toThrow("Required Workshop capability policy");
    await expect(api.newChat("prompt", null)).rejects.toThrow("Required Workshop capability policy");
    expect(sideEffect).not.toHaveBeenCalled();
  } finally {
    api[Symbol.dispose]();
  }
});
