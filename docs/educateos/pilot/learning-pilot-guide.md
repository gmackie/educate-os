# Student-led learning pilot: guide for teachers and families

- Status: **WIP, not deployed, not yet run with children.** Everything here was exercised only with
  invented people in an in-memory district (see [Replay it](#replay-it-with-synthetic-people)).
- Issue: SCHO-432. Stacked on the integrated learning WIP (#406). Design notes:
  [personalized-learning-planner.md](../personalized-learning-planner.md),
  [planner-adaptive-coaching.md](../planner-adaptive-coaching.md),
  [guidance-and-evidence.md](../guidance-and-evidence.md),
  [planner-integration.md](../planner-integration.md).
- Evaluation: [learning-pilot-evaluation.md](learning-pilot-evaluation.md).
- The [data rule](program.md#the-data-rule) applies: **until the district signs a DPA, use synthetic
  or staff-only data.** Nothing below changes that.

## What this is

A grade 6 or 7 student types something they care about. If it naturally connects to a verified
standard the district has approved, they are offered an optional lesson built from that interest.
They can ask for help, try alone, and share their work. Their teacher then checks the idea on a
different task that the student has not seen. Only that teacher check can mark independent evidence.

It is not an adaptive tutor, a grade, a diagnosis or a personality profile.

## Three students, one negative example

| Student's interest | What they are offered | What a teacher sees afterwards |
| --- | --- | --- |
| Roblox pizza tycoon | Unit rates (**6.RP.A.3b**, the unit-rate part of 6.RP.A.3) and argument writing (**W.6.1**) | Rate evidence reviewed independently; the writing offer was skipped, so there is nothing to see |
| Cookie business | The same two standards, with cookie prices | Rate evidence reviewed independently; writing practised with a classmate's help, so not counted as independent |
| Basketball practice | Unit rates with free throws per minute | Practised, but the practice was done with AI help, so a teacher cannot call it independent |
| "Black holes and a poem about astronomy" | **Nothing.** No lesson, no standard attached | Nothing. The student is not nudged toward a fit |

Grade 7 students are offered **7.RP.A.1** (rates with fractions) from the same kind of interest. A
grade 5 student gets a plain message that no reviewed lessons exist for their grade.

Only standards from the district's **approved** release are used. The planner pins the registry's own
record (including the publisher's text and its derived provenance). It never invents a CASE
identifier. 6.RP.A.3b is shown as a label for part (b) of the registry's 6.RP.A.3 record, because the
registry holds no separate node for it.

## For teachers

1. In Admin, approve Common Core Math and ELA (the Standards screen). Without approval no lesson is offered.
2. Students open **Personalized Learning Planner** on the class page. You do not assign it.
3. Read **Learning planner** in Teacher Studio for work students chose to share. You see no private
   goal, no skipped offers and no chats.
4. To record evidence, give a **separate, unseen** task, watch it, then record the review with the
   level (encountered, practiced, demonstrated, retained or transferred), how the student was
   helped, and a rationale. You cannot recommend independent evidence if the student's own practice
   disclosed help.
5. Use **Guidance** for coverage. Opportunities offered/accepted/shared and evidence by student are
   two separate counts. Neither is a grade, and nothing here changes the gradebook.
6. Do not reuse the practice challenge as your unseen task: its prompt is public to the student.

**Reading the labels.** *Encountered*: work was shared. *Practiced*: shared with help or unreviewed.
*Independent-reviewed*: you saw it done alone on an unseen task. *Retained*: a delayed check at least
seven days later. *Transferred*: a new context. An AI-written project is never any of these by itself.

## For families

- Your child's work in the planner is theirs to share. They can skip any offer, and skipping is private.
- **Family suggestions are off.** A district administrator can turn them on for one relationship at
  a time, after the guardian has been verified. If it is on, you can suggest a topic (plain text, no
  links or contact details, at most three open at a time). The teacher decides whether to pass it
  on. Your child sees it labelled **"Family suggestion, from your family: your name"** and may say yes
  or no. A no is private from you and the teacher. A suggestion is never an assignment.
- Your child can switch family suggestions off. You will not be told why a suggestion could not be sent.
- You see a progress label only if the administrator also turns on that option, only for standards the
  teacher chose, and never a grade, answer or goal.
- AI help is **off by default** and is never available for kindergarten through grade 5. In grades
  6 and up it needs district permission, a separate choice by your child, and the district's own spending
  limits. Even then the model may only reword an explanation; it cannot change the standard, the task
  or a teacher's judgment.

## Safeguards

- No clinical profiling, diagnosis, therapy behaviour, sentiment scoring or emotion analysis.
  Optional teamwork, planning and communication practice (CASEL-style classroom skills) is fixed wording,
  unscored, and can be declined privately.
- The planner never reads chats or personal workspaces.
- A model cannot create a standard, a lesson or a mastery claim. Wrong alignments are rejected.
- Withdrawn standards stop new coaching, sharing and recommendations; history stays readable.
- Every guardian decision is checked by the policy engine and audited. Another family, class or
  district sees nothing.
- Known limit: interest matching uses an inspectable keyword list. A goal with a trigger word but no
  real rate or argument content can still get an offer, so it stays optional and counts for nothing
  until a teacher reviews independent work.

## Consent, opt-out and retention

**Consent.** District and school sign off before any real student is involved. Families are told
what the pilot is, what is held, and the choices below, using [family-letter.md](family-letter.md).
Student participation is voluntary at every step.

**Opt-out.** There is **no per-student technical switch yet.** To opt a child out, tell the school
lead; the teacher does not invite that student and the student does not open the planner. Students
who opt out do the same class work without it, and it does not affect grades. Student AI is separately
off unless the district enables it and the student chooses it. Guardians' suggestions are off unless an
administrator enables them for that relationship, and are revoked in one step (the history is kept).

**Retention.** Records live in the district's own storage. Suggestions expire (30 days waiting, 90
days visible) and expired ones are never shown. On this branch, planner records have **no scheduled deletion,
no per-student deletion and are not in the district export or student archive.** Whole-district
uninstall removes the storage (see [offboarding](../runbooks/district-offboarding.md), step 5).
**Pending integration:** a separate branch, `feat/plp-student-data-lifecycle`, is building authorized
data lifecycle (export and deletion). It is not integrated here and has not been verified by this
work, so do not tell families that per-student deletion works until it is merged, tested and
checked against these records.
Before any real use, the district and pilot lead write down: how long planner and review records
are kept (suggest: until the pilot ends plus the evaluation window), who may ask for deletion, and
how it will be done. Do not promise families more than the product does today.

## Replay it with synthetic people

```sh
pnpm install --frozen-lockfile --prefer-offline
pnpm educateos:pilot            # narrative of every scripted journey
pnpm educateos:pilot --check    # compare with the reviewed golden
pnpm --filter @educateos/harness exec vitest run __tests__/pilot-journeys.test.ts __tests__/pilot-adversarial.test.ts
pnpm --filter @educateos/fixtures exec vitest run __tests__/pilot-learning.test.ts
```

The replay uses the district **Pilot Lakes (synthetic)** (`@educateos/fixtures`, `PILOT_LEARNING`),
the real district API in memory, and no model or network. If the planner's behaviour changes on
purpose, review the diff and run `pnpm educateos:pilot --update`. It plays Roblox, cookie and
basketball learners, a no-fit learner, a grade 7 and a grade 5 learner, a seven-day delayed check,
and the guardian opt-in with its source.

## What a passing replay does not tell you

It shows the software routes interest, help, practice, review and coverage as designed, and refuses
what it should. It does **not** show that a child learned, that the lessons are good, that a teacher's
unseen task is valid, or that any family will understand the choices. Those need people and the
[evaluation plan](learning-pilot-evaluation.md). Also not exercised: a browser, real devices, a real
IdP, live model behaviour, accessibility with assistive technology, and production health.
