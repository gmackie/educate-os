import { describe, expect, it } from "vitest";
import { AuthorityBinding, AuthorityBindings, AuthorityDomain } from "../src/index.ts";

const local = { source: "local", writeMode: "read-write", syncDirection: "none", conflictPolicy: "refuse", allowedOperations: "all", revision: 1 } as const;
const canvas = { source: "external:canvas", writeMode: "provider-only", syncDirection: "inbound", conflictPolicy: "source-wins", allowedOperations: "all", revision: 3 } as const;

describe("authority bindings", () => {
  it("accept coherent local and external bindings", () => {
    expect(AuthorityBinding.parse(local)).toEqual(local);
    expect(AuthorityBinding.parse(canvas)).toEqual(canvas);
    expect(AuthorityBinding.parse({ ...local, syncDirection: "outbound", allowedOperations: ["create_assignment"] }).syncDirection).toBe("outbound");
    expect(AuthorityBinding.parse({ ...canvas, writeMode: "read-only" }).writeMode).toBe("read-only");
  });

  it("refuse a binding that would let EducateOS compete with its source", () => {
    expect(AuthorityBinding.safeParse({ ...canvas, writeMode: "read-write" }).success).toBe(false);
    expect(AuthorityBinding.safeParse({ ...local, writeMode: "provider-only" }).success).toBe(false);
    expect(AuthorityBinding.safeParse({ ...local, syncDirection: "inbound" }).success).toBe(false);
  });

  it("refuse malformed sources, operation names and revisions", () => {
    expect(AuthorityBinding.safeParse({ ...canvas, source: "canvas" }).success).toBe(false);
    expect(AuthorityBinding.safeParse({ ...local, allowedOperations: [] }).success).toBe(false);
    expect(AuthorityBinding.safeParse({ ...local, allowedOperations: ["Create Thing"] }).success).toBe(false);
    expect(AuthorityBinding.safeParse({ ...local, revision: 0 }).success).toBe(false);
  });

  it("require a binding for every domain, at version 1, and nothing else", () => {
    const domains = Object.fromEntries(AuthorityDomain.options.map((d) => [d, local]));
    expect(AuthorityDomain.options).toEqual(expect.arrayContaining(["assignment", "submission", "grade", "content"]));
    expect(AuthorityBindings.safeParse({ version: 1, domains }).success).toBe(true);
    const { grade: _grade, ...missing } = domains;
    expect(AuthorityBindings.safeParse({ version: 1, domains: missing }).success).toBe(false);
    expect(AuthorityBindings.safeParse({ version: 1, domains: { ...domains, quizzes: local } }).success).toBe(false);
    expect(AuthorityBindings.safeParse({ version: 2, domains }).success).toBe(false);
  });
});
