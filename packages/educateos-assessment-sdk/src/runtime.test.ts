import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AssessmentDefinition, AssessmentReport, AssessmentTask, Evidence } from "./contracts.ts";
import { canonicalJson, digestBytes, digestJson, releaseAssessment, verifyAssessment } from "./canonical.ts";
import { createAssessmentRuntime, InMemoryArtifactStorage, type AuthorizedPrincipal, type EvaluationProvider } from "./runtime.ts";
import { bindAssessmentBlueprint, createGadgetAssessment, exportAssessmentBlueprint, importAssessmentBlueprint } from "./blueprint.ts";
import { demoBlueprint, demoDefinition, demoDistrict, demoProvider } from "../examples/demo.ts";

async function setup(kind: AssessmentTask["kind"] = "writing") {
  const provider = await demoProvider();
  const definition = demoDefinition(provider);
  definition.tasks[0]!.kind = kind;
  const release = await releaseAssessment(definition);
  const binding = { districtId: "north", instanceId: "science", assessmentDigest: release.digest };
  let principal: AuthorizedPrincipal = { id: "learner", districtId: "north", kind: "student", channel: "human" };
  const artifacts = new InMemoryArtifactStorage();
  const bytes = new TextEncoder().encode("My explicit scientific observation.");
  const evidence: Evidence = { id: "work", requirementId: "reflection-text", artifactId: "art", revisionId: "rev", digest: await digestBytes(bytes), mediaType: "text/plain" };
  await artifacts.put({ ...binding, subjectId: principal.id }, evidence, bytes);
  const evaluate = vi.fn(provider.evaluate);
  const record = vi.fn(async () => undefined);
  const ports = { authorize: vi.fn(async () => principal), artifacts, evaluators: { resolve: () => ({ ...provider, evaluate }) }, reviews: { record } };
  const runtime = await createAssessmentRuntime({ definition, binding, ports });
  const request = { taskId: "reflection", evidence: [evidence], assistanceUsed: [], idempotencyKey: "one" };
  return { runtime, request, ports, evaluate, record, definition, binding, artifacts, evidence, bytes, provider, setPrincipal: (value: AuthorizedPrincipal) => { principal = value; } };
}

describe("strict public contracts and immutable releases", () => {
  it("supports eight explicit task kinds, rejects unknown fields at every public level", async () => {
    const definition = demoDefinition(await demoProvider());
    for (const kind of ["quiz", "writing", "gadget", "programming", "simulation", "conversation", "multimedia", "portfolio"]) {
      expect(AssessmentTask.parse({ ...definition.tasks[0], kind }).kind).toBe(kind);
    }
    for (const field of ["students", "credentials", "secrets", "hiddenTests", "answerKey", "evaluatorConfig"]) {
      expect(() => AssessmentDefinition.parse({ ...definition, [field]: [] })).toThrow();
      expect(() => AssessmentTask.parse({ ...definition.tasks[0], [field]: [] })).toThrow();
    }
    expect(() => AssessmentTask.parse({ ...definition.tasks[0], kind: "unknown" })).toThrow();
    expect(() => AssessmentDefinition.parse({ ...definition, tasks: [...definition.tasks, ...definition.tasks] })).toThrow();
    expect(() => AssessmentDefinition.parse({ ...definition, outcomes: [{ id: "x", description: "x", caseUri: "javascript:alert(1)" }] })).toThrow();
  });
  it("has stable canonical bytes and known SHA-256 vectors; rejects non-JSON values", async () => {
    expect(canonicalJson({ z: [2, 1], a: { b: true, a: null } })).toBe('{"a":{"a":null,"b":true},"z":[2,1]}');
    expect(await digestJson({ a: 1, b: 2 })).toBe(await digestJson({ b: 2, a: 1 }));
    expect(await digestBytes(new TextEncoder().encode("abc"))).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const value of [undefined, NaN, Infinity, new Date(), { a: undefined }, [undefined], Object.assign([], { length: 2 }), new Map(), BigInt(1)]) expect(() => canonicalJson(value)).toThrow();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow();
  });
  it("pins all changes, freezes releases, and rejects an altered imported definition", async () => {
    const definition = demoDefinition(await demoProvider());
    const release = await releaseAssessment(definition);
    definition.title = "Changed";
    expect(release.definition.title).not.toBe("Changed");
    expect(Object.isFrozen(release.definition.tasks[0])).toBe(true);
    await expect(verifyAssessment(definition, release.digest)).rejects.toThrow("digest mismatch");
    expect((await releaseAssessment({ ...release.definition, version: "1.0.1" })).digest).not.toBe(release.digest);
    expect((await releaseAssessment({ ...release.definition, evaluator: { ...release.definition.evaluator, digest: "sha256:" + "f".repeat(64) } })).digest).not.toBe(release.digest);
  });
});

