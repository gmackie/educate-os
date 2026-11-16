# Personalized Learning Planner MVP (SCHO-420)

The next stacked milestone is documented in [Adaptive planner coaching](planner-adaptive-coaching.md)
(SCHO-424): structured grade 6–7 coaching, independent practice, teacher assessment and advisory
knowledge. The MVP description below records the original baseline; use the milestone guide for
current assessment requirements and the production-unwired AI provider seam.

This is an implemented, deterministic grade 6 planner in the district application. Open a student's
class page and select **Personalized Learning Planner · optional grade 6 opportunities**. In Teacher
Studio, open that class's **Learning planner** tab (`/teach/#/classes/<offering-id>/planner`). The class's
catalog course must include grade 6. The district must approve **Common Core Math** and/or **Common
Core ELA** through the existing admin Standards screen. Other grades get an explicit scope message;
an unmatched goal or a framework without approval gets no speculative alignment.

Students enter a goal, optionally select teamwork, planning or communication practice, and receive
up to two optional opportunities. Each shows why it matched, an actionable task, prior shared
planner evidence, approved standard metadata and an evidence contract. Students can accept or skip,
then explicitly share a text response and disclose assistance. Teacher invitations show the teacher's
name and message and are also optional. They create no assignment or due date; required work still
uses the existing **Create activity** flow.

## Two examples

**Pizza Tycoon:** “Build a Roblox Pizza Tycoon.” The fixed mapping proposes unit-rate practice:
oven A makes 12 pizzas in 3 minutes, oven B makes 15 in 5 minutes. The learner calculates 4 and 3
pizzas/minute, predicts 80 and 60 after 20 minutes, explains units and the choice, and then solves
an unseen rate problem independently with the teacher. This connects to **6.RP.A.3b**, not mastery
of the entire ratio domain. A second opportunity asks for an argument about a project decision,
supported by credible evidence, connecting to **W.6.1**. A working game, generated code or AI-written
explanation alone is never mastery evidence.

**Cookie project:** “Compare cookie prices and persuade our club to choose a recipe.” Compare 12
cookies for $6 with 20 for $8: $0.50 versus $0.40 per cookie; 30 would cost $15 or $12 at those rates.
Explain the assumptions and choice; the teacher provides a fresh independent unit-price check.
For W.6.1 the student writes a claim supported by reasons and relevant evidence from credible
sources, uses connecting language and formal style, and concludes. The teacher assesses the
learner's explanation, not whether they purchased or baked anything.

These example numbers are curated instructional prompts. They are not standards fixtures or claims
about real Roblox production rates. No game account, vendor or model access is needed.

## Standards and evidence integrity

The implementation reuses `CatalogMirror`, district approvals/overlays, and the registry's
`EvidenceContract` and `CompetencyRef`. It adds no standards registry or CASE GUIDs. The catalog's
verified grade 6 text is derived from PlayTrek seed transcriptions checked against the publisher;
its `derived` provenance, framework publisher/version, node URI, release version and digest remain
attached to every opportunity. Local catalog UUIDs are not represented as publisher CASE identities.

The existing catalog stores **6.RP.A.3**, including its verified lettered components, rather than a
separate 6.RP.A.3b node. The planner displays **6.RP.A.3b** as a component label and pins the actual
6.RP.A.3 node. Its contract assesses only the unit-rate component. W.6.1 pins its existing node.
Hidden items are excluded, and accepting, sharing or recommending fails if the pinned release is
no longer approved or its node is hidden. Historical records remain readable. No approval is
granted by creating a plan.

Teacher observations record **encountered / practiced / demonstrated / retained / transferred**
separately from **independent / adult / peer / AI / unknown** assistance. Encountering a task, accepting
it, sharing work, and receiving automated help produce no mastery inference. A recommendation
requires teacher attestation of independent assessment, independent assistance in both the learner's
disclosure and teacher observation, and demonstrated/retained/transferred evidence. A rationale is
required, including delayed-check or new-context conditions where applicable. The recommendation
is advisory: it changes no official grade. Teachers can append a hold or corrected observation;
the full review history survives. New goals cite the latest shared evidence and review without
promoting it to a higher evidence level. A new independent response uses a new plan; already shared
responses cannot be rewritten under an existing review.

## Boundaries and storage

All routes run through district identity resolution, surface roles and the existing audited course
policy engine. Only active class teachers may manage invitations/reviews; administrators do not get
student evidence through these routes. Students must be active enrollees and can only act on their
own plans. Records use the district's native Durable Object SQLite storage, with revision checks
and atomic writes; the in-memory implementation is for tests/harnesses.

Teachers see their class's teacher invitations and explicitly shared task responses. Private learner
goal text, optional skill choices and unshared learner opportunities are removed server-side. The
planner never reads personal workspaces or chats. It makes no model calls, so it cannot bypass
district model policy or consent. Optional skill practice has no score, sentiment analysis, emotional
profile, hidden nudge, clinical assessment or therapy behavior.

This slice implements the teacher invitation/review surface. **Parent invitations are deferred**:
the existing guardian policy is deliberately read-only and has not been loosened. It does not import
legacy grades, quiz outcomes, LTI scores or Gadget artifacts as independent mastery evidence. Prior
evidence is limited to this student's explicitly shared planner work in this class. No production
deployment or merge is part of this work.

## Validation and local use

Run the existing local district/harness setup (`pnpm educateos:harness`; see `docs/educateos/README.md`),
use a grade 6 course and roster, and approve the Common Core releases. A real IdP session or the
harness's synthetic identities supply authentication; the planner introduces no role switcher or
unauthenticated demo API. The focused UI journeys use a grade 6 variant of the Northfield fixture
and call the real district API, providing a reproducible student-to-teacher demo without an IdP.

```sh
pnpm --filter @educateos/district-app exec vitest run __tests__/planner.test.ts
pnpm --filter @educateos/student-ui exec vitest run __tests__/planner.test.tsx
pnpm --filter @educateos/teacher-ui exec vitest run src/planner/PlannerPage.test.tsx
pnpm --filter @educateos/district-app exec tsc --noEmit
pnpm --filter @educateos/student-ui exec tsc --noEmit
pnpm --filter @educateos/teacher-ui exec tsc --noEmit
```

API routes: `student.planner`, `student.planGoal`, `student.plannerDecision`,
`student.plannerShare`, `teacher.planner`, `teacher.plannerInvite`, `teacher.plannerReview`.
They are in the existing typed route table and API client. Mutations require the displayed plan's
revision; conflicts require reload, preventing stale tabs from overwriting decisions or reviews.
