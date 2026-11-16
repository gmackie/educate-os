# Guidance and Evidence (stacked on the Personalized Learning Planner, SCHO-420)

Teachers set standards priorities and see **real coverage** from evidence students chose to share.
Guardians can send **suggestions**, only where a district administrator has opted that relationship in.
Students see who every invitation came from and can say yes or no. Optional teamwork, planning and
communication practice is available, with fixed wording and no scoring.

**Status: WIP, not deployed.** No merge or production deployment is part of this change. It does not
touch the adaptive coaching engine, `planner.ts`, official grades or assignments.

## The one rule: a suggestion is never an assignment

Every invitation a student sees has `kind: "suggestion"`, `isAssignment: false`, `required: false`
as literal types in `guidance.ts`, so a handler cannot return anything else. The UI repeats it in
words on every card. Nothing here creates an assignment, due date, grade or required task. Making
something required stays with the existing **Create activity** flow, which only a teacher can use.

## Who can do what

| Capability | Teacher (this class) | Student (own) | Guardian (verified, opted in) | District admin |
|---|---|---|---|---|
| Set standards priorities, pacing, discussion prompt | yes | no | no | no |
| See coverage dashboard | yes | no | no | no |
| Drill into **shared** student evidence | yes | own only (planner) | no | no |
| Send a suggestion | no (uses planner invitations) | no | **only with the `suggest` grant** | no |
| Review (share / decline) a guardian suggestion | yes | no | no | no |
| Accept or decline an invitation | no | yes | no | no |
| See a child's progress label | no | n/a | **only with the `progress` grant**, own child, teacher-chosen standards | no |
| Switch the guardian grant on or off | no | no | no | yes |
| Switch family suggestions off | no | yes | no | no |

Every route runs through the district's identity resolution, the surface check (student, teacher,
guardian or admin kinds only) and the audited policy engine. Wrong class, wrong child, wrong district,
suspended relationship, and a teacher of a different class all fail closed. Tests cover each.

## The guardian opt-in (ADR-0012 stays read-only)

ADR-0012 makes a guardian relationship read-only and limited to `GUARDIAN_READABLE_KINDS`. This change
**does not widen that.** `GUARDIAN_READABLE_KINDS` is unchanged, and so is the relationship record.
New relationships default `readableKinds` to every readable kind, so adding a kind there would have
silently granted it to every new relationship; that is why this is not done.

Instead there are three small, separate pieces in `@educateos/policy` (`guardian-guidance.ts`):

1. A new resource kind, `learning-guidance`, which is **not** a guardian-readable kind.
2. A `GuardianGuidanceGrant`, one record per relationship, created only by a district administrator
   (`admin.setGuardianGuidance`). Capabilities are `suggest` and `progress`. It has a revision, and its
   full history (enabled / changed / revoked, who, when) survives revocation. **No record means off.**
3. A relationship source that answers **only** for `learning-guidance`. It emits the `guardian-of` fact only
   while: the relationship is in force (confirmed, in dates, not suspended, consent not withdrawn); both
   people are active principals; a grant on that exact relationship names the capability the action needs
   (create → `suggest`; read/list → `progress`); the resource is the child's own guidance in a class they
   attend; the relationship's `offeringIds` (if any) include the class; and the guardian can see the class
   at all (`offering` is in `readableKinds`).

One new rule, `guardian.child.learning-guidance`, allows create/read/list on that kind for a guardian with
that fact. It sits before `guard.guardian.child-records-only`, which still denies everything else.
Every decision is audited with the relationship ID. Tests assert: off by default, off for relationships
created later, the relationship record and `readableKinds` are untouched, other actions and other kinds
stay denied, and a grant is void while the relationship is suspended, revoked, expired or without consent.

## Parent suggestions, end to end

1. The admin turns on `suggest` for one relationship.
2. The guardian sends a topic (plain text, no links, emails or phone numbers; at most 3 open per child per
   class). If the student has switched family suggestions off, the guardian gets a neutral
   "can't be sent right now", which does not reveal why.
3. It waits for the class teacher (30 days, then it expires and is never shown). The teacher shares it or declines it.
4. A shared suggestion appears to the student labelled **Family suggestion · From your family: <name>**.
5. The student accepts or declines. **A decline is private**: the teacher and guardian are not told.
   The teacher sees only that the student accepted. The guardian never sees the student's choice.
6. A suggestion is never converted to an assignment by this feature.

## Teacher coverage, with opportunities and mastery kept apart

For each standard (teacher priorities, plus any standard with shared evidence) the dashboard shows two
separate counters. They are separate fields in the schema, so neither can be derived from the other:

- **Opportunities**: offered, accepted, skipped, shared, reviewed.
- **Evidence by student** (always sums to the roster): needs evidence, encountered, practiced,
  independent and teacher-reviewed.

