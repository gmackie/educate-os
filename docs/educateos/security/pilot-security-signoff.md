# Pilot security signoff: Personalized Learning Planner (WIP, synthetic only)

Status: **review candidate, not a signoff.** Stacked on PR #417 (`feat/SCHO-434-plp-lifecycle-recipes-integration`,
head `fb262fbd232e2707e407b395c4176340d79d32f1`). No real student data, merge or deployment was used. This
document separates what an executable test proves from what only a district or operator can decide.

## Finding fixed on this branch

**A guardian's queued suggestion outlived the guardian's standing.** A suggestion is posted under a verified
relationship and an administrator's `suggest` grant, but approval and student visibility never re-checked
either. After a suspension, revocation, or removed grant, a teacher could still approve a queued suggestion
and a child could still see an approved one labelled "From your family: <name>".

Repair (`packages/educateos-district-app/src/guidance-routes.ts`, `guidance.ts`):

- Standing is read afresh through the same relationship source the policy engine uses (relationship in force,
  both principals active, grant on that exact relationship names `suggest`, class covered), **and** the grant
  has never dropped `suggest` since the suggestion was posted. New suggestions record the grant revision they
  were posted under, so a later new grant does not revive them.
- A suggestion with no recorded grant revision (a record from before this change) is never assumed to belong
  to a later grant: any grant change at or after its creation that dropped `suggest` withholds it, and a
  timestamp tie fails closed.
- Without standing: a waiting suggestion is not listed to the teacher and cannot be approved (`404`); an
  approved one is withheld from the student and cannot be answered (`404`).
- Nothing is deleted or rewritten. The record, the teacher's decision and the student's own choice remain.
  After **suspend then resume** (same grant) the same records return. After a **revoked or reduced grant, a new
  grant** lets the guardian post again but does not bring back earlier suggestions. A revoked relationship is final.
- A teacher's own invitation (practice invitation, planner invitation) is a separate record with the teacher as
  origin and is unaffected.
- The open-suggestion cap (3) now counts only suggestions that are actionable now, so records a family can no
  longer use do not lock it out after a re-grant. A retained-records bound (9 unexpired open records per
  guardian, child and class, including withheld ones) keeps revoke/re-grant cycles from piling up records.
  There is no time-based rate limit beyond that bound and the 30/90-day expiries.

Semantics a reviewer should confirm: the teacher's guidance page **still lists** a suggestion the teacher
already approved after standing lapses (as that teacher's decision history), while the student no longer sees it.

## Tested controls

Executable, over the invented Pilot Lakes district, real routes and stores:
`packages/educateos-harness/__tests__/pilot-guardian-standing.test.ts` (5 tests, new) and the existing
`pilot-adversarial`, `pilot-release`, `pilot-journeys` suites, plus district-app `guidance`, `guardians`,
`student-learning-lifecycle`, `learning-recipes`, `planner*` suites.

| Risk | Control | Evidence |
| --- | --- | --- |
| Forged / stale parent relationship | Relationship in force + explicit per-relationship grant, re-read on every decision, incl. queued items | new tests; `guidance.test.ts` |
| Guardian sees or steers after standing ends | Suspension, revocation, grant removal withhold queued and approved suggestions | new tests (before/after) |
| Teacher-owned vs guardian-origin content | Practice invitations unaffected by guardian standing | new test |
| District isolation | Foreign district's admin and token reach nothing here | new test, `pilot-adversarial` |
| Private goal leakage | No guidance view echoes a student's private goal | new test, `learning-recipes` |
| Role authorization on purge | Teacher, student, guardian, other-district admin refused | `student-learning-lifecycle` |
| Default-off AI, K-5 | No model call without district enablement; grade 5 refused | `pilot-adversarial` |
| Stale / withdrawn standards and recipes | Pinned release digest; withdrawn retire offers | `learning-recipes`, `pilot-adversarial` |

## Not tested here (observed by reading code, no test added)

- The planner AI adapter validates model output against a strict schema and the guard screens it, but the
  application does not itself reject links, email addresses or phone numbers in model-written explanation
  text (teacher-approved recipe text does). Reliance is on the guard's screening. Worth a decision before any
  AI enablement; not changed here.
- Financial-ledger retention across purge is covered by the existing lifecycle documentation and tests, not
  re-tested here.

## Operational gates not satisfied by any code on this branch

- Legal/DPA review and the district's FERPA determination; COPPA position for under-13 learners (grade 6 is
  typically 11-12) and verifiable authorization. The AI consent grants live in installer-owned deployment
  configuration, not in a district record.
- Records-officer review before any purge, legal-hold synchronization with workspace holds, archive and
  retention schedules for receipts, audit and the ledger.
- Real guardian identity verification procedure (who confirms a relationship, custody review process).
- Actual installation, accessibility review, incident response and a measured evaluation.
- Parallel work on teacher rubric UI and `planner-evidence.ts` is not covered here.
