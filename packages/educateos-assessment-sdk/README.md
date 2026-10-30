# @educateos/assessment-sdk

Portable public assessment definitions and evidence-grounded **suggestions**, with a standalone
in-memory runtime. The default entry point depends only on Zod and standard Web APIs: no
Cloudflare, database, model provider, React, or EducateOS service is required. Node 24 is the
validated standalone target; modern browser hosts need Web Crypto and ES2023 array methods.

## Run the synthetic example

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @educateos/assessment-sdk quickstart
pnpm --filter @educateos/assessment-sdk test:run
pnpm --filter @educateos/assessment-sdk-react test:run
pnpm exec vp run -F @educateos/assessment-sdk -F @educateos/assessment-sdk-react build
```

`examples/quickstart.ts` defines one assessment, imports its public blueprint into two synthetic
district instances, submits district-local artifacts, verifies an idempotent retry, and asserts
that the other district's evidence is unavailable. It runs directly under Node, with no Worker,
credentials or real student data. Its observation evaluator counts submitted characters; it does
not assess educational quality. CASE URLs, rubric pins and `.gadget` pins in this example are
explicitly synthetic, not claims of published standards alignment or deployable gadget content.

## Author, release and run

```ts
import {
  AssessmentDefinition, releaseAssessment, createAssessmentRuntime,
} from '@educateos/assessment-sdk';

