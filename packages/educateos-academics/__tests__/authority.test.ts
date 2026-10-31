import { describe, expect, it } from "vitest";
import { EducateOsError } from "@educateos/contracts";
import { assertOperationRoutable, bindingsFromAuthorityMap, gradeBindingForOffering } from "../src/index.ts";
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

describe("an offering's grade authority refining the district's grade binding", () => {
  it("lets a class of a locally graded district keep its grades or hold them in an LMS, publishing out", () => {
    const district = bindingsFromAuthorityMap(ALL_LOCAL).domains.grade;
    expect(gradeBindingForOffering(district, "local")).toEqual(district);
    expect(gradeBindingForOffering(district, "lms:canvas")).toEqual({ ...district, syncDirection: "outbound" });
    // Who may write EducateOS's grade records is unchanged.
    expect(gradeBindingForOffering(district, "lms:canvas").writeMode).toBe("read-write");
  });

  it("never widens an external binding: a class may only name the district's own grade system", () => {
    const district = bindingsFromAuthorityMap(ALL_LOCAL, { grade: "external:canvas" }).domains.grade;
    expect(gradeBindingForOffering(district, "lms:canvas")).toEqual(district);
    expect(refusal(() => gradeBindingForOffering(district, "local"))).toEqual({
      code: "conflict",
      message: "Official grades are owned by external:canvas for the whole district, so a class cannot keep them in EducateOS.",
    });
    expect(refusal(() => gradeBindingForOffering(district, "lms:schoology"))).toEqual({
      code: "conflict",
      message: "Official grades are owned by external:canvas for the whole district, so a class cannot keep them in lms:schoology.",
    });
    const readOnly = { ...district, writeMode: "read-only" as const };
    expect(gradeBindingForOffering(readOnly, "lms:canvas")).toEqual(readOnly);
  });

  it("refines to a binding no wider than the district's, for every combination", () => {
    const sources = ["local", "external:canvas", "external:schoology"] as const;
    const offerings = ["local", "lms:canvas", "lms:schoology"] as const;
    const rank = { "read-write": 2, "provider-only": 1, "read-only": 0 } as const;
    for (const source of sources) {
      const district = bindingsFromAuthorityMap(ALL_LOCAL, { grade: source }).domains.grade;
      for (const offering of offerings) {
        let refined;
        try {
          refined = gradeBindingForOffering(district, offering);
        } catch (error) {
          expect(error).toBeInstanceOf(EducateOsError);
          continue;
        }
        expect(refined.source).toBe(district.source);
        expect(rank[refined.writeMode]).toBeLessThanOrEqual(rank[district.writeMode]);
        expect(refined.allowedOperations).toEqual(district.allowedOperations);
      }
    }
  });
});
