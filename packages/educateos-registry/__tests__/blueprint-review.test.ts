import { describe, expect, it } from "vitest";
import { Principal, RoleAssignment } from "@educateos/contracts";
import { BlueprintEducationMetadata, BlueprintReviewCatalog, type BlueprintReviewActor } from "../src/index.ts";

const hash = `sha256:${"a".repeat(64)}`;
const scope = { level: "district", districtId: "dst_demo" };
const now = new Date("2026-10-30T12:00:00Z");
function actor(id: string, kind = "staff", role = "teacher", districtId = "dst_demo"): BlueprintReviewActor {
  return {
    principal: Principal.parse({ id, kind, districtId, status: "active", displayName: "Private name",
      externalIdentities: [{ districtId, issuer: "https://id.example", subject: id }] }),
    assignments: [RoleAssignment.parse({ principalId: id, role, scope: { ...scope, districtId }, source: "local-grant" })],
  };
}
const student = actor("prn_student", "student", "student");
const teacher = actor("prn_teacher");
const metadata = () => ({
  id: "rsc_blueprint", version: "1.0.0", artifactDigest: hash, scope,
  author: { id: student.principal.id, kind: "student" }, instructionalIntent: "practice", gradeBand: "6-8",
  standards: [{ competencyUri: "https://standards.example/item", frameworkUri: "https://standards.example", frameworkRevision: "1" }],
  requiredCapabilities: [], license: "MIT", provenance: { source: "original", sourceDigest: hash },
  accessibility: { features: ["keyboard"], hazards: [], evidenceDigest: hash },
  evaluation: { evidenceDigest: hash, outcome: "passed" },
});
function setup() {
  const catalog = new BlueprintReviewCatalog();
  catalog.create(metadata(), student);
  const step = (action: "submitted" | "reviewed" | "approved" | "rejected" | "revoked", who = teacher, requestId: string = action) =>
    catalog.transition("rsc_blueprint", "1.0.0", action, requestId, who, now);
  return { catalog, step };
}

describe("Blueprint publication integration", () => {
  it("requires teacher review and approval, exports a closed manifest, and removes revoked entries", () => {
    const { catalog, step } = setup();
    expect(catalog.exportEntries()).toEqual([]);
    step("submitted", student);
    expect(() => step("approved")).toThrow("Invalid review transition");
    step("reviewed");
    step("approved");
    const exported = catalog.exportEntries();
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toMatch(/prn_|dst_|Private name|https:|subject|scope|standards/);
    exported[0]!.requiredCapabilities.push("tampered" as never);
    expect(catalog.exportEntries()[0]!.requiredCapabilities).toEqual([]);
    step("revoked");
    expect(catalog.exportEntries()).toEqual([]);
    expect(() => step("approved", teacher, "republish")).toThrow();
  });

  it("denies student escalation, foreign districts, narrow scopes, expired roles and inactive staff", () => {
    const { step } = setup();
    step("submitted", student);
    const narrow = actor("prn_narrow");
    narrow.assignments[0]!.scope = RoleAssignment.parse({ ...narrow.assignments[0],
      scope: { level: "school", districtId: "dst_demo", schoolId: "sch_one" } }).scope;
    const expired = actor("prn_expired");
    expired.assignments[0]!.validUntil = "2026-01-01T00:00:00Z";
    const inactive = actor("prn_inactive");
    inactive.principal.status = "inactive";
    for (const who of [student, actor("prn_other", "staff", "district-admin", "dst_other"), narrow, expired, inactive]) {
      expect(() => step("reviewed", who)).toThrow();
    }
    expect(step("reviewed").state).toBe("reviewed");
  });

  it("does not permit self-review even for staff authors", () => {
    const catalog = new BlueprintReviewCatalog();
    catalog.create({ ...metadata(), author: { id: teacher.principal.id, kind: "staff" } }, teacher);
    catalog.transition("rsc_blueprint", "1.0.0", "submitted", "submit", teacher, now);
    expect(() => catalog.transition("rsc_blueprint", "1.0.0", "reviewed", "review", teacher, now)).toThrow("denied");
  });

  it("pins approvals to immutable versions and prevents ownership changes", () => {
    const { catalog, step } = setup();
    step("submitted", student); step("reviewed"); step("approved");
    expect(() => catalog.create({ ...metadata(), artifactDigest: `sha256:${"b".repeat(64)}` }, student)).toThrow("immutable");
    expect(catalog.create({ ...metadata(), version: "1.0.1" }, student).state).toBe("draft");
    expect(catalog.exportEntries().map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(() => catalog.create({ ...metadata(), version: "2.0.0", author: { id: teacher.principal.id, kind: "staff" } }, teacher)).toThrow("ownership");
  });

  it("retries commands without duplicate events and rejects conflicting request reuse", () => {
    const { catalog, step } = setup();
    step("submitted", student);
    step("reviewed", teacher, "decision");
    expect(step("reviewed", teacher, "decision").history).toHaveLength(2);
    expect(() => step("approved", teacher, "decision")).toThrow("Idempotency conflict");
    step("approved"); step("revoked");
    expect(step("approved").state).toBe("revoked");
    expect(catalog.exportEntries()).toEqual([]);
  });

  it("rejects extra credentials and data at every manifest boundary", () => {
    for (const input of [
      { ...metadata(), credentials: { token: "private" } },
      { ...metadata(), evaluation: { ...metadata().evaluation, studentData: [] } },
      { ...metadata(), provenance: { ...metadata().provenance, url: "https://user:secret@example.test" } },
    ]) expect(BlueprintEducationMetadata.safeParse(input).success).toBe(false);
  });

  it("keeps rejected versions terminal and refuses failed evaluations", () => {
    const { step } = setup();
    step("submitted", student); step("rejected");
    expect(() => step("reviewed")).toThrow();
    const catalog = new BlueprintReviewCatalog();
    catalog.create({ ...metadata(), evaluation: { ...metadata().evaluation, outcome: "failed" } }, student);
    for (const action of ["submitted", "reviewed"] as const) catalog.transition("rsc_blueprint", "1.0.0", action, action,
      action === "submitted" ? student : teacher, now);
    expect(() => catalog.transition("rsc_blueprint", "1.0.0", "approved", "approve", teacher, now)).toThrow("Evaluation must pass");
  });
});