describe("authorized runtime", () => {
  it("coalesces concurrent retries, preserves deterministic reports and isolates returned mutations", async () => {
    const env = await setup();
    const [one, two] = await Promise.all([env.runtime.evaluate(env.request), env.runtime.evaluate(env.request)]);
    expect(one).toEqual(two);
    expect(env.evaluate).toHaveBeenCalledTimes(1);
    one.report.findings[0]!.observation = "tampered";
    expect((await env.runtime.evaluate(env.request)).report).toEqual(two.report);
    expect(two.report.authority).toBe("suggestion");
    expect(await env.runtime.evaluate({ ...env.request, idempotencyKey: "same-work-new-key" })).toEqual(two);
    const disclosed = await env.runtime.evaluate({ ...env.request, idempotencyKey: "disclosed", assistanceUsed: ["feedback"] });
    expect(disclosed.report.provenance.assistanceUsed).toEqual(["feedback"]);
    expect(two.report.provenance.evaluator).toEqual(env.provider.release);
    await expect(env.runtime.evaluate({ ...env.request, taskId: "other" })).rejects.toThrow();
    await expect(env.runtime.evaluate({ ...env.request, evidence: [{ ...env.evidence, revisionId: "changed" }] })).rejects.toThrow("Idempotency");
  });
  it("authenticates retries and rejects role injection, district spoofing and peer reads", async () => {
    const env = await setup();
    await env.runtime.evaluate(env.request);
    await expect(env.runtime.evaluate({ ...env.request, principal: { kind: "teacher" } })).rejects.toThrow();
    env.setPrincipal({ id: "learner", districtId: "south", kind: "teacher", channel: "human" });
    await expect(env.runtime.evaluate(env.request)).rejects.toThrow("district");
    env.setPrincipal({ id: "peer", districtId: "north", kind: "student", channel: "human" });
    await expect(env.runtime.evaluate(env.request)).rejects.toThrow("scope");
  });
  it("refuses missing/extra requirements, disallowed assistance and mutable content", async () => {
    const env = await setup();
    await expect(env.runtime.evaluate({ ...env.request, assistanceUsed: ["revision"] })).rejects.toThrow("permission");
    await expect(env.runtime.evaluate({ ...env.request, evidence: [{ ...env.evidence, requirementId: "other" }] })).rejects.toThrow("Missing");
    await expect(env.runtime.evaluate({ ...env.request, idempotencyKey: "two", evidence: [env.evidence, env.evidence] })).rejects.toThrow("Duplicate");
    await expect(env.artifacts.put({ ...env.binding, subjectId: "learner" }, env.evidence, new TextEncoder().encode("changed"))).rejects.toThrow("digest");
    const modified = new TextEncoder().encode("Different revision bytes");
    await expect(env.artifacts.put({ ...env.binding, subjectId: "learner" }, { ...env.evidence, digest: await digestBytes(modified) }, modified)).rejects.toThrow("immutable");
  });
  it("verifies bytes returned by a custom port instead of trusting its digest claim", async () => {
    const env = await setup();
    const runtime = await createAssessmentRuntime({ definition: env.definition, binding: env.binding, ports: { ...env.ports, artifacts: { read: async () => new TextEncoder().encode("changed") } } });
    await expect(runtime.evaluate(env.request)).rejects.toThrow("digest mismatch");
    expect(env.evaluate).not.toHaveBeenCalled();
  });
  it("enforces evidence size bounds and safe explicit text decoding", async () => {
    const env = await setup();
    env.definition.tasks[0]!.evidence[0]!.maxBytes = 1;
    const release = await releaseAssessment(env.definition);
    const runtime = await createAssessmentRuntime({ definition: env.definition, binding: { ...env.binding, assessmentDigest: release.digest }, ports: env.ports });
    await expect(runtime.evaluate(env.request)).rejects.toThrow("size limit");
  });
  it("fails closed when programming or simulation has no sandbox", async () => {
    for (const kind of ["programming", "simulation"] as const) {
      const env = await setup(kind);
      await expect(env.runtime.evaluate(env.request)).rejects.toThrow("Sandbox unavailable");
      expect(env.evaluate).not.toHaveBeenCalled();
    }
  });
  it("refuses drifted evaluator releases and fabricated evidence references", async () => {
    const env = await setup();
    const changed = { ...env.provider, release: { ...env.provider.release, version: "2.0.0" } };
    const runtime = await createAssessmentRuntime({ definition: env.definition, binding: env.binding, ports: { ...env.ports, evaluators: { resolve: () => changed } } });
    await expect(runtime.evaluate(env.request)).rejects.toThrow("release mismatch");
    const fabricator: EvaluationProvider = { ...env.provider, evaluate: async () => [{ criterionId: "x", observation: "x", explanation: "x", evidenceIds: ["not-submitted"] }] };
    const other = await createAssessmentRuntime({ definition: env.definition, binding: env.binding, ports: { ...env.ports, evaluators: { resolve: () => fabricator } } });
    await expect(other.evaluate(env.request)).rejects.toThrow("submitted evidence");
  });
  it("allows only a directly authenticated authorized teacher to record an idempotent review", async () => {
    const env = await setup();
    const { reportId, report } = await env.runtime.evaluate(env.request);
    const review = { reportId, idempotencyKey: "review-one", decision: "accepted", comment: "Checked evidence." };
    await expect(env.runtime.review(review)).rejects.toThrow("teacher");
    env.setPrincipal({ id: "teacher", districtId: "north", kind: "teacher", channel: "agent" });
    await expect(env.runtime.review(review)).rejects.toThrow("teacher");
    env.setPrincipal({ id: "teacher", districtId: "north", kind: "teacher", channel: "human" });
    await Promise.all([env.runtime.review(review), env.runtime.review(review)]);
    expect(env.record).toHaveBeenCalledTimes(1);
    expect(env.ports.authorize).toHaveBeenCalledWith("review", { ...env.binding, subjectId: "learner" });
    expect(report.authority).toBe("suggestion");
    await expect(env.runtime.review({ ...review, decision: "needs-revision" })).rejects.toThrow("conflict");
    await expect(env.runtime.review({ ...review, grade: 100 })).rejects.toThrow();
  });
  it("rejects grade authority embedded in report data", async () => {
    const env = await setup();
    const { report } = await env.runtime.evaluate(env.request);
    expect(() => AssessmentReport.parse({ ...report, authority: "official-grade" })).toThrow(z.ZodError);
    expect(() => AssessmentReport.parse({ ...report, grade: 100 })).toThrow();
  });
});

