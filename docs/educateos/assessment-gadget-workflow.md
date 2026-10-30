# Gadget source checkpoint and teacher evidence workflow

SCHO-288, stacked after PR #18. This is a narrow, local harness-tested integration. It adds no
untrusted-code executor, grade automation, surveillance, deployment or conformance claim.

## Educators

1. Publish/install an activity with a signed district rubric and `interactive` among its permitted
   artifact types (the existing activity template's `additionalArtifactTypes` supports this).
2. Its Workshop Blueprint must contain a public `educateos.assessment.json` definition with a
   `gadget` or `programming` task accepting `text/vnd.educateos.gadget-source+json` evidence and an
   appropriate `maxBytes` (up to 262144 for the encoded envelope). The rubric reference must match
   the local signed release's ID, `N.0.0` version and signature digest. Keep all private grader
   configuration, answer keys and hidden tests in the district rubric, never the Blueprint.
3. In Teacher Studio's **Gadget assessment**, import the public assessment export and review its
   source before **Pin reviewed release to assignment**. The district now fetches the exact release
   from its configured Workshop service before saving anything. Arbitrary imported JSON, a digest
   or an asserted publisher identity cannot authenticate a release.
4. Teacher Studio shows **Release verified with the configured Workshop** only after a successful
   server verification during that read. Loading, retry and unavailable states use the existing
   controls. Missing, deleted, corrupt or unavailable releases block new submissions too.
5. Students use a private Gadget created from that exact reviewed Blueprint release, with their
   own connected school binding. They preview the committed source and explicitly approve
   **Submit current Gadget** in Workshop. Nothing reaches district artifact storage before approval.
6. The ordinary submission review displays the exact stored source envelope, revision and hash.
   Source provenance proves which bytes were captured, not independent human authorship. This
   export records AI assistance as **undisclosed**; explanations and AI-use declarations remain
   separate evidence through the existing artifact workflow. It copies no chat or model reasoning.
   Check required explanations/disclosures separately before grading. The ordinary teacher-only
   rubric, released-feedback and official-grade approval controls remain authoritative.

A new Blueprint release requires a new explicitly reviewed assignment pin. Existing assignments
never follow a moving release. Source checkpoints are evidence for review; they are not execution
results or proof that every assessment requirement is satisfied.

## Gadget developer API

Obtain the assignment-scoped capability from the real `SCHOOL` binding in the committed Gadget's
runtime. There is deliberately no caller-provided source blob, URL, student, role or target workspace.
The same live capability must be retained between preview and submit and disposed on page teardown:

```ts
const assessment = await env.SCHOOL.assessment(assignmentId);
const preview = JSON.parse(await assessment.previewCurrentGadget());
// Render preview.checkpoint.files as escaped text for the student to review, alongside the
// destination assignment, commit and fingerprint. Require a user click labelled "Submit current
// Gadget". On that click (not on page load or an agent schedule):
await assessment.submitCurrentGadget(preview.requestId);
// Workshop presents its explicit approval action; the call finishes after the decision.
// In the owning UI/runtime cleanup:
assessment[Symbol.dispose]();
```

This is the implemented RPC contract, not a provided generic Gadget UI component. Each assessment
Gadget must implement its own source-preview/user-click UI. The Workshop approval is a real,
non-auto-approvable action; its summary shows assignment, commit, hash and filenames and says it is
incomplete. Raw source is kept in the private durable action journal, not the action description or
server logs. A refreshed preview invalidates the earlier preview ID; concurrent/double clicks
cannot silently submit a different preview. Preview itself writes no district artifact. Rejection
never submits; account revocation or changed district permissions refuse application.

The previous `assessment.submit([{artifactId, revisionId}])` remains available for separate owned
explanations and other district evidence. It does not give caller-supplied bytes checkpoint provenance.

## Source and submission trust boundary

Workshop stamps the actual loaded Git commit into its internal Gadget caller. Its approval queue
reads that commit's complete Git tree only for the owner's configured EducateOS singleton, through
a non-pending direct binding. Other gatekeepers, foreign/borrowed bindings, agent/chat-preview/hook
contexts, shared workspaces, stale executable commits and missing Blueprint origins are refused.
It checks again after the asynchronous Git read/hash so a changed head, deletion or sharing cannot
race the export. No credential, environment, storage, binding, chat or unrelated Gadget tree is read.

`workshop.gadget-source.v1`, policy `educateos-source-v1`, includes workspace/Gadget identifiers,
commit, source SHA-256, exact upstream Blueprint commit and sorted path/text tuples. The source
hash covers UTF-8 `JSON.stringify(sortedFiles)`, including significant Unicode and line endings.
The complete tree is accepted or refused; no file is silently omitted:

- Requires `server.js`; at most 32 files and 128 KiB of serialized source tuples.
- Allows JS/JSX/TS/TSX/CSS/HTML and `educateos.assessment.json` only.
- Refuses sensitive/private/test/fixture/chat/binding filenames, traversal, binary content and
  recognizable embedded credentials. Refusals omit the offending path/content.

These conservative checks cannot recognize every secret or private fact written inside otherwise
valid code. Exact source review and explicit consent are required; do not put secrets into source.
The Gadget-rendered preview is not trusted browser chrome. The trusted Workshop approval warns
that it is a summary; a universal trusted source-preview viewer remains a follow-up. A Gadget whose
source cannot safely be reviewed/exported must use separate ordinary district evidence instead.

The Gatekeeper journals the preview under an opaque request ID. Only its configured district service
binding receives the connected account's verified principal. The district rereads active membership,
assignment, policy, signed rubric and the remote release on every apply, including delayed approval.
It verifies checkpoint digest, upstream pin, unchanged public manifest, accepted format and byte limit.
The destination is the verified student's own course workspace, derived from the installed assignment.
There is no new public HTTP source-import endpoint.

LearningArtifacts stores a content-addressed immutable revision with server-owned source provenance.
Only that provenance, copied into the SubmissionSnapshot, drives the teacher verification badge.
Student-authored lookalike JSON/MIME types and later edited revisions cannot acquire the badge. The ASCII-escaped JSON envelope
preserves original source code points despite the artifact service's text normalization; parsing it
recovers the exact path/text pairs. Its artifact digest covers the whole stored envelope, separately
from the source-tree digest. AssessmentService creates and pins the existing SubmissionSnapshot.
Host request keys make artifact creation and submission replay durable, even after a Worker restart
or a newer attempt. Changed request content and withdrawn submission replay are refused.

Artifact creation and submission remain separate existing service transactions. A preflight checks
submission policy, deadline and attempts before saving bytes; submission checks them again. A change
between these operations or an interruption after save can leave a course artifact without a
submission; retry reuses it. No automatic cleanup deletes evidence. Term/policy restrictions are
rechecked by both services. The export performs no grading and never executes downloaded code.

## Trusted reverse release verification and setup

See [district Worker setup](../../packages/educateos-district-worker/README.md#optional-workshop-assessment-release-binding)
for exact Cloudflare binding configuration, deployment sequence and offboarding.

The installer provides `WORKSHOP_ASSESSMENT_RELEASES`, targeting the configured Workshop backend's
`WorkshopAssessmentReleases` named entrypoint. Cloudflare's service-binding capability authenticates
access: it is not a public HTTP endpoint or caller-selected hostname. It exposes only exact published
Blueprint releases. Workshop validates the actual R2 Git pack and requested release commit using the
existing archive implementation. The SDK independently recomputes the returned source digest and
public assessment, compares them with the district pin, then the district verifies its signed rubric.
Only Blueprint ID and commit cross this reverse binding; no student records, source or credentials
are sent to the publisher. No callback, executable import or remote URL is taken from the manifest.

All published Blueprint IDs (including unlisted IDs) already have public-read semantics in Workshop.
This does not add private-Blueprint tenant ACLs or expose unpublished Gadget trees. Use only a
school-approved Workshop publisher; the binding authenticates the service, not an independently
certified human publisher. A wrong publisher with different bytes cannot satisfy a previously pinned
SHA-256. There is no fallback to teacher attestation, cached success or latest release on failure.

The optional binding is absent by default, so the feature fails closed until installed. Bootstrap the
district without it, deploy Gatekeeper/Workshop, then add it and regenerate Worker configs. This avoids
a cold-start circular service dependency without an unauthenticated HTTP alternative. No deployment
was performed for this PR.

## Validation boundary

Tests cover actual stored Git packs, exact-commit runtime source capture, source refusals, separate
real Gatekeeper approval/durable journal and district SQLite service paths, replay and revocation,
pin/hash/public-manifest corruption, unavailable verification, student/class/district denial, and
existing CI/teacher grading regression paths. The district's remote publisher test is synthetic;
Workshop's actual release service is exercised separately. There is no claim of one deployed
browser-to-Gadget-to-Gatekeeper-to-district end-to-end run. Exact commands, results and exceptions
are recorded in [checkpoint validation](assessment-checkpoint-validation.md).
