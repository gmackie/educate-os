# Per-student planner and guidance disposition (SCHO-433)

This is an explicit district-admin API for optional learning records. The authenticated person must
be an active district administrator of this district; teacher, school administrator, student and
guardian authority is insufficient. Authorization is decided and recorded by the existing policy
engine before inventory, retention changes or erasure. A guardian relationship does not grant
deletion authority. The API confers authority, not a legal obligation or a finding that FERPA
requires deletion. The district's records officer must determine the lawful scope first.

## Pilot procedure

Use the typed district API client with the district administrator's existing credential. Use synthetic
students for rehearsal. These routes are also available over HTTP with the same authentication:

| Typed route | HTTP |
| --- | --- |
| `admin.studentLearningPreview` | `GET /api/admin/students/:studentId/learning-records` |
| `admin.studentLearningDisposition` | `POST /api/admin/students/:studentId/learning-records/disposition` |
| `admin.purgeStudentLearning` | `POST /api/admin/students/:studentId/learning-records/purge` |

```ts
const params = { studentId }; // Exact district principal ID, not email or roster provider ID.
let preview = await client.call("admin.studentLearningPreview", { params });
// Only after records-officer review, and any required archive is verified:
const state = await client.call("admin.studentLearningDisposition", {
  params,
  body: {
    revision: preview.state.revision,
    legalHold: false,
    deletionAuthorized: true,
    archiveSatisfied: true, // Includes a reviewed determination that no archive is required.
    // retainUntil: "2027-07-01T00:00:00Z", // Optional retention deadline; blocks earlier erasure.
  },
});
preview = await client.call("admin.studentLearningPreview", { params });
// Stop if blockers is nonempty. Counts cover every class, including removed enrollments.
const receipt = await client.call("admin.purgeStudentLearning", {
  params, body: { revision: state.revision, confirmStudentId: studentId },
});
const after = await client.call("admin.studentLearningPreview", { params });
// Verify all after.counts are zero and after.state.receipt.id === receipt.id.
```

To place a hold, call `admin.studentLearningDisposition` with the current preview revision,
`legalHold: true`, and the district's other disposition fields. The same route explicitly releases
it with `legalHold: false`. A concurrent hold/disposition change invalidates an older purge revision.
A hold cannot be placed after completed erasure. A failed or timed-out purge may already have committed:
preview again, preserve its receipt, and retry the same purge. Retrying returns the original actor,
time, receipt ID and counts. It does not erase twice. Do not interpret an authorization audit entry
as proof of completed deletion: completion is the receipt plus the zero inventory.

## Scope and persistence

The purge deletes this student's complete planner rows: private goals, optional skill choices,
coaching event transcripts, challenges, shared evidence copies and provenance, review rationales and
history, and pinned per-plan opportunities. It deletes their guidance preferences, guardian topic
suggestions and reviews/responses, and optional practice invitations/responses. It revokes only
active **guardian learning-guidance grants**, retaining their access-change history. It does not
erase guardian identity relationships, invitations, identity links, or the student's principal.
Class standards agendas, catalog standards and other students' records remain unchanged.

Erasure, grant revocation, a content-free receipt and the terminal write fence commit in one SQLite
transaction in the district Durable Object. Stale updates, asynchronous coaching completions, fresh
plan creation, teacher invitations, new guardian suggestions, and grant re-enablement cannot recreate
records for a fenced student. Other students continue normally. Reconstructing stores or reinstalling
the application over retained storage preserves the fence. There is deliberately no re-enable route
in this pilot: starting this optional feature again needs a separately reviewed lifecycle design.
Existing plan operations return not-found after erasure; new optional-learning writes return conflict
with an instruction to return to the class page. Existing browser views may retain already fetched
text until reload; there is no push invalidation or automatic UI navigation in this API-only change.

