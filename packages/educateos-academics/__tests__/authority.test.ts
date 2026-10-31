import { describe, expect, it } from "vitest";
import { EducateOsError } from "@educateos/contracts";
import { assertOperationRoutable, bindingsFromAuthorityMap } from "../src/index.ts";
import { ALL_LOCAL, ROSTER_EXTERNAL } from "./setup.ts";

function refusal(run: () => void): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof EducateOsError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("authority bindings from an authority map", () => {
  it("bind the directory as the map says and the other domains locally by default", () => {
    const bindings = bindingsFromAuthorityMap(ROSTER_EXTERNAL);
    expect(bindings.version).toBe(1);
    for (const [domain, source] of Object.entries(ROSTER_EXTERNAL)) {
      expect(bindings.domains[domain as keyof typeof ROSTER_EXTERNAL].source).toBe(source);
    }
    expect(bindings.domains.enrollment).toMatchObject({ writeMode: "provider-only", syncDirection: "inbound", conflictPolicy: "source-wins" });
    expect(bindings.domains.grade).toMatchObject({ source: "local", writeMode: "read-write", syncDirection: "none" });
  });

  it("bind assignments, submissions, grades or content to an external source when told", () => {
    const bindings = bindingsFromAuthorityMap(ALL_LOCAL, { assignment: "external:canvas", grade: "external:canvas" });
    expect(bindings.domains.assignment.source).toBe("external:canvas");
    expect(bindings.domains.grade.writeMode).toBe("provider-only");
    expect(bindings.domains.content.source).toBe("local");
  });
});

describe("routing an operation by its domain's binding", () => {
  it("refuses a write to an externally owned domain with a conflict naming the owner", () => {
    const bindings = bindingsFromAuthorityMap(ALL_LOCAL, { assignment: "external:canvas" });
    expect(refusal(() => assertOperationRoutable(bindings, "assignment", { name: "create_assignment", writes: true }))).toEqual({
      code: "conflict",
      message: "Assignments are owned by external:canvas; change them there and let its sync update EducateOS.",
    });
    // A read answers from EducateOS's projection.
    expect(() => assertOperationRoutable(bindings, "assignment", { name: "list_assignments", writes: false })).not.toThrow();
    // A local domain takes writes.
    expect(() => assertOperationRoutable(bindings, "content", { name: "create_resource", writes: true })).not.toThrow();
  });

  it("names the same owner for directory kinds as the directory's own refusal does", () => {
    const bindings = bindingsFromAuthorityMap(ROSTER_EXTERNAL);
    expect(refusal(() => assertOperationRoutable(bindings, "enrollment", { name: "create_enrollment", writes: true })).message)
      .toBe("Enrollments are owned by external:oneroster; change them there and let its sync update EducateOS.");
  });

  it("refuses writes to a read-only projection and any operation the binding does not route", () => {
    const base = bindingsFromAuthorityMap(ALL_LOCAL, { content: "external:publisher" });
    const bindings = {
      ...base,
      domains: {
        ...base.domains,
        content: { ...base.domains.content, writeMode: "read-only" as const },
        grade: { ...base.domains.grade, allowedOperations: ["approve_grade"] },
      },
    };
    expect(refusal(() => assertOperationRoutable(bindings, "content", { name: "update_resource", writes: true }))).toEqual({
      code: "conflict",
      message: "Content resources are owned by external:publisher and are read-only in EducateOS.",
    });
    expect(refusal(() => assertOperationRoutable(bindings, "grade", { name: "list_grades", writes: false }))).toEqual({
      code: "conflict",
      message: "list_grades is not routed to local for official grades.",
    });
    expect(() => assertOperationRoutable(bindings, "grade", { name: "approve_grade", writes: true })).not.toThrow();
  });
});