Evidence states, from the teacher's **latest** review of the student's shared work:
`needs-evidence` (no shared work) → `encountered` (shared, unreviewed or review level encountered) →
`practiced` → `independent-reviewed`. The last needs the review to be a recommendation made on
independently assessed work, with unassisted help disclosed by both the student and the teacher; a later
hold lowers it. Offering, accepting, skipping, and AI-assisted work never raise it.

Coverage is computed from the planner's **teacher view**, so a student's private goal, private skills and
unshared opportunities cannot enter a count. The drill-down returns only teacher invitations and responses
the student explicitly shared, with the teacher's reviews and the evidence criteria. It never reads chats,
personal workspaces or other classes.

### Standards states are explicit

Each row says what the district's approved registry says now: `approved`, `hidden`, `not-approved` (the
framework was withdrawn), or `unmapped` (the saved standard is not in the approved release). Rows also carry
publisher, release version and provenance (`official`, `derived`, `district-authored`). Priorities can be
chosen only from `learningGoalsFor` the class's course, which uses the district-approved Common Core or state
releases. A row's **evidence pathway** is `planner` only for the standards the planner can collect today
(6.RP.A.3, W.6.1; a test keeps this in step with the planner) and `none` otherwise, so a prioritised standard
with no pathway is shown as such, not as an empty success.

## Optional social-emotional practice (CASEL)

The catalog is three fixed practices: teamwork, planning, communication. Wording lives in
`PRACTICE_CATALOG`, not per student, with an optional short teacher note. The area label ("Relationship
skills", "Self-management") orients the teacher; it is not a standards alignment, an assessment, or a claim
about a student. There is no score, sentiment, emotion analysis, questionnaire, free-text reply, inferred
trait, hidden targeting or therapy-like behaviour, and the student view is tested for the absence of such
fields. The student can accept or decline; a decline is private.

## Data, audit and retention

- Records live in the district's own Durable Object SQLite (`educateos_guidance`,
  `educateos_guardian_guidance`) with revision checks and atomic writes; an in-memory store is for tests.
- Policy decisions are audited by the existing engine under the relationship ID. Teacher reviews and grant
  changes carry actor and time in the record.
- Retention fit: suggestions carry an expiry (30 days waiting, 90 days visible) and expired ones are never
  shown. Records are per district and per class, like the planner's. They are **not yet** in the district
  export or the student archive, and there is no scheduled purge; both are listed below.

## Surfaces and routes

Teacher: class **Guidance** tab. Student: **Suggestions for you** on the class page. Family:
`/family/children/<id>/guidance`, linked from the child's page; it says plainly "Not turned on for your
family" where there is no grant, and offers nothing. Admin: **Learning guidance (optional)** on the
student's guardian page. Routes: `GUIDANCE_ROUTES` in `routes.ts` (13 routes, all in the typed table).

## Synthetic sample

`GUIDANCE_DASHBOARD_SAMPLE` is a readable, clearly fake dashboard (four standards covering every state, a
family suggestion awaiting review, practice invitations). It is parsed against the real route schema in the
teacher UI test, so it cannot drift.

## Not provided / limitations

- **Policy contract**: the dedicated grant, kind and rule are new in this branch. Teacher and student writes
  still use the planner's existing course checks (`activity`/`rubric`, `submission`) rather than dedicated
  `learning-guidance` rules; a student's own preference write needs no resource decision, like email
  preferences. The district-wide policy floor has no `guardianSuggestions` setting; the opt-in is per relationship.
- **Discussion prompts** are stored and shown as optional prompts; they are not posted as discussion topics.
- **Export, archive and purge** of guidance records are not implemented; the planner has the same gap.
- Evidence exists only through the grade 6 planner mappings. Other standards can be prioritised and tracked
  but show "no evidence pathway".
- A guardian's own suggestion list and the student's family-suggestion switch are per class and per student
  respectively; there is no cross-class guardian dashboard.
- No live browser, mobile app, notifications or email were added or exercised.

## Integration notes

Conflict-prone files are touched minimally: one spread in `routes.ts` (`...GUIDANCE_ROUTES`), one mount
plus one relationship source in `app.ts`, one field in `stores.ts` and `durable-stores.ts`, one enum value in
`contracts/authorization.ts`, one rule in `policy/rules.ts`, small links in `CoursePage`, `ChildPage`,
`router.tsx` and the teacher class route. Everything else is new files. The planner (`planner.ts`) is read,
not modified.

## Validation

```sh
pnpm --filter @educateos/policy exec vitest run __tests__/guardian-guidance.test.ts --maxWorkers=2
pnpm --filter @educateos/district-app exec vitest run __tests__/guidance.test.ts --maxWorkers=2
pnpm --filter @educateos/student-ui exec vitest run __tests__/guidance.test.tsx --maxWorkers=2
pnpm --filter @educateos/teacher-ui exec vitest run src/guidance --maxWorkers=2
pnpm --filter @educateos/admin-ui exec vitest run src/guardians --maxWorkers=2
pnpm --filter @educateos/policy --filter @educateos/district-app --filter @educateos/student-ui --filter @educateos/teacher-ui --filter @educateos/admin-ui exec tsc --noEmit
```
