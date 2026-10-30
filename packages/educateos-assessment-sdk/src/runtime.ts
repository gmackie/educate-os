import { z } from "zod";
import { AssessmentReport, AssessmentTask, BoundInstance, Evidence, Finding, Id, ReleaseRef } from "./contracts.ts";
import { canonicalJson, digestBytes, digestJson, freezeJson, verifyAssessment } from "./canonical.ts";

/** Authenticated identity supplied only by a trusted server session adapter. */
export const AuthorizedPrincipal = z.strictObject({
  id: Id, districtId: Id, kind: z.enum(["student", "teacher"]), channel: z.enum(["human", "agent"]),
});
/** Host-authenticated principal; callers cannot pass this in evaluation/review requests. */
export type AuthorizedPrincipal = z.infer<typeof AuthorizedPrincipal>;
/** The full local scope an artifact port must enforce, including owner and instance. */
export interface ArtifactScope { districtId: string; instanceId: string; subjectId: string }
/** Private artifact storage. Reads must enforce scope, even for content-addressed backends. */
export interface ArtifactStorage {
  read(scope: ArtifactScope, evidence: Evidence): Promise<Uint8Array<ArrayBuffer>>;
}
/** A public evaluation provider returns suggestions only. Registration is trusted host work. */
export interface EvaluationProvider {
  readonly release: ReleaseRef;
  evaluate(input: { task: AssessmentTask; evidence: Evidence[]; texts: ReadonlyMap<string, string> }): Promise<Finding[]>;
}
/** A release resolver must return the exact pinned provider, never silently upgrade it. */
export interface EvaluatorRegistry { resolve(release: ReleaseRef): EvaluationProvider | Promise<EvaluationProvider> }
/** Optional approved sandbox port. Core does not execute programming/simulation code itself. */
export interface SandboxPort {
  evaluate(input: { task: AssessmentTask; evidence: Evidence[]; texts: ReadonlyMap<string, string>; evaluator: ReleaseRef }): Promise<Finding[]>;
}
/** Optional model seam; v1 does not invoke models or send evidence to external providers. */
export interface ModelPort { suggest(input: { purpose: "feedback"; text: string }): Promise<string> }
/** Optional immutable public manifest resolver, supplied by the host. */
export interface ManifestPort { resolve(digest: string): Promise<unknown> }
/** A review records a teacher decision, never an official grade. */
export const ReviewDecision = z.strictObject({ decision: z.enum(["accepted", "needs-revision"]), comment: z.string().max(2000) });
/** Optional host review persistence. EducateOS grade writes must use AssessmentService separately. */
export interface ReviewService {
  record(input: { report: AssessmentReport; reviewer: AuthorizedPrincipal; decision: z.infer<typeof ReviewDecision>; idempotencyKey: string }): Promise<void>;
}
/** Server-owned dependencies; never construct these from an HTTP request body or gadget input. */
export interface RuntimePorts {
  /** Must check assignment/instance access each time, including teacher access to the named learner. */
  authorize(action: "evaluate" | "review", scope: BoundInstance & { subjectId?: string }): Promise<AuthorizedPrincipal>;
  artifacts: ArtifactStorage;
  evaluators: EvaluatorRegistry;
  sandbox?: SandboxPort;
  model?: ModelPort;
  reviews?: ReviewService;
  manifests?: ManifestPort;
}
const evaluationRequest = z.strictObject({
  taskId: Id, evidence: z.array(Evidence).min(1).max(100), idempotencyKey: Id,
  assistanceUsed: z.array(z.enum(["brainstorm", "feedback", "revision", "translation"])).max(4),
});
const reviewRequest = z.strictObject({ reportId: Id, idempotencyKey: Id, ...ReviewDecision.shape });

