# Adaptive planner coaching (SCHO-424)

Stacked on SCHO-420 / PR #394 at bb98a95c8. Non-deploying WIP: do not merge or deploy this milestone.

## Working student flow

Open Personalized Learning Planner in a class whose grade band includes 6 or 7. Enter an interest,
or select a standards focus and explain what you want to build. Accept or skip each opportunity.
Accepted opportunities have **Show me how**, escalating **Hint**, **Next step**, and **Try myself**.
Instruction gives a worked example and a concrete student action immediately; it does not gate help
behind repeated questions. Students can skip instruction and try independently. That closes help for
this attempt. **Reflect and transfer** asks how the idea might apply elsewhere.

The project response and practice challenge are separate, explicit sharing actions. A student shares
their project response first, then can share the challenge and reflection, disclosing help on each.
A fixed practice challenge is **not an unseen test**. The teacher selects and observes a separate
unseen assessment against the evidence contract before recommending mastery. Helped project work
can coexist with independently completed challenge practice and a separate teacher assessment.
Students who need help again can skip this opportunity and start a new plan; shared evidence is immutable.

## Curriculum integrity and age adaptation

The planner reuses district `CatalogMirror` approval, verified release content, digest, version,
publisher and provenance. Hidden, withdrawn, mismatched grade and unapproved nodes are refused.
It does not add fabricated CASE IDs, map an entire domain from a working artifact, or treat
prerequisite suggestions as a diagnosis. Existing records remain readable without a migration.

| Class band / focus | Verified catalog record | Instruction and coverage |
| --- | --- | --- |
| 6 / 6.RP.A.3b | 6.RP.A.3, component (b) | Unit pricing and constant-speed reasoning only; Pizza Tycoon and cookie examples preserved |
| 6 / W.6.1 | W.6.1 | Claims, clear reasons, credible evidence, cohesion, formal style, conclusion |
| 7 / 7.RP.A.1 | 7.RP.A.1 | Ratios of fractions, division, units and interpretation |
| 7 / W.7.1 | W.7.1 | Argument writing including alternate or opposing claims |
| K–5, 8–12 | No reviewed lessons in this milestone | Explicit unsupported-band response; no invented alignment |

A 6–7 class defaults to grade 6 and can explicitly select grade 7. Interest matching remains an
inspectable set of connections (rates/cost/production, argument/decision), not unrestricted semantic
alignment. Standards-first selection is explicit learner agency; the learner still needs to make
and explain the connection to their project. Unmatched interests get no speculative alignment.

There is no raw chat, therapy, sentiment or personality profiling. Optional skills remain unscored
practice. K–5 and unknown/mixed-younger grade bands cannot reach the injected model seam. The server
uses all active student course bands, conservatively taking the youngest, rather than trusting a
request-supplied age. Grades 6–12 are eligible only under explicit district permission, full effective
curriculum assistance policy, learner opt-in, approved model/funding policy and available quota.

## Evidence semantics

`student.plannerKnowledge` returns version 1 advisory knowledge, scoped by the authenticated district
store, offering and student. Each competency is pinned to its actual URI **and release digest** and
keeps evidence IDs. It is recomputed from persisted responses and latest teacher reviews:

- Opening/accepting a task, model output and hint usage leave knowledge unverified.
- Sharing practice records practiced, never demonstrated.
- A recommendation requires an independent challenge disclosure, independent teacher assistance,
  explicit independent-assessment attestation, a structured assessment context/observation and time,
  and demonstrated/retained/transferred level. Assessment time must follow shared practice and not
  be in the future. The teacher's rationale records the observed reasoning against all criteria.
- Retention requires a prior reviewed demonstration at the same URI/digest and a new delayed check
  at least seven days later. Transfer requires prior reviewed independent evidence and a different
  context. Context distinction is an explicit teacher attestation, not an LLM judgment.
- The latest reviewed evidence controls the advisory status. A later hold conservatively retracts
  the status to practiced; ties favor holds. Prior evidence and the append-only review history remain.
- No official grade, rubric score or assessment service state changes. Legacy reviews without the
  new challenge and structured assessment remain visible but cannot advance the new knowledge model.

Timing means server-observed help/start/share times, not measured attention or time on task. Challenge
provenance includes source `student-practice`, separate assistance, prior help count and timestamps.
The model does not infer that browser interaction proves independence; the teacher's unseen check is
mandatory. Practice prompts are public, so teachers must not reuse them as unseen assessments.

Teacher views redact the goal, private skills, unshared student opportunities, prior private intent,
coaching events, and personalized model explanations. Teachers receive only explicitly shared
responses/challenges/reflections and their provenance, plus their own invitations. No chats or
personal workspaces are read. Parent access is unchanged. All new routes reuse course policy,
active enrollment, student ownership and optimistic revisions, backed by the existing durable store.

