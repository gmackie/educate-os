import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ArtifactId, OfferingId, PrincipalId, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { defineSchoolTool, SchoolToolRunner, type ToolTarget } from "../src/index.ts";
import { courseResource, engineFor, P } from "./setup.ts";

/** A stored artifact: the trusted record a tool resolves its target from. */
interface StoredArtifact {
  id: string;
  offeringId: string;
  ownerPrincipalId: string;
  text: string;
}

const ARTIFACTS: StoredArtifact[] = [
  { id: "art_amara-lab", offeringId: "off_nf-bio-fall-p2", ownerPrincipalId: "prn_nf-student-amara", text: "Amara's lab report" },
  { id: "art_elena-lab", offeringId: "off_nf-bio-fall-p2", ownerPrincipalId: "prn_nf-student-elena", text: "Elena's lab report" },
];

function targetOf(artifact: StoredArtifact | undefined, snapshot: DistrictDirectorySnapshot = NORTHFIELD): ToolTarget | undefined {
  if (artifact === undefined) return undefined;
  return courseResource(artifact.offeringId, "artifact", "course", { id: artifact.id, owner: artifact.ownerPrincipalId, snapshot });
}

function runnerFor() {
  const { engine, audit, store } = engineFor();
  const artifacts = structuredClone(ARTIFACTS);
  const handled = vi.fn();

  const readArtifact = defineSchoolTool({
    name: "read_artifact",
    description: "Read one artifact.",
    inputSchema: z.strictObject({ artifactId: ArtifactId }),
    action: "read",
    resource: async ({ artifactId }) => targetOf(artifacts.find((a) => a.id === artifactId)),
    handler: async ({ artifactId }) => {
      handled("read_artifact");
      return artifacts.find((a) => a.id === artifactId)!.text;
    },
  });

  // Annotated read-only, which it is not. The runner must authorize it as the update it is.
  const editArtifact = defineSchoolTool({
    name: "edit_artifact",
    description: "Replace an artifact's text.",
    inputSchema: z.strictObject({ artifactId: ArtifactId, text: z.string().max(10_000) }),
    action: "update",
    annotations: { readOnlyHint: true, destructiveHint: false },
    resource: async ({ artifactId }) => targetOf(artifacts.find((a) => a.id === artifactId)),
    handler: async ({ artifactId, text }) => {
      handled("edit_artifact");
      artifacts.find((a) => a.id === artifactId)!.text = text;
      return { ok: true };
    },
  });

  // Names a principal in its input: that is a selector for whose work, never who is asking.
  const listWork = defineSchoolTool({
    name: "list_student_work",
    description: "List a student's artifacts in an offering.",
    inputSchema: z.strictObject({ offeringId: OfferingId, studentId: PrincipalId }),
    action: "list",
    resource: async ({ offeringId, studentId }) => courseResource(offeringId, "artifact", "course", { owner: studentId }),
    handler: async ({ offeringId, studentId }) => {
      handled("list_student_work");
      return artifacts.filter((a) => a.offeringId === offeringId && a.ownerPrincipalId === studentId).map((a) => a.id);
    },
  });

  const recordGrade = defineSchoolTool({
    name: "record_grade",
    description: "Record an official grade.",
    inputSchema: z.strictObject({ offeringId: OfferingId, studentId: PrincipalId, score: z.number().min(0).max(100) }),
    action: "grade",
    annotations: { readOnlyHint: true },
    resource: async ({ offeringId, studentId }) => courseResource(offeringId, "official-grade", "course", { owner: studentId }),
    handler: async () => {
      handled("record_grade");
      return { recorded: true };
    },
  });

  const failing = defineSchoolTool({
    name: "explode",
    description: "Fails with an internal error.",
    inputSchema: z.strictObject({}),
    action: "read",
    resource: async (_, { principal }) => courseResource("off_nf-bio-fall-p2", "artifact", "course", { id: "art_x", owner: principal.principalId }),
    handler: async () => {
      throw new Error("database password is hunter2");
    },
  });

  const runner = new SchoolToolRunner({ tools: [readArtifact, editArtifact, listWork, recordGrade, failing], engine });
  return { runner, audit, artifacts, handled, store };
}

const mcp = (principal: typeof P.amara) => ({ principal, channel: "mcp-tool" as const });