Authorization uses the existing audit sink and fails closed if it cannot record its decision.
Completion appends `admin.student-learning.erased` to that same audit trail with actor, original
erasure time, subject, receipt ID and counts only. If the completion append fails after the transaction,
the atomic receipt remains: retry repairs the append. Repeated completion entries may share a receipt
ID and must be deduplicated by that ID when counting operations. No signed audit log is deleted or
rewritten. The retained receipt, tombstone and grant history are administrative records, not learning
content, and need the district's separate retention schedule.

## Retention and integration gaps

This scope has no automatic expiry policy or generic subject-deletion service to extend. Existing
`WorkspaceRetentionJob` erases closed-term workspace storage, which has a different subject/scope;
roster removal, principal deactivation, course uninstall and district offboarding do not substitute
for this purge. Disposition defaults to unreviewed, so deletion is denied until explicitly reviewed.
The district must carry institution-wide or workspace holds into this subject's disposition before
using it; this pilot has no centralized institutional legal-hold registry or automatic synchronization
with workspace legal holds. Do not attest deletion authorization until that review is complete.

This is **not whole-student erasure**: source artifacts, gradebooks, assessments, submissions,
workspaces, Workshop agents/private chats, home-learning records, exports already taken, provider
logs/AI Gateway retention, backups and platform recovery history are outside scope. Deleting a
planner evidence copy does not erase its source. Exports/offboarding currently do not establish a
complete planner/guidance archive; arrange and verify any required lawful archive before setting
`archiveSatisfied`. There is no admin UI, bulk deletion job, clinical/emotional profile or inference.

The SCHO-431 runtime integration and its remaining deployment-configuration retention are detailed below.
SCHO-432/SCHO-434 can drive the three typed routes above and assert hold denial, zero inventory,
receipt and subsequent write conflict. This branch has no merge or deployment authorization.

## Runtime AI consent and quota lifecycle (SCHO-431 / SCHO-433)

The deletion receipt now also **revokes effective planner AI permission**. The runtime reads that
same durable subject receipt before guard admission, immediately before every generative model
call, after the response and before output screening/release. A still-valid deployment grant cannot
override it. There is no re-enable route. The terminal fence survives Durable Object eviction,
application reconstruction and receipts written before this integration. An unreadable lifecycle
record fails closed. Revocation during an already dispatched call cannot unsend its prompt: the
response is withheld, and known usage or unknown liability must still settle normally.

Authorized purge atomically removes only `planner-ai-runtime` / `student:<principalId>` from the
same district's SQLite, alongside the learning records and receipt. Preview, receipt and completion
audit include `aiRuntimeCounters` (number of operational counter rows, not billed tokens or dollars).
Other students' counters and the content-free district circuit breaker remain. Retrying an older
receipt repairs a pre-integration leftover counter without changing the original receipt ID, actor,
time or inventory; old receipt counts read as zero for this newly added field. After upgrading an
already purged student, retry its authenticated purge to clear any leftover counter. AI is blocked
before that cleanup too.

**This does not delete deployment consent configuration.** `DISTRICT_CONFIG.plannerAi.grants`
is installer-owned Worker binding data, not a mutable district record. An admin API cannot edit it.
Remove the subject's grant from the deployment source and update the binding using the district's
approved configuration process; separately review retained source revisions/backups under the
consent evidence retention schedule. The durable receipt immediately overrides the old binding,
including after restart or an ordinary configuration update. Do not report a removed deployment
grant, full consent-record erasure, or whole-student erasure based on this API receipt. Restoring a
backup from before the purge or rolling back to code that does not enforce the receipt also requires
reapplying the disposition/revocation before enabling AI; those operations are outside this API.

Financial ledger entries, reservations, settlements, guard liability, district billing totals, consent
history and immutable audit records are **retained** under their separate mandatory schedules.
Quota erasure never resets money spent or releases an outstanding reservation. The existing legal
hold, retention deadline, deletion authorization and archive review gates still apply before purge;
this integration does not infer permission to erase financial or consent evidence. A revoked
explanation returns `consent-revoked` with a reviewed-lesson fallback when the plan still exists;
a purged plan itself continues to return not-found/conflict as above. No admin response exposes
goals, prompts, chats or model output.
