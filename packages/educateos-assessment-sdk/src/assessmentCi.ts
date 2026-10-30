import { z } from "zod";
import { ArtifactId, ArtifactType, ContentDigest, RevisionId } from "@educateos/contracts";
import { CriterionId } from "@educateos/assessment";
import {
  CriterionEvidence,
  deepFreeze,
  runDeterministically,
  StepBudgetExceeded,
  StepMeter,
  type EvaluationArtifact,
  type Evaluator,
} from "@educateos/assessment-ci";
import { MediaType, sha256Digest } from "@educateos/learning-artifacts";
import { digestJson } from "./canonical.ts";
import { Digest, Evidence, ReleaseRef } from "./contracts.ts";
import type { EvaluationProvider } from "./runtime.ts";

/** Trusted host configuration; neither the evaluator nor its private config enters an assessment export. */
export interface AdaptEvaluatorOptions {
  evaluator: Evaluator;
  /** SHA-256 of the implementation artifact the host has independently verified and approved. */
  implementationDigest: string;
  criterionId: string;
  config: unknown;
  artifactType?: ArtifactType;
  maxSteps?: number;
  /** If supplied, refuses a changed implementation, config, criterion or execution budget. */
  expectedRelease?: ReleaseRef;
}

/**
 * Adapts an existing pure Assessment CI evaluator to the portable runtime. The release commits to
 * the host-verified implementation digest, parsed config and execution profile. No executable code
 * is downloaded or inferred from a manifest. Only trusted synchronous evaluators belong here:
 * the determinism guard and cooperative step meter are NOT a sandbox for untrusted code.
 *
 * Answer-keyed evaluators are refused because portable reports are student-readable suggestions.
 * Those evaluators must stay behind Assessment CI's existing teacher-only report projection.
 */
export async function adaptEvaluator(options: AdaptEvaluatorOptions): Promise<EvaluationProvider> {
  const { evaluator } = options;
  if (evaluator.answerKeyed) throw new Error("Answer-keyed evaluators require the teacher-only Assessment CI service.");
  const implementationDigest = Digest.parse(options.implementationDigest);
  const criterionId = CriterionId.parse(options.criterionId);
  const artifactType = ArtifactType.parse(options.artifactType ?? "document");
  const maxSteps = z.int().positive().max(1_000_000).parse(options.maxSteps ?? 10_000);
  if (!evaluator.accepts.artifactTypes.includes(artifactType)) throw new Error("Evaluator does not accept this artifact type.");
  // Snapshot the definition and config before the first await: callers cannot swap them after pinning.
  const evaluate = evaluator.evaluate.bind(evaluator);
  const mediaTypes = [...evaluator.accepts.mediaTypes];
  const config = deepFreeze(structuredClone(evaluator.config.parse(options.config)));
  const id = evaluator.id;
  const version = evaluator.release;
  const expected = options.expectedRelease === undefined ? undefined : ReleaseRef.parse(options.expectedRelease);
  const digest = await digestJson({
    format: "educateos.evaluator-binding.v1",
    implementationDigest,
    evaluator: { id, version },
    criterionId,
    config,
    artifactType,
    mediaTypes,
    maxSteps,
  });
  const release = Object.freeze(ReleaseRef.parse({ id, version, digest }));
  if (expected !== undefined) {
    if (expected.id !== id || expected.version !== version || expected.digest !== digest) {
      throw new Error("Evaluator binding does not match the pinned release.");
    }
  }

  return Object.freeze({
    release,
    async evaluate(input: Parameters<EvaluationProvider["evaluate"]>[0]) {
      const evidence = z.array(Evidence).min(1).max(100).parse(input.evidence)
        .toSorted((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length) throw new Error("Duplicate evidence ID.");
      const artifacts: EvaluationArtifact[] = [];
      // Legacy branded IDs are adapter-local references, never district or student identifiers.
      const sources = new Map<string, { evidenceId: string; revision: string; length: number }>();
      for (const [index, entry] of evidence.entries()) {
        const mediaType = MediaType.parse(entry.mediaType);
        if (!mediaTypes.includes(mediaType)) throw new Error("Evaluator does not accept this evidence media type.");
        const text = input.texts.get(entry.id);
        if (text === undefined) throw new Error("Evidence text is unavailable.");
        if (await sha256Digest(new TextEncoder().encode(text)) !== entry.digest) throw new Error("Evidence digest mismatch.");
        const artifactId = ArtifactId.parse(`art_sdk-${index}`);
        const revisionId = RevisionId.parse(`rev_sdk-${index}`);
        sources.set(artifactId, { evidenceId: entry.id, revision: revisionId, length: text.length });
        artifacts.push({ artifactId, revisionId, digest: ContentDigest.parse(entry.digest), artifactType, mediaType, text });
      }
      const kit = new StepMeter(maxSteps);
      const guarded = runDeterministically(() => evaluate(deepFreeze({ criterionId, artifacts }), config, kit));
      if (guarded.violated) throw guarded.error;
      if (kit.exceeded) throw new StepBudgetExceeded(maxSteps);
      const results = z.array(CriterionEvidence).max(100).parse(guarded.result);
      return results.map((result) => {
        if (result.criterionId !== criterionId) throw new Error("Evaluator returned evidence for another criterion.");
        const evidenceIds = result.excerpts.map((excerpt) => {
          const source = sources.get(excerpt.artifact);
          if (source === undefined || source.revision !== excerpt.revision || excerpt.range.end > source.length) {
            throw new Error("Evaluator excerpt is outside the supplied evidence.");
          }
          return source.evidenceId;
        });
        return {
          criterionId,
          observation: result.observation,
          explanation: result.explanation,
          // Aggregate checks, such as word counts, are grounded in the entire supplied input.
          evidenceIds: [...new Set(evidenceIds.length > 0 ? evidenceIds : evidence.map((entry) => entry.id))],
          ...(result.score === undefined ? {} : { score: result.score }),
        };
      });
    },
  });
}