describe("blueprint and district boundaries", () => {
  it("defines once, imports twice and cannot read across district or instance boundaries", async () => {
    const provider = await demoProvider();
    const blueprint = await demoBlueprint(provider);
    const north = await demoDistrict(blueprint, provider, "north");
    const south = await demoDistrict(blueprint, provider, "south");
    const a = await north.runtime.evaluate(north.request);
    const b = await south.runtime.evaluate(south.request);
    expect(a.report.assessmentDigest).toBe(b.report.assessmentDigest);
    await expect(south.runtime.evaluate({ ...south.request, evidence: north.request.evidence, idempotencyKey: "foreign" })).rejects.toThrow("scope");
    await expect(north.artifacts.read({ districtId: "north", instanceId: "other", subjectId: "synthetic-learner" }, north.request.evidence[0]!)).rejects.toThrow("scope");
    expect(Object.keys(createGadgetAssessment(north.runtime))).toEqual(["submit"]);
    await expect(createGadgetAssessment(north.runtime).submit({ ...north.request, districtId: "south" })).rejects.toThrow();
  });
  it("rejects private export fields and tampering; local bindings stay out of imports", async () => {
    const blueprint = await demoBlueprint(await demoProvider());
    const exported = await exportAssessmentBlueprint(blueprint);
    expect(await importAssessmentBlueprint(JSON.parse(exported))).toEqual(blueprint);
    for (const key of ["students", "records", "secrets", "hiddenTests", "bindings", "archive"]) await expect(exportAssessmentBlueprint({ ...blueprint, [key]: [] })).rejects.toThrow();
    await expect(importAssessmentBlueprint({ ...blueprint, definition: { ...blueprint.definition, title: "tampered" } })).rejects.toThrow("digest mismatch");
    const binding = await bindAssessmentBlueprint(blueprint, { districtId: "x", instanceId: "y" });
    expect(exported).not.toContain('"districtId"');
    expect(binding.assessmentDigest).toBe(blueprint.assessmentDigest);
  });
});
