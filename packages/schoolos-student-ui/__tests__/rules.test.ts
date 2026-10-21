import { describe, expect, it } from "vitest";
import { DistrictApiError } from "@schoolos/api-client";
import { messageFor } from "../src/api.tsx";
import { groupCourses, workByStep, workTitle } from "../src/courses.ts";
import { parseCsv, toCsv } from "../src/csv.ts";
import { receiptCode } from "../src/labels.ts";
import type { AssignedActivity, ArtifactView, Me, WorkspaceView } from "../src/model.ts";

const me = (offerings: string[]) => ({ enrollments: offerings.map((offeringId) => ({ offeringId, role: "student" })) }) as unknown as Me;
const course = (offeringId: string, lifecycle: string) => ({ kind: "course", id: `wsp_${offeringId}`, offeringId, lifecycle }) as unknown as WorkspaceView;

describe("grouping classes", () => {
  it("puts an enrolled class with no workspace yet in this term, and a finished term's class in the past", () => {
    const { current, past } = groupCourses(me(["off_a", "off_b"]), [course("off_b", "active"), course("off_c", "retained"), course("off_d", "completed")]);
    expect(current.map((c) => c.offeringId)).toStrictEqual(["off_a", "off_b"]);
    expect(past.map((c) => c.offeringId)).toStrictEqual(["off_c", "off_d"]);
  });

  it("puts a finished class in the past even while the enrollment is still listed", () => {
    const { current, past } = groupCourses(me(["off_c"]), [course("off_c", "retained")]);
    expect(current).toStrictEqual([]);
    expect(past.map((c) => c.offeringId)).toStrictEqual(["off_c"]);
  });
});

const artifact = (title: string, deletedAt?: string) => ({ artifact: { title, ...(deletedAt === undefined ? {} : { deletedAt }) } }) as unknown as ArtifactView;
const failure = (code: "unavailable" | "forbidden") => new DistrictApiError(500, { code, message: "wsp_123 failed in r2 bucket" });

describe("finding a step's work", () => {
  const entry = {
    assignment: { title: "Essay" },
    activity: { content: { steps: [{ id: "a", title: "Draft", response: { kind: "writing" } }, { id: "b", title: "Read", response: { kind: "none" } }] } },
  } as unknown as AssignedActivity;

  it("matches saved work by its title, and ignores deleted work and other assignments' work", () => {
    const title = workTitle(entry.assignment, entry.activity.content.steps[0]!);
    expect(title).toBe("Essay: Draft");
    const found = workByStep(entry.assignment, entry.activity.content, [artifact("Other: Draft"), artifact(title, "2026-01-01T00:00:00Z"), artifact(title)]);
    expect([...found.keys()]).toStrictEqual(["a"]);
    expect(found.get("a")!.artifact.deletedAt).toBeUndefined();
  });
});

describe("CSV", () => {
  it("round-trips fields with commas, quotes and line breaks", () => {
    const rows = [["Note", "Value"], ['said "hi", then left', "line one\nline two"], ["", "3"]];
    expect(parseCsv(toCsv(rows))).toStrictEqual(rows);
  });

  it("reads CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toStrictEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("the receipt code", () => {
  it("is the digest's first twelve hex digits in groups of four", () => {
    expect(receiptCode(`sha256:3f9a21bc0d7e${"0".repeat(52)}`)).toBe("3F9A-21BC-0D7E");
  });
});

describe("error messages", () => {
  it("shows the district's own words only for a conflict, never an internal message", () => {
    expect(messageFor(new DistrictApiError(409, { code: "conflict", message: "Work can be kept once the class has closed." }))).toBe("Work can be kept once the class has closed.");
    expect(messageFor(failure("unavailable"))).not.toMatch(/wsp_|r2/);
    expect(messageFor(failure("forbidden"))).not.toMatch(/wsp_|r2/);
    expect(messageFor(new TypeError("Failed to fetch"))).toMatch(/connection/);
  });
});