/** In-process, bounded-lifetime suggestion runtime. Persist idempotency in a host for multi-process use. */
export async function createAssessmentRuntime(options: { definition: unknown; binding: unknown; ports: RuntimePorts }) {
  const binding = freezeJson(BoundInstance.parse(options.binding));
  const { definition } = await verifyAssessment(options.definition, binding.assessmentDigest);
  const ports = Object.freeze({ ...options.ports });
  const executions = new Map<string, { fingerprint: string; result: Promise<{ reportId: string; report: AssessmentReport }> }>();
  const reports = new Map<string, AssessmentReport>();
  const reviews = new Map<string, { fingerprint: string; result: Promise<void> }>();
  async function authorize(action: "evaluate" | "review", subjectId?: string) {
    const principal = AuthorizedPrincipal.parse(await ports.authorize(action, { ...binding, ...(subjectId ? { subjectId } : {}) }));
    if (principal.districtId !== binding.districtId) throw new Error("Access denied: district mismatch");
    if (action === "review" && (principal.kind !== "teacher" || principal.channel !== "human")) throw new Error("Direct teacher review required");
    return principal;
  }
  return Object.freeze({
    binding,
    definition,
    /** Evaluate only the authenticated learner's explicitly submitted work. Concurrent retries coalesce. */
    async evaluate(raw: unknown) {
      const request = evaluationRequest.parse(raw);
      const principal = await authorize("evaluate");
      const task = definition.tasks.find((t) => t.id === request.taskId);
      if (!task) throw new Error("Unknown task");
      if (request.assistanceUsed.some((use) => !task.aiAssistance.allowedUses.includes(use))) throw new Error("AI assistance exceeds task permission");
      if (new Set(request.evidence.map((e) => e.id)).size !== request.evidence.length) throw new Error("Duplicate evidence ID");
      // Evidence order is not part of a submission's meaning.
      request.evidence = request.evidence.toSorted((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      request.assistanceUsed = [...new Set(request.assistanceUsed)].toSorted();
      const { idempotencyKey: _key, ...submission } = request;
      const fingerprint = await digestJson({ binding, subjectId: principal.id, submission });
      const key = canonicalJson([principal.id, request.idempotencyKey]);
      const prior = executions.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Idempotency key already names different input");
        return structuredClone(await prior.result);
      }
      const result = (async () => {
        const scope = { districtId: binding.districtId, instanceId: binding.instanceId, subjectId: principal.id };
        const texts = new Map<string, string>();
        for (const requirement of task.evidence) {
          if (!request.evidence.some((e) => e.requirementId === requirement.id)) throw new Error("Missing required evidence");
        }
        for (const evidence of request.evidence) {
          const requirement = task.evidence.find((r) => r.id === evidence.requirementId);
          if (!requirement || !requirement.mediaTypes.includes(evidence.mediaType)) throw new Error("Evidence does not match requirement");
          const bytes = await ports.artifacts.read(scope, evidence);
          if (bytes.byteLength > requirement.maxBytes) throw new Error("Evidence exceeds size limit");
          if (await digestBytes(bytes) !== evidence.digest) throw new Error("Evidence digest mismatch");
          // V1 evaluates text only; media tasks can submit an explicit transcript/description.
          if (!evidence.mediaType.startsWith("text/")) throw new Error("Unsupported evidence media type: provide an explicit text transcript");
          texts.set(evidence.id, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        }
        const input = { task: freezeJson(structuredClone(task)), evidence: freezeJson(structuredClone(request.evidence)), texts };
        let findings: Finding[];
        if (task.kind === "programming" || task.kind === "simulation") {
          if (!ports.sandbox) throw new Error("Sandbox unavailable");
          findings = await ports.sandbox.evaluate({ ...input, evaluator: definition.evaluator });
        } else {
          const provider = await ports.evaluators.resolve(definition.evaluator);
          if (canonicalJson(ReleaseRef.parse(provider.release)) !== canonicalJson(definition.evaluator)) throw new Error("Evaluator release mismatch");
          findings = await provider.evaluate(input);
        }
        const report = AssessmentReport.parse({
          format: "educateos.assessment-report.v1", ...scope, assessmentDigest: binding.assessmentDigest,
          taskId: task.id, evidence: request.evidence, findings, authority: "suggestion",
          provenance: { evaluator: definition.evaluator, rubric: definition.rubric, inputDigest: fingerprint, assistanceUsed: request.assistanceUsed },
        });
        const reportId = `report:${(await digestJson(report)).slice(7)}`;
        reports.set(reportId, freezeJson(report));
        return { reportId, report };
      })();
      // Keep failures too: retrying a key cannot silently change a completed or failed execution.
      executions.set(key, { fingerprint, result });
      return structuredClone(await result);
    },
    /** Re-authorize each decision through the host; this method cannot write an official grade. */
    async review(raw: unknown) {
      const request = reviewRequest.parse(raw);
      // Authenticate before looking up a report, then authorize its exact learner scope.
      await authorize("review");
      const report = reports.get(request.reportId);
      if (!report) throw new Error("Report unavailable");
      const reviewer = await authorize("review", report.subjectId);
      if (!ports.reviews) throw new Error("Review service unavailable");
      const fingerprint = await digestJson(request);
      const key = canonicalJson([reviewer.id, request.idempotencyKey]);
      const prior = reviews.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Review idempotency conflict");
        return prior.result;
      }
      const result = ports.reviews.record({ report: structuredClone(report), reviewer, decision: ReviewDecision.parse({ decision: request.decision, comment: request.comment }), idempotencyKey: key });
      reviews.set(key, { fingerprint, result });
      await result;
    },
  });
}
/** A bound runtime capability; keep authorization dependencies on the host. */
export type AssessmentRuntime = Awaited<ReturnType<typeof createAssessmentRuntime>>;

/** Resolve a public manifest through an optional host port, always verifying its digest. */
export async function loadAssessmentRuntime(binding: unknown, ports: RuntimePorts) {
  const parsed = BoundInstance.parse(binding);
  if (!ports.manifests) throw new Error("Manifest service unavailable");
  return createAssessmentRuntime({ definition: await ports.manifests.resolve(parsed.assessmentDigest), binding: parsed, ports });
}

/** Synthetic/demo artifact store. Its host-only writer is never a student-facing upload authority. */
export class InMemoryArtifactStorage implements ArtifactStorage {
  #entries = new Map<string, { digest: string; mediaType: string; bytes: Uint8Array<ArrayBuffer> }>();
  #key(scope: ArtifactScope, evidence: Evidence) {
    return canonicalJson([scope.districtId, scope.instanceId, scope.subjectId, evidence.artifactId, evidence.revisionId]);
  }
  async put(scope: ArtifactScope, raw: unknown, bytes: Uint8Array<ArrayBuffer>) {
    const evidence = Evidence.parse(raw);
    const copy = bytes.slice();
    if (await digestBytes(copy) !== evidence.digest) throw new Error("Evidence digest mismatch");
    const key = this.#key(scope, evidence);
    const previous = this.#entries.get(key);
    if (previous && (previous.digest !== evidence.digest || previous.mediaType !== evidence.mediaType)) throw new Error("Artifact revision is immutable");
    this.#entries.set(key, { digest: evidence.digest, mediaType: evidence.mediaType, bytes: copy });
  }
  async read(scope: ArtifactScope, evidence: Evidence) {
    const entry = this.#entries.get(this.#key(scope, evidence));
    if (!entry || entry.digest !== evidence.digest || entry.mediaType !== evidence.mediaType) throw new Error("Evidence unavailable in this scope");
    return entry.bytes.slice();
  }
}
