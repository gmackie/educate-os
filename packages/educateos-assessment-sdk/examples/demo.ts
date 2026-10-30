import {
  AssessmentDefinition, InMemoryArtifactStorage, bindAssessmentBlueprint, createAssessmentRuntime,
  digestBytes, digestJson, importAssessmentBlueprint, releaseAssessment,
  type AssessmentBlueprint, type AuthorizedPrincipal, type EvaluationProvider,
} from "../src/index.ts";

/** A synthetic observation provider. It measures explicit evidence, not learning or an official grade. */
export async function demoProvider(): Promise<EvaluationProvider> {
  return {
    release: { id: "demo.submitted-text", version: "1.0.0", digest: await digestJson({ implementation: "synthetic-submitted-text-observation-v1" }) },
    async evaluate({ evidence, texts }) {
      return evidence.map((item) => ({ criterionId: "submitted-work", observation: `${texts.get(item.id)!.length} text characters submitted`, explanation: "This observation measures the explicitly submitted text. A teacher reviews its educational quality.", evidenceIds: [item.id] }));
    },
  };
}
/** One public assessment definition for every district, with no local identities or answer key. */
export function demoDefinition(provider: EvaluationProvider): AssessmentDefinition {
  return AssessmentDefinition.parse({
    format: "educateos.assessment.v1", id: "explain-an-observation", version: "1.0.0",
    title: "Explain a scientific observation", intent: "Use evidence to support a claim and discuss uncertainty.",
    outcomes: [{ id: "explain", description: "Support a scientific explanation with observations", caseUri: "https://example.org/case/items/scientific-explanation" }],
    tasks: [{ id: "reflection", kind: "writing", prompt: "Describe an observation, explain your claim, and identify a limitation.",
      evidence: [{ id: "reflection-text", description: "A reflection you choose to submit", mediaTypes: ["text/plain"], maxBytes: 10000 }],
      aiAssistance: { allowedUses: ["feedback"], disclosureRequired: true } }],
    rubric: { id: "scientific-explanation", version: "1.0.0", digest: "sha256:" + "1".repeat(64) },
    evaluator: provider.release,
  });
}
/** Same imported manifest, separate host-verified sessions and artifact namespaces. No real student data. */
export async function demoDistrict(blueprint: AssessmentBlueprint, provider: EvaluationProvider, districtId: string) {
  const binding = await bindAssessmentBlueprint(blueprint, { districtId, instanceId: "science-demo" });
  const artifacts = new InMemoryArtifactStorage();
  const principal: AuthorizedPrincipal = { id: "synthetic-learner", districtId, kind: "student", channel: "human" };
  const bytes = new TextEncoder().encode(`Synthetic observation supplied in ${districtId}.`);
  const evidence = { id: "reflection", requirementId: "reflection-text", artifactId: "observation", revisionId: "1", digest: await digestBytes(bytes), mediaType: "text/plain" };
  await artifacts.put({ ...binding, subjectId: principal.id }, evidence, bytes);
  const runtime = await createAssessmentRuntime({
    definition: blueprint.definition, binding,
    ports: {
      // Demo-only verified session: a real server resolves this from its authenticated session and roster.
      authorize: async () => principal,
      artifacts, evaluators: { resolve: () => provider },
    },
  });
  const request = { taskId: "reflection", evidence: [evidence], assistanceUsed: [], idempotencyKey: "submission-1" };
  return { runtime, request, artifacts };
}
/** A reference manifest with deliberately synthetic rubric and .gadget digests; no executable archive. */
export async function demoBlueprint(provider: EvaluationProvider) {
  const release = await releaseAssessment(demoDefinition(provider));
  return importAssessmentBlueprint({
    format: "educateos.assessment-blueprint.v1", definition: release.definition, assessmentDigest: release.digest,
    gadget: { id: "reflection-gadget", version: "1.0.0", digest: "sha256:" + "2".repeat(64), file: "reflection.gadget" },
  });
}
