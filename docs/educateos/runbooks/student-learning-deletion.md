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

SCHO-431 integration must also revoke/delete **only active subject AI consent grants**, preserving
required consent/audit evidence and unrelated students' grants. Its dated consent/rate tables are
not present on this base and are intentionally not modified here. Reuse the exported
`StudentLearningLifecycle` / `StudentLearningPersistence` transaction contract and include consent
revocation in the same transaction where possible; keep rate/accounting history under its own policy.
SCHO-432/SCHO-434 can drive the three typed routes above and assert hold denial, zero inventory,
receipt and subsequent write conflict. This branch has no merge or deployment authorization.
