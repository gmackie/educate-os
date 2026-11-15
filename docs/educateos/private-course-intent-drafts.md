# Teacher-owned AI curriculum drafts (draft implementation)

**Status:** Unmerged feature built on the teacher AI preview in [PR #38](https://github.com/gmackie/educate-os/pull/38). It is not a live lesson-upgrade or content-publishing system.

## Teacher workflow

1. Teacher chooses an imported, verified OCS course version and one unit.
2. Teacher deliberately asks for a model-proposed adaptation, using a fixed goal.
3. The district atomically records a pending request with a teacher/offering-scoped idempotency key **before** reserving budget or invoking a model. A retried request cannot run the model again with the same key.
4. The district's existing AI budget governor approves/denies the model, reserves funds, and settles a known usage record or unknown-attempt liability.
5. A successful response becomes an immutable revision of a **private** curriculum draft; no course module, assessment, assignment, grade, or external publisher changes.
6. Teacher Studio lists the teacher's own drafts. The teacher chooses learning goals and teaching strategies; selecting a subset records an authenticated local review revision. The teacher can also discard the current suggestion.
7. A later, separately reviewed authoring feature may turn selected planning notes into a new unpublished course edition. This PR deliberately has **no apply-to-class, student-visible publish, or outbound contribution action**.

The UI calls this "Save selected planning notes," not "Apply to course." A reviewed record reflects teacher approval of *planning metadata*, not subject accuracy, a licensing grant, or proven educational impact.

## Data and durability

A CourseIntentDraftRecord is pinned to the exact OCS package ID/version/digest and unit key. It includes its owning offering and principal, fixed adaptation goal, opaque draft ID, request key, lifecycle state and monotonically increasing revision.

Lifecycle: pending -> proposed or failed; proposed -> reviewed or discarded. Terminal states cannot become proposed again. A reviewed record includes precisely the selected goal and strategy IDs from the validated model proposal. A discarded record omits the suggestion from its latest view.

Every lifecycle change is an **append-only immutable revision**. The SQLite Durable Object has separate request and revision tables, unique (offering, owner, key) constraints and UPDATE/DELETE refusal triggers. In-memory stores use the same validation path. Previous revisions remain available to authorized district operators through the storage layer for audit/reconciliation.

**Important privacy/retention note:** "Discard" prevents reusing or viewing the suggestion through the current teacher view but does not yet erase historical audit revisions. Schools must define a documented data-retention/deletion policy, and that policy will require its own approved deletion mechanism; do not call this button "permanently delete."

## API

- POST /api/teacher/offerings/:offeringId/course-library/ai-intent (with optional requestKey) now creates a private draft and responds with draftId, revision, and status.
- GET /api/teacher/offerings/:offeringId/course-library/ai-intent/drafts lists the current teacher's latest private records.
- GET /api/teacher/offerings/:offeringId/course-library/ai-intent/drafts/:draftId retrieves one owned record.
- POST /api/teacher/offerings/:offeringId/course-library/ai-intent/drafts/:draftId/review saves selected goal/strategy IDs with an expectedRevision compare-and-swap, or discards the suggestion's current view.

Every route rechecks the existing offering-level teacher authoring authorization, and every stored read is constrained by owner principal and offering ID. Any stale approval, invalid selection, mismatched source ID or reused request key fails closed.

## Security, AI spend, and idempotency

- Neither model nor browser chooses teacher identity, course publisher trust, spending pools or credentials.
- The model receives only bounded course unit metadata, not student details, grades, test-bank content, or teacher-only notes.
- At-most-once model initiation per scoped request key is enforced by the durable claim, not a browser-only disabled button.
- If inference/provider settlement fails after reservation, use existing unknown-attempt accounting rather than pretending cost is zero. A failed or pending request is not automatically retried.
- A successful model suggestion does not certify anything. The originating exact OCS source remains immutable.
- The UI never renders model output as raw HTML, and the store rejects unknown fields and impossible state transitions.
- The district's existing Content Studio, Curriculum CI and future local-edition update/rights checks remain separate mandatory gates before any lesson changes.

## Test plan

Synthetic district tests: generated request persisted, identical retry no second inference, selection review, idempotent replay, stale revision refusal, invalid selection, student role denial, discard and failed provider.

Real workerd tests: SQLite survives restart, immutable append-only revisions, unique request claims, owner/offering scoping, corrupt-row failure, SQL update/delete refusal.

Further production gates: pending request recovery after an interrupted provider call, explicit institutional retention controls, backend request timeout policy, district-wide LLM prompt/data review, account invoice reconciliation and load testing. No live provider or non-EducateOS interop is claimed in this PR.

## Relationship to the real inference worker

The separate [Workers AI inference PR #39](https://github.com/gmackie/educate-os/pull/39) adds an opt-in service-only Worker. Both PR #39 and this PR depend on PR #38 but can be reviewed independently; they are not merged/deployed.

A verified publisher release remains in OCS 1.1. Teacher adaptation drafts remain inside the district's own account. Only later, after a separate human review and locally controlled publication step, would a school generate a new course edition or propose a change upstream.