describe("the school tool runner", () => {
  it("rejects an unknown tool name", async () => {
    const { runner } = runnerFor();
    for (const name of ["delete_everything", "__proto__", 42, undefined]) {
      expect(await runner.invoke(mcp(P.amara), name, {})).toMatchObject({ status: "error", error: { code: "not-found" } });
    }
  });

  it("rejects unknown input fields, including a principal, role or readOnlyHint the model adds", async () => {
    const { runner, handled, audit } = runnerFor();
    for (const extra of [{ principalId: "prn_nf-district-admin" }, { role: "teacher" }, { readOnlyHint: true }]) {
      const outcome = await runner.invoke(mcp(P.amara), "read_artifact", { artifactId: "art_elena-lab", ...extra });
      expect(outcome).toMatchObject({ status: "error", error: { code: "validation-failed" } });
    }
    expect(handled).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it("takes the subject from the session: a tool naming another student does not change who is asking", async () => {
    const { runner, handled, audit } = runnerFor();
    const asAmara = await runner.invoke(mcp(P.amara), "list_student_work", { offeringId: "off_nf-bio-fall-p2", studentId: "prn_nf-student-elena" });
    expect(asAmara).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(handled).not.toHaveBeenCalled();
    expect(audit.events.at(-1)).toMatchObject({ principalId: P.amara.principalId, effect: "deny" });

    const own = await runner.invoke(mcp(P.amara), "list_student_work", { offeringId: "off_nf-bio-fall-p2", studentId: "prn_nf-student-amara" });
    expect(own).toMatchObject({ status: "ok", value: ["art_amara-lab"] });
  });

  it("answers not-found for another student's artifact exactly as for a missing one", async () => {
    const { runner } = runnerFor();
    const other = await runner.invoke(mcp(P.amara), "read_artifact", { artifactId: "art_elena-lab" });
    const missing = await runner.invoke(mcp(P.amara), "read_artifact", { artifactId: "art_nobody" });
    for (const outcome of [other, missing]) {
      expect(outcome.status).toBe("error");
      if (outcome.status !== "error") continue;
      expect(outcome.error.code).toBe("not-found");
      expect(outcome.error.message).toBe("The requested resource was not found.");
    }
  });

  it("ignores readOnlyHint: an annotated edit is authorized as an update", async () => {
    const { runner, artifacts, handled } = runnerFor();
    const outcome = await runner.invoke(mcp(P.amara), "edit_artifact", { artifactId: "art_elena-lab", text: "overwritten" });
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(artifacts.find((a) => a.id === "art_elena-lab")!.text).toBe("Elena's lab report");
    expect(handled).not.toHaveBeenCalled();
  });

  it("answers forbidden for a write to something the caller may read but not change", async () => {
    const { runner, artifacts } = runnerFor();
    const outcome = await runner.invoke(mcp(P.morgan), "edit_artifact", { artifactId: "art_amara-lab", text: "teacher edit" });
    expect(outcome).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(artifacts.find((a) => a.id === "art_amara-lab")!.text).toBe("Amara's lab report");
  });

  it("returns approval-required for an AI grade write and does not run the tool, whatever its annotations say", async () => {
    const { runner, handled, audit } = runnerFor();
    const args = { offeringId: "off_nf-bio-fall-p2", studentId: "prn_nf-student-amara", score: 92 };
    for (const channel of ["mcp-tool", "agent"] as const) {
      const outcome = await runner.invoke({ principal: P.morgan, channel }, "record_grade", args);
      expect(outcome).toEqual({ status: "approval-required", correlationId: expect.any(String) });
      expect(audit.events.at(-1)).toMatchObject({
        correlationId: (outcome as { correlationId: string }).correlationId,
        effect: "require-approval",
        ruleId: "grade.official.needs-teacher-review",
      });
    }
    expect(await runner.invoke(mcp(P.amara), "record_grade", args)).toMatchObject({ status: "error" });
    expect(handled).not.toHaveBeenCalled();
  });

  it("re-authorizes every invocation against current directory facts", async () => {
    const { runner, store } = runnerFor();
    expect(await runner.invoke(mcp(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" })).toMatchObject({ status: "ok" });
    const { snapshot, version } = await store.load();
    snapshot.enrollments.find((e) => e.id === "enr_nf-02")!.status = "inactive";
    await store.commit(snapshot, version);
    // Dropped: she may still read her report, but no longer change it.
    expect(await runner.invoke(mcp(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v3" }))
      .toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await runner.invoke(mcp(P.amara), "read_artifact", { artifactId: "art_amara-lab" })).toMatchObject({ status: "ok", value: "v2" });
  });

  it("hides internal failures behind unavailable with a correlation ID", async () => {
    const { runner } = runnerFor();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runner.invoke(mcp(P.amara), "explode", {});
    expect(outcome).toMatchObject({ status: "error", error: { code: "unavailable", correlationId: expect.any(String) } });
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    error.mockRestore();
  });

  it("lists annotations for clients without them reaching any decision", () => {
    const { runner } = runnerFor();
    expect(runner.list().find((t) => t.name === "edit_artifact")).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: { additionalProperties: false },
    });
  });
});

describe("defineSchoolTool", () => {
  const base = {
    description: "x",
    action: "read" as const,
    resource: async () => undefined,
    handler: async () => null,
  };

  it("refuses a schema that would accept unknown fields", () => {
    expect(() => defineSchoolTool({ ...base, name: "loose", inputSchema: z.object({ a: z.string() }) })).toThrow(/strictObject/);
    expect(() => defineSchoolTool({ ...base, name: "passthrough", inputSchema: z.looseObject({ a: z.string() }) })).toThrow(/strictObject/);
  });

  it("refuses malformed names and duplicates", () => {
    expect(() => defineSchoolTool({ ...base, name: "Bad Name", inputSchema: z.strictObject({}) })).toThrow();
    const tool = defineSchoolTool({ ...base, name: "same", inputSchema: z.strictObject({}) });
    const { engine } = engineFor();
    expect(() => new SchoolToolRunner({ tools: [tool, tool], engine })).toThrow(/duplicate/);
  });
});