const definition = AssessmentDefinition.parse(untrustedPublicJson);
const { digest } = await releaseAssessment(definition);
const runtime = await createAssessmentRuntime({
  definition,
  binding: { districtId: 'district-a', instanceId: 'science-2026', assessmentDigest: digest },
  ports: {
    authorize: async (action, scope) => {
      // HOST CODE: verify the session and authorize this action for this instance/learner.
      // Never read role, district, channel or learner authority from the request body.
      return sessionService.authorizeAssessment(action, scope);
    },
    artifacts: artifactStorage,
    evaluators: approvedEvaluatorRegistry,
    reviews: optionalTeacherReviewStore,
  },
});
const { reportId, report } = await runtime.evaluate({
  taskId: 'reflection', evidence: [verifiedRevisionReference],
  assistanceUsed: [], idempotencyKey: 'attempt-1',
});
// Only a freshly authorized human teacher can record a review; this is NOT a grade write.
await runtime.review({ reportId, idempotencyKey: 'review-1', decision: 'accepted', comment: 'Checked the evidence.' });
```

See `examples/demo.ts` for complete runnable definitions, ports, evidence bytes and release pins.
The construction APIs and artifact writer are trusted host APIs, not HTTP endpoints. Giving an
untrusted caller the ability to construct an `authorize` callback defeats any authorization system.
The host must enforce instance membership and teacher-to-learner access on **every** callback;
the runtime additionally checks the district and direct-human teacher authority. The in-memory
artifact store keys by district, instance, learner, artifact and revision. A digest alone grants
no access. Do not expose its `put` method directly to a client.

## Public contracts and portability

- `AssessmentDefinition` has the `educateos.assessment.v1` discriminator, exact semantic version,
  outcomes with optional HTTPS CASE item URI references, immutable rubric/evaluator pins and tasks.
- `AssessmentTask` is a strict discriminated union: quiz, writing, gadget, programming, simulation,
  conversation, multimedia and portfolio. The kind describes intent, not installed functionality.
- Tasks specify explicit evidence requirements, accepted media types, byte ceilings and permitted
  learner AI uses. Requests explicitly disclose assistance used; disallowed uses fail and declared
  uses appear in report provenance. This is a declaration, not surveillance or an AI detector.
- `Evidence`, `Finding`, and `ReleaseRef` are strict subordinate v1 schemas. `AssessmentReport` has
  its own `educateos.assessment-report.v1` discriminator, exact evidence/release pins, input digest,
  learner/district/instance scope and only `authority: 'suggestion'`. Findings must name submitted
  evidence. Scores, when present, are suggestions in `[0, 1]`, never official grades.
- Parse untrusted JSON at every boundary. Unknown fields are rejected recursively, including
  student records, credentials, hidden tests, answer keys and evaluator configuration in public
  manifests. Arbitrary extension bags and executable URLs are deliberately absent. Text fields
  remain author-controlled prose: schema validation cannot detect a secret pasted into prose;
  authors must review public text before sharing. Always render prose as text, not trusted HTML.

`canonicalJson` sorts object keys by UTF-16 ordering, preserves array order and exact strings,
uses JSON number representation, and rejects non-finite numbers, non-JSON objects, holes and
cycles. It is a documented SDK v1 format, **not a claim of RFC 8785 conformance**. SHA-256 covers
UTF-8 bytes. There is no implicit text or Unicode normalization; evidence hashes exact stored
bytes. No locale-dependent sorting, clock, host URL or district data enters an assessment digest.
Release snapshots are recursively frozen. A digest is integrity, not publisher authentication:
hosts must approve and verify code/rubric artifacts and trust their publishers independently.

## Reuse existing EducateOS evaluators

The optional `@educateos/assessment-sdk/assessment-ci` entry point adapts the existing pure
`defineEvaluator` contract rather than replacing it:

```ts
import { adaptEvaluator } from '@educateos/assessment-sdk/assessment-ci';
import { writingStructure } from '@educateos/assessment-ci';
const provider = await adaptEvaluator({
  evaluator: writingStructure,
  implementationDigest: hostVerifiedCodeDigest,
  criterionId: 'organization',
  config: { minWords: 80, maxWords: 800, requiredSections: ['Conclusion'] },
  maxSteps: 10000,
});
// Pin provider.release in the public definition. Keep config ONLY in the host registry.
```

The provider pin includes the verified implementation digest, private parsed config, criterion,
accepted inputs and step budget. Exact-byte evidence hashes and returned excerpt bounds are
verified; legacy artifact IDs are mapped back to portable evidence IDs. The existing synchronous
determinism guard and cooperative step meter are reused. Only trusted evaluators may run here:
these mechanisms are **not a sandbox** and cannot stop malicious infinite loops or captured APIs.
Answer-keyed evaluators are refused in this student-readable path; existing teacher-only CI
reports remain the place for hidden-answer checks. Core `EvaluationProvider` is also the seam
for other approved evaluation providers; v1 never downloads executable code from a manifest.

## Read existing EducateOS records

```ts
import { createEducateOsReader } from '@educateos/assessment-sdk/educateos';
const reader = createEducateOsReader({
  assessment, ci,
  caller: () => authenticatedServerSession.caller,
});
const submission = await reader.submission({ submissionId });
const bytes = await reader.evidence({ submissionId, artifactId });
const nativeReport = await reader.report({ submissionId, runId });
```

This minimal read-only bridge calls the real `AssessmentService` and `AssessmentCi`. It preserves
native Artifact refs, immutable submitted revisions, policy checks, teacher/student report
projection and released-feedback rules. The actual services recheck authorization on each read.
It does not create assignments, run CI, propose grades or write official grades. Use the existing
AssessmentService teacher approval workflow for those actions; SDK review decisions do not bypass
it. Adapters use optional EducateOS peer packages, currently workspace packages: only the default
SDK entry point and optional React views are standalone published-artifact candidates.

## Gadgets and public blueprints

`AssessmentBlueprint` binds the public definition and verified assessment digest to an exact
`.gadget` release pin. `importAssessmentBlueprint` and `exportAssessmentBlueprint` validate the
public envelope; unknown archive bytes, student records, local bindings, secrets and hidden tests
are refused. This exchange envelope is separate from Workshop's existing `blueprint.json` and
`.gadget` archive formats. It never fetches, unpacks or executes a gadget. An installer must verify
the actual `.gadget` bytes against the pin, review its code and capabilities, and use the existing
Workshop import mechanism. A hash does not prove an archive contains no secrets.

`bindAssessmentBlueprint` creates a district-local binding without minting access.
`createGadgetAssessment(runtime)` exposes only `submit(request)`; district, learner, release and
review authority remain host-bound. For real Gadgets this capability must be exposed through the
existing EducateOS Gatekeeper's authenticated session and observation/action approval paths.
This portable in-process adapter alone grants no Gatekeeper RPC or ambient resource. The
two-district example demonstrates data isolation in memory, not a real district deployment.

### Immutable Workshop releases

The next-milestone bridge uses real Workshop release packs. Put only a public
`AssessmentDefinition` in the Gadget source file `educateos.assessment.json`, then publish the
Gadget as a Blueprint normally. The file survives `.gadget` export/import, following and updates
because it is an ordinary file in the release tree. Keep private rubric configuration, answer
keys, hidden tests, credentials and student records out of every published source file. The SDK's
strict public definition rejects extra fields; it cannot discover private information written
into arbitrary source code or prose.

On the trusted host, use the configured Workshop's real `PublicApi`:

```ts
const metadata = await workshop.getBlueprint(blueprintId);
if (!metadata?.metadata.commitId) throw new Error("Publish a commit-backed release first");
const source = await workshop.getBlueprintRelease(blueprintId, metadata.metadata.commitId);
const assessment = await pinWorkshopAssessmentBlueprint(blueprintId, source);
const publicExport = await exportWorkshopAssessmentBlueprint(assessment);
```

`getBlueprintRelease` reads the exact R2 key and validates the Git pack and commit, without
following a moving version. The SDK independently checks the SHA-256 of the sorted path/text
tuples and pins the public definition, rubric and evaluator references. Historical pins survive
later publication; deleting the Blueprint can make its source unavailable and causes a closed
failure. Legacy snapshot archives still import through Workshop, but must be republished as a
commit-backed release before this API can pin them.

`WorkshopAssessmentBlueprint` is a public-only envelope with the Blueprint ID, immutable commit,
source digest and assessment digest. It contains no local assignment, student evidence, Gadget
storage or connected capability. `importWorkshopAssessmentBlueprint` verifies the definition
digest, but does **not** authenticate a publisher or prove the claimed commit exists: obtain the
source over the configured Workshop API, or have the teacher explicitly review the imported
archive. An ID is local to that Workshop's namespace. Never accept a student's asserted envelope
as a verified source. Assignment installation records the teacher's reviewed pin; following or
updating the Gadget must not silently replace it or expand its permissions.

Hosts that have an installer-controlled Workshop capability can call
`verifyWorkshopAssessmentBlueprint(pin, releases)`, where `releases.getBlueprintRelease(id,
commitId)` calls the trusted Workshop release API. This independently recomputes the returned source
SHA-256 and public assessment digest, and requires both to match the exact reviewed commit and pin.
It refuses an absent/unavailable service, changed bytes, a substituted commit or manifest. Construct
this port from trusted deployment configuration, never a client URL or caller-asserted publisher.
The EducateOS district Worker implements this with the named `WorkshopAssessmentReleases` service
binding; see its [setup and trust model](../educateos-district-worker/README.md#optional-workshop-assessment-release-binding).
The source API verifies the real Git pack; this portable helper verifies its result and does not
claim to parse Git packs itself. Only a Blueprint ID and commit leave the district for verification.

## Teacher views and standards seams

`@educateos/assessment-sdk-react` provides IntentCard, EvidenceViewer, RubricReview,
AssessmentPreview and VersionDiff with semantic React markup and tests. It renders already
validated/authorized data; it neither fetches private evidence nor issues grade writes. Findings
show observations and evidence, not purported private AI reasoning. It has no theme dependency.
These components are ready to embed, but are not wired into the existing teacher application.

CASE URIs are carried unchanged for host standards lookup; no CASE server or cached standards
catalog is required. QTI and LTI are **documented seams, not implemented conformance**:

- A QTI importer can map supported public prompts/outcomes to tasks and artifact evidence. Keep
  response processing, answer keys and hidden fixtures in a private host evaluator registry. The
  existing quizzes service owns quiz attempts, answer keys and score releases. Do not serialize
  its teacher `QuizItem` into a public definition.
- An LTI launch adapter must verify the platform launch and bind its district/instance/principal
  through the host `authorize` port. Never trust a role claim in an SDK submission. Route grade
  passback through EducateOS's existing teacher-approved workflow, not `report.score`.
- OCS/resource packaging can include the public blueprint as a reviewed public resource; no OCS
  schema, resolver, signing format or existing assessment record is migrated by this change.

## Packaging, migration and limits

```sh
pnpm --filter @educateos/assessment-sdk build:dist
pnpm --filter @educateos/assessment-sdk pack --pack-destination /tmp
# In a separate Node project, install the resulting .tgz with pnpm.
```

The package emits ESM JavaScript and declarations; tarballs use `dist` exports. Zod is its only
required runtime dependency. No registry publication is performed by this change. The optional
EducateOS adapters require the matching existing packages; importing core does not load them.

Existing assessment/CI/AI/quizzes/artifacts/OCS contracts and digests remain unchanged. Adopt the
SDK at public import/export boundaries and use the adapters for existing services. A new schema
format/version is required for incompatible wire changes. Existing rubric pins can be referenced,
but the SDK does not verify rubric contents or reproduce existing signing/grade logic.

MVP limits: text evidence only (multimedia/conversation tasks may explicitly submit a transcript);
no media transcription, timed quiz runner, proctoring, surveillance, private chat capture, or
programming executor. Programming/simulation fail closed without a supplied approved sandbox.
`ModelPort` is a reserved optional seam, never invoked automatically; production AI should use
existing `assessment-ai` governance rather than send evidence directly to an arbitrary model.
The optional manifest port always verifies the loaded definition's digest.

Runtime state and failed/successful idempotency results last only as long as the process/instance.
Concurrent retries coalesce and conflicting keys fail; different keys for identical submissions
produce the same report. Durable queues, retention, cancellation, rate limits, authenticated
publisher registries, isolated execution and multi-process transactional review persistence are
host responsibilities and next implementation priorities. Review persistence should enforce its
own idempotency. This is a tested SDK MVP, not a production sandbox or district deployment.

## Connected EducateOS milestone

The existing Teacher Studio now imports and pins reviewed Workshop assessment releases and shows
submitted revision evidence, evaluator findings, provenance and existing teacher approval controls
through the live district API. The `SCHOOL.assessment(assignmentId)` Gatekeeper capability queues
owned district artifact revisions or a trusted current-Gadget source checkpoint for submission
through AssessmentService, following preview and explicit approval. The district independently
verifies its pin through an installer-configured Workshop release service binding. See
[the educator/developer/admin workflow](../../docs/educateos/assessment-gadget-workflow.md) for
the exact rubric mapping, setup, security boundaries and remaining integration gaps. The portable
React components above remain optional; Teacher Studio uses its established Kumo components.
