// SCHO-100: every Assessment CI entry point converges on the same immutable run, and the queue
// finds runs left waiting.
import { ContentDigest } from "@schoolos/contracts";
import { canonicalTextBytes, sha256Digest } from "@schoolos/learning-artifacts";
import { describe, expect, it } from "vitest";
import {
  XLSX_MEDIA_TYPE,
  externalSnapshotWork,
  gadgetResultWork,
  reviewedCheckpointWork,
  rubricRef,
  uploadedWork,
  type AssessableWork,
  type AssessmentRuns,
} from "../src/index.ts";
import { workbook } from "./xlsx-fixture.ts";
import { LAB_CSV, O, P, labRubric, rejectsWith, setup } from "./setup.ts";

const NONE = { level: "none" } as const;
/** {@link LAB_CSV} as the converter writes the workbook holding the same data: `5.0` is the number 5. */
const SAME_AS_CSV = LAB_CSV.trimEnd().replace("5.0", "5");

/** The lab workbook a student might upload instead of a CSV: the same data, as XLSX. */
async function labWorkbook(): Promise<Uint8Array> {
  const header = ["Trial", "Temperature (°C)", "Mass (g)", "Time (s)"];
  const data = [[1, 20, 5.2, 30], [2, 20, 5.0, 31], [3, 20, 5.4, 29], [4, 20, 5.1, 30]];
  const cols = ["A", "B", "C", "D"];
  const rows = [
    `<row r="1">${header.map((_, i) => `<c r="${cols[i]}1" t="s"><v>${i}</v></c>`).join("")}</row>`,
    ...data.map((values, r) => `<row r="${r + 2}">${values.map((v, i) => `<c r="${cols[i]}${r + 2}"><v>${v}</v></c>`).join("")}</row>`),
  ].join("");
  return workbook([{ name: "Osmosis", rows }], header);
}

async function runOn(runs: AssessmentRuns, work: AssessableWork, rubric: ReturnType<typeof rubricRef>, idempotencyKey = "k") {
  const run = await runs.request({ submissionDigest: work.submissionDigest, rubricRelease: rubric, executionProfile: "deterministic@1", idempotencyKey });
  return runs.execute(run.id, work);
}

