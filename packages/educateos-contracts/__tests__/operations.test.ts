import { describe, expect, it } from "vitest";
import { assertOperationDescriptor, operationChannelFor, type OperationDescriptorFields } from "../src/index.ts";

const read: OperationDescriptorFields = { version: 1, effect: "read", channels: ["rest", "mcp-agent"], idempotency: "inherent", approval: "none" };

describe("operation descriptors", () => {
  it("accept a coherent descriptor", () => {
    expect(() => assertOperationDescriptor("list_things", read)).not.toThrow();
    expect(() => assertOperationDescriptor("draft_thing", { ...read, effect: "draft", idempotency: "keyed", approval: "confirm-agent", budget: { meter: "ai-model", maxCalls: 3 } })).not.toThrow();
  });

  it("refuse a read that repeats with effect or waits for anyone", () => {
    expect(() => assertOperationDescriptor("r", { ...read, idempotency: "none" })).toThrow(/reads/);
    expect(() => assertOperationDescriptor("r", { ...read, approval: "approver" })).toThrow(/reads/);
  });

  it("never expose an approve or delete to agents (RFC 0002 §2)", () => {
    for (const effect of ["approve", "delete"] as const) {
      expect(() => assertOperationDescriptor("x", { ...read, effect, approval: "approver" })).toThrow(/never exposed to mcp-agent/);
      expect(() => assertOperationDescriptor("x", { ...read, effect, approval: "approver", channels: ["ui", "rest"] })).not.toThrow();
    }
  });

  it("refuse an empty, unknown or repeated channel and an unknown effect", () => {
    expect(() => assertOperationDescriptor("x", { ...read, channels: [] })).toThrow();
    expect(() => assertOperationDescriptor("x", { ...read, channels: ["rest", "rest"] })).toThrow(/twice/);
    expect(() => assertOperationDescriptor("x", { ...read, channels: ["http" as never] })).toThrow();
    expect(() => assertOperationDescriptor("x", { ...read, effect: "write" as never })).toThrow();
  });

  it("map each request channel to the operation channel it arrives through", () => {
    expect(operationChannelFor("http")).toBe("rest");
    expect(operationChannelFor("mcp-tool")).toBe("mcp-agent");
    expect(operationChannelFor("agent")).toBe("mcp-agent");
    expect(operationChannelFor("system")).toBe("internal-job");
  });
});
