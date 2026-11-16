# Educator-reviewed learning recipes

Stacked on the pilot release candidate (PR #414). Non-deploying WIP: do not merge or deploy this milestone.

A student says "I want to build a Roblox pizza tycoon" or "get better at basketball". The planner used
to decide what that meant with a fixed keyword table. It now connects an interest to a standard only
through a **learning recipe that a teacher read and approved for their class**. A recipe is reusable,
versioned content: why the connection is real, what to practise first, a worked, actionable task, an
independent practice challenge, and a rubric for the teacher's separate transfer check.

## What a teacher does

Teacher Studio → class → **Learning planner** → **Learning recipes**.

- **Preview** shows the exact text a student would see, the words that make the recipe match, and what it does not cover.
- **Edit before approving** changes *why now*, the student task and the independent challenge. An edit is saved as a new version.
- **Approve for this class** is only available while the recipe's standard is usable (the card says why not). **Reject** records the decision. **Withdraw approval** stops new offers and further steps on existing opportunities. Earlier work remains readable as archived history.
- **Pause learning recipes** is a per-class switch: while paused, goals create no opportunities at all.
- Every decision is audited (who, when, optional note).

Starter recipes (grade 6 · 6.RP.A.3b via game production, basketball practice and baking prices; grade 6 ·
W.6.1 evidence-based argument; grade 7 · 7.RP.A.1 fraction rates) are proposals from the EducateOS team.
They are **not educator-reviewed**: each is "Not reviewed yet" in every class until that class's teacher
approves it, and nothing is offered to students before then. Teacher-authored recipes use the same API
(`content` with no `starterId`).

## What a student sees

An ordinary planner opportunity, optional and skippable, with a "Where this opportunity came from"
panel: who approved it, the recipe title and version, whether it is starter text or edited, the words from
their goal that matched, why now, suggested prerequisites (never a diagnosis), and what the recipe does not
cover. Teachers see the recipe provenance on shared work but never the goal or the matched words.

## Integrity rules

- **Matching** (`matchRecipeInterest`) is deterministic and inspectable: the interest terms *and* the recipe's project hook must appear, a negated term ("I don't want to make a pizza tycoon") counts for nothing, excluded terms veto. "Build a Roblox game" or "I want to eat pizza" connect to nothing. When nothing matches, nothing is offered.
- **No invented standards.** A recipe names a catalog framework key, the published code, and (for a component such as `6.RP.A.3b`) verbatim `statementIncludes` text. Approval looks the item up in the **release the district approved** and pins its URI, release version and release digest. Unknown frameworks, unapproved frameworks (the Texas TEKS and Michigan entries are declared pointers with no approved items, so no recipe for them can be approved), missing items, hidden items, wrong subject, wrong grade, mismatched statement text and unknown prerequisite standards are all refused with a reason. Local catalog identities are never presented as canonical CASE GUIDs.
- **Enforced server-side, again at use.** Every plan creation re-verifies the recipe against the current approved release and its pinned digest, so a withdrawn, replaced, hidden or tampered-with approval is not offered even though its record still exists. Every opportunity then passes `plannerApproved` (approved release digest + the item is a member of that release), and the stored plan schema refuses a label that is not the pinned item's own code (or that code plus one lettered component).
- **Immutable approvals.** A record's content and digest never change. An edit approves a *new version* and supersedes the old one; plans created earlier keep the version and digest they were offered.
- **Class scope and fixed-mapping fallback.** Recipes live in the existing guidance store as class records (no student field, so a student's records and erasure never include them). Until a class makes its first recipe decision the legacy fixed mapping still applies so existing pilots do not change; from then on only approved recipes connect interests to standards. Rejecting or pausing does not bring the fixed mapping back.
- **Authorization.** Only the class's active teachers with the course policy's authoring permission can decide (a co-teacher can read; the policy does not give them authoring); students, unrelated teachers, administrators and other districts are refused. There is no student, guardian or admin recipe route. A guardian suggestion is not a recipe input and cannot create an assignment.
- **No automatic mastery.** An approved recipe changes only what is *offered*. Accepting, sharing, hints and AI help create no mastery; evidence still needs the separate independent practice challenge, a teacher's unseen assessment, independent assistance disclosures and the existing review floor. Generated code is practice evidence at most. There is no sentiment, personality or SEL inference.

## Extending to other standards

A recipe's standard is `{ frameworkKey, code, gradeLevels, statementIncludes? }`. A Texas TEKS or Michigan recipe becomes approvable the moment a district imports and approves that framework's release and the item exists in it; nothing in this code asserts a TEKS or Michigan mapping. Recipes are not yet shared across classes or districts; district-scope sharing is future work.

## Validation

```sh
pnpm --filter @educateos/district-app exec vitest run __tests__/learning-recipes.test.ts --maxWorkers=1
pnpm --filter @educateos/teacher-ui exec vitest run src/planner --maxWorkers=1
pnpm --filter @educateos/student-ui exec vitest run __tests__/planner-recipes.test.tsx --maxWorkers=1
pnpm --filter @educateos/district-app exec tsc --noEmit   # likewise teacher-ui and student-ui
```

API routes: `teacher.recipes`, `teacher.recipeDecision`, `teacher.recipeSettings`.

## Integrated release review (SCHO-434)

The integration applies privacy commit `f7d0ce226d34d8245a8eec54668f5d6a111f5a2b` first,
then final recipe commit `5f51da4659430dad33ca99e45fe07965013f9476`, on PR #414's
`0952988043272017a9db2569a87a26e8807537f8`. This is a non-deploying WIP targeting
`feat/plp-pilot-release-candidate`; no merge or deployment is authorized.

Student reads derive `unavailableReason` on a clone when the exact recipe version, class approval
or pinned catalog release is no longer usable. Stored plans, private goals and teacher-reviewed
evidence are not rewritten. The student sees an archived notice and disabled actions; teacher
history still excludes the private goal and matching words. Accept, coaching, sharing, challenges
and new recommendations check current approval. Coaching and external evidence recheck after I/O.

Synthetic release regressions cover in-flight purge with an unchanged deployment grant, preserved
billing/audit and peer plans, recipe survival through subject deletion, withdrawal after plan creation,
stale recipe release digests and withdrawn standards, archived history, private goals and no automatic
mastery. Worker tests additionally cover durable revocation through eviction and subject quota erasure.

These checks use invented students and fake model responses. No real students participated, no actual
Roblox game was built or evaluated, and state standards (including TEKS and Michigan) were not imported.
They do not establish learning outcomes or standards equivalence. There is no hidden SEL or psychological
profiling in the recipe matcher.

Tracker metadata could not be updated because the Kanbanger workspace credential is missing. Optional
React Doctor did not run because pnpm's external cache was not writable. Local checks and hosted CI
receipts are reported separately in the integration PR; producer receipts do not certify its head.

## Criterion-level independent review (SCHO-435)

The [educator reconfirmation procedure](pilot/criterion-review.md) adds observed common-check excerpts
and a teacher rating for each pinned evidence-contract criterion. Legacy judgments remain readable
and are explicitly marked for reconfirmation; no text is automatically graded. This is a non-deploying
WIP rehearsal, not school-validated calibration.