describe("entry points", () => {
  it("assesses an uploaded XLSX workbook exactly as the same data uploaded as CSV", async () => {
    const env = setup();
    const release = await env.publishRubric(P.morgan, labRubric());
    const xlsx = await uploadedWork(O.bioFall, [{ name: "osmosis.xlsx", artifactType: "dataset", mediaType: XLSX_MEDIA_TYPE, aiAssistance: NONE, bytes: await labWorkbook() }]);
    const csv = await uploadedWork(O.bioFall, [{ name: "osmosis.xlsx", artifactType: "dataset", mediaType: "text/csv", aiAssistance: NONE, bytes: new TextEncoder().encode(SAME_AS_CSV) }]);
    expect(xlsx.items[0]?.mediaType).toBe("text/csv");
    // Same name, same canonical text (numbers in their shortest form): the same work, and so the same run.
    expect(xlsx.submissionDigest).toBe(csv.submissionDigest);
    const run = await runOn(env.runs, xlsx, rubricRef(release));
    expect(run.state).toBe("completed");
    expect((await runOn(env.runs, csv, rubricRef(release))).id).toBe(run.id);
    const passed = run.report!.criteria.flatMap((c) => c.checks.flatMap((k) => k.evidence)).filter((e) => e.passed === true);
    expect(passed.length).toBeGreaterThan(0);

    await rejectsWith(uploadedWork(O.bioFall, [{ name: "photo.png", artifactType: "image", mediaType: "image/png", aiAssistance: NONE, bytes: new Uint8Array([137, 80]) }]), "validation-failed");
    await rejectsWith(uploadedWork(O.bioFall, [{ name: "notes.txt", artifactType: "document", mediaType: "text/plain", aiAssistance: NONE, bytes: new Uint8Array([0xff, 0xfe]) }]), "validation-failed");
  });

  it("assesses a native Gadget result, and the same result always names the same run", async () => {
    const env = setup();
    const release = await env.publishRubric(P.morgan, labRubric());
    const result = { gadgetId: "osmosis-simulator", resultId: "attempt-3", artifactType: "dataset", mediaType: "text/csv", aiAssistance: NONE, text: LAB_CSV } as const;
    const first = await gadgetResultWork(O.bioFall, result);
    const again = await gadgetResultWork(O.bioFall, result);
    expect(again.submissionDigest).toBe(first.submissionDigest);
    expect((await gadgetResultWork(O.bioFall, { ...result, resultId: "attempt-4" })).submissionDigest).not.toBe(first.submissionDigest);
    expect((await runOn(env.runs, first, rubricRef(release))).state).toBe("completed");
    await rejectsWith(gadgetResultWork(O.bioFall, { ...result, mediaType: "application/json" as "text/csv" }), "validation-failed");
  });

  it("assesses a permitted external snapshot only from an approved host and only as recorded", async () => {
    const snapshotDigest = ContentDigest.parse(await sha256Digest(canonicalTextBytes(LAB_CSV)));
    const snapshot = { url: "https://docs.northfield.example/d/osmosis", snapshotDigest, artifactType: "dataset", mediaType: "text/csv", aiAssistance: NONE, text: LAB_CSV } as const;
    const work = await externalSnapshotWork(O.bioFall, snapshot, ["docs.northfield.example"]);
    expect(await work.readText(work.items[0]!)).toBe(LAB_CSV);
    await rejectsWith(externalSnapshotWork(O.bioFall, snapshot, ["drive.other.example"]), "forbidden");
    await rejectsWith(externalSnapshotWork(O.bioFall, { ...snapshot, text: `${LAB_CSV}5,20,9.9,30\n` }, ["docs.northfield.example"]), "validation-failed");
    await rejectsWith(externalSnapshotWork(O.bioFall, { ...snapshot, url: "http://docs.northfield.example/d/osmosis" }, ["docs.northfield.example"]), "validation-failed");
  });

  it("assesses a reviewed checkpoint read as its reviewer, and refuses one the reviewer cannot read", async () => {
    const env = setup();
    const release = await env.publishRubric(P.morgan, labRubric());
    const workspace = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const data = await env.artifacts.createArtifact(P.amara, { workspaceId: workspace.id, type: "dataset", title: "Osmosis data", content: { kind: "text", mediaType: "text/csv", text: LAB_CSV }, aiAssistance: NONE });
    const checkpoint = { artifactId: data.artifact.id, revisionId: data.head.id };

    const work = await reviewedCheckpointWork({ artifacts: env.artifacts, reviewer: P.morgan, offeringId: O.bioFall, checkpoints: [checkpoint] });
    expect(work.items[0]?.digest).toBe(data.head.content.digest);
    expect((await runOn(env.runs, work, rubricRef(release))).state).toBe("completed");

    // Another class's teacher and a classmate cannot read it; nor is it work from another class.
    await rejectsWith(reviewedCheckpointWork({ artifacts: env.artifacts, reviewer: P.rivera, offeringId: O.bioFall, checkpoints: [checkpoint] }), "not-found");
    await rejectsWith(reviewedCheckpointWork({ artifacts: env.artifacts, reviewer: P.elena, offeringId: O.bioFall, checkpoints: [checkpoint] }), "not-found");
    await rejectsWith(reviewedCheckpointWork({ artifacts: env.artifacts, reviewer: P.morgan, offeringId: O.eng9, checkpoints: [checkpoint] }), "not-found");
  });
});

describe("the run queue", () => {
  it("finds queued runs and runs whose worker's lease expired, and drains them", async () => {
    const env = setup();
    const release = await env.publishRubric(P.morgan, labRubric());
    const work = await gadgetResultWork(O.bioFall, { gadgetId: "sim", resultId: "r1", artifactType: "dataset", mediaType: "text/csv", aiAssistance: NONE, text: LAB_CSV });
    const queued = await env.runs.request({ submissionDigest: work.submissionDigest, rubricRelease: rubricRef(release), executionProfile: "deterministic@1", idempotencyKey: "queued" });
    const stuck = await env.runs.request({ submissionDigest: work.submissionDigest, rubricRelease: rubricRef(release), executionProfile: "deterministic@1", idempotencyKey: "stuck" });
    // A worker claims `stuck` and dies.
    await env.runStore.replace({ ...stuck, state: "running", attempts: 1, startedAt: new Date(Date.parse("2026-10-20T12:00:00Z") - 10 * 60 * 1000).toISOString(), revision: 1 }, 0);

    const due = await env.runStore.runnable(new Date(Date.parse("2026-10-20T12:00:00Z") - 5 * 60 * 1000), 10);
    expect(due.map((r) => r.id).toSorted()).toEqual([queued.id, stuck.id].toSorted());

    const drained = await env.runs.drain(async (run) => (run.key.submissionDigest === work.submissionDigest ? work : undefined));
    expect(drained.map((r) => r.state)).toEqual(["completed", "completed"]);
    expect(await env.runStore.runnable(new Date("2026-10-20T12:00:00Z"), 10)).toEqual([]);
  });
});