## AI seam: production is not wired

`@educateos/curriculum/ai-help` resolves policy; it does **not** make completions. The existing district
ledger/governor supports model policy, reservations, quota and settlement. The existing
`educateos-ai-guard` input/output moderation operates at the Workshop gateway seam. The district
Worker currently provides no planner completion transport that can perform that guard's input
screening and output-release decision under the planner principal/context. An ordinary fetch to a
provider would bypass those checks, so no production adapter, external model call, key or secret was added.

`DistrictAppOptions.plannerAi` is the typed injection point. Its `PlannerAiProvider.completeGuarded`
contract requires the deployment's existing screened gateway, accepts only the current goal and
instruction with identifiers, and takes an abort signal and bounded output-token count. It receives
no raw chats, other students, assessment response or teacher review. The server itself checks opt-in,
age, explicit `enabledFor`, `AiHelpPolicySource`, and `ledgerGovernor` before calling it. Missing policy
fails closed (the curriculum service's permissive default is not used). Only full policy permits AI
explanations; hints-only continues using the reviewed curriculum hints.

The only accepted output is `{ competencyUri, releaseDigest, step, explanation }`, with exact
alignment/step verification and bounded text. Extra fields (including mastery), wrong alignments,
unscreened/withheld results and invalid usage retain the functioning curriculum lesson. Provider
errors/timeouts preserve the reservation liability as unknown cost rather than declaring a free
failed call. Valid calls settle even when their generated text is rejected. Four-second timeout,
no retries, no provider switching. Model text can change only the explanation, never tasks, standards,
criteria, scores or teacher judgments. Structural validation cannot guarantee mathematical truth;
a deployed adapter also needs content-screening and pedagogy evaluations before enablement.

## Executable evaluation fixtures

`packages/educateos-district-app/__tests__/planner-ai.test.ts` injects a real fake screened gateway
against the existing ledger. Fixtures cover opt-out, missing adapter/policy, K/5/mixed/unknown grades,
none/hints-only help, denied model/quota, wrong URI/digest/step, extra mastery, withheld output,
unknown-cost failure and valid personalized output. The authenticated route is exercised too.

`planner-adaptive.test.ts` is the student/evidence evaluation set: worked example, two hint levels,
next-step reset, independent-help closure, no automatic mastery, unseen teacher assessment,
future-time refusal, correction/hold, retention delay, context transfer, exact approved grade 7
records, explicit focus selection, wrong-band focus, ownership, enrollment, revisions and withdrawal.
`planner.test.ts` retains the baseline privacy, isolation, contracts and SQLite restart/concurrency tests.
The student UI journey exercises actual HTTP routes through the whole coach and sharing flow.

Student examples:

- “Build a Roblox Pizza Tycoon” (grade 6): compare oven rates, learn using an unrelated tile-machine
  example, then independently practice with printers. Teacher assesses a new context such as irrigation.
- “Compare cookie prices and persuade our club to choose a recipe” (grade 6): unit prices plus
  argument evidence. The recipe's success or generated code is not proof of either standard.
- “Build a pizza game” (grade 7): fractional rates and an argument considering opposing claims.
- “Build a garden” with explicit 7.RP.A.1 focus: make a quantity/time question using fractions; explain
  why rates matter to the garden. The connection is a student choice, not an inferred alignment.
- “Explore astronomy” without a supported focus, grade 5 frontier request, withdrawn standards,
  or an invented model alignment: no fabricated opportunity/model output is released.

Focused commands (one worker, explicit timeout):

```sh
pnpm --filter @educateos/district-app exec vitest run __tests__/planner.test.ts __tests__/planner-adaptive.test.ts __tests__/planner-ai.test.ts --maxWorkers=1 --testTimeout=30000
pnpm --filter @educateos/student-ui exec vitest run __tests__/planner.test.tsx --maxWorkers=1 --testTimeout=30000
pnpm --filter @educateos/teacher-ui exec vitest run src/planner/PlannerPage.test.tsx --maxWorkers=1 --testTimeout=30000
pnpm --filter @educateos/district-app exec tsc --noEmit
pnpm --filter @educateos/student-ui exec tsc --noEmit
pnpm --filter @educateos/teacher-ui exec tsc --noEmit
```

Remaining boundaries: production AI adapter and screening/evaluation, reviewed lessons beyond grades
6–7, richer content-specific prerequisite graphs, per-criterion teacher test results, evidence imports
and cross-offering knowledge are future work. No full workspace build is required for this WIP handoff.
