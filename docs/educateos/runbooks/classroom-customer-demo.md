# Classroom investor and customer walkthrough

For the Clever partner discussion, use the [meeting kit](../clever-partner-demo/README.md),
which adds source-grounded prompts, an offline presentation, exact access requests and pilot
acceptance criteria. The [personal student companion](../examples/classroom-student-companion/README.md)
is separate from teacher presentation authority; live EducateOS student acceptance remains open.

Use synthetic accounts and the saved [Classroom workspace](https://schoolos.gmac.io/workspace/6803f77edf00585d77d65d58c46267e3f09fb0905131571eaf6658e299532c74?w=13).
This is the demonstrated presentation path. The broader district/student/Plus acceptance gates in
[classroom-verification.md](classroom-verification.md) must pass before describing the entire
Classroom surface as production validated.

## Before presenting

Open the saved workspace without a `chat=` query, refresh each assignment and confirm the fetch
time advances. Keep the connected teacher account Dana Whitaker; the presentation gadgets hold
teacher capabilities. Do not share them with a student audience as if they enforced student-only
access. Use the projector views for screen presentation. Keep real credentials and approval
configuration out of the projected screen.

Prepare Science and Algebra worksheet PDFs, deck PDFs and PowerPoint files through the lab's
Export Gadget menu. When Chrome opens its native Save dialog, select a destination; an unanswered
Save dialog is not a failed export. Keep downloaded files as a fallback for an external outage,
and say they are snapshots with their displayed fetch time.

## Live walkthrough

1. **Connected intelligence.** Open the verified connector conversation. Show the observed
   assignment title, points and rubric, then compare the same values in the saved Science gadget.
   Explain that the agent uses code mode with an explicitly granted course resource. A generated
   narrative is supported by the actual connector reads, not an invented classroom snapshot.
2. **Teacher workflow.** Open the Science Lesson Studio's teacher view. Show the synthetic
   weathering task, its 20-point rubric, and An's returned 18/20. Show the committed status in
   the teacher approvals conversation. Approval controls an external write; the presenter should
   not imply that an agent independently published a grade without that decision.
3. **Student result.** In the separately signed-in An Google Classroom browser, open the
   weathering assignment, its submitted attachment, and the returned 18/20. This verifies real
   Google Classroom learner visibility. It does not yet demonstrate an EducateOS student-scoped
   connector or principal session.
4. **Science presentation.** In Assignment Formats Lab, choose Earth Science. Open Worksheet,
   Slide deck, Practice quiz and Discussion. Show the live investigation steps/rubric, advance a
   slide with an arrow key, answer a question incorrectly to show its explanation, reset practice,
   and start/pause/reset the discussion timer. Expand the teacher facilitation notes.
5. **Algebra presentation.** Switch to Algebra. Show the live two-step-equation worked example,
   independent practice and 10-point criteria. Use its quiz to explain equivalent operations and
   substitution checks. The quiz is local practice; it does not save responses or pass a grade back.
6. **Portable delivery.** Use Export Gadget to download a class-specific worksheet PDF, deck PDF
   and PowerPoint. Show the editable text in PowerPoint and the task/source references in PDF.
   Science has nine slides, Algebra seven; each worksheet has a separate response page.
7. **Control and trust.** Show the course bindings and explain the demonstrated boundary:
   presentation RPCs do not read roster/submissions, pending/draft tasks are hidden, and Google
   coursework mutations require this application's project ownership. Separately authorized
   collaborator access and revocation acceptance remain an additional gate.

## Plus management rehearsal after deployment

Use an ungraded synthetic draft assignment, never the graded Science exemplar. Through code mode,
list its rubric, request an edit retaining criterion/level IDs, inspect and approve the exact
replacement, then read it back. Demonstrate rejection without an external change. Delete only a
rubric created for this rehearsal and verify the committed absence. Google may forbid edits or
removal after grading starts; show a refusal honestly rather than changing the graded example.

For grading periods, reconnect the teacher for `classroom.courses` consent. Read and record the
full original settings. Request one explicit replacement including the chosen
`applyToExistingCoursework` flag; inspect that omitted periods would be deleted. Approve, read
Google back, then restore the recorded settings through the same approved workflow. This sequence
is a rehearsal checklist, not live acceptance evidence yet.

## Do not claim yet

- Full deployed district roster preview/apply/scheduled sync and verified identity links.
- EducateOS student principal sign-in, student-scoped gadget submission or grade passback.
- Verified collaborator/revocation/outage recovery across the whole workflow.
- Live acceptance of the newly added rubric/period management methods before production readback.
- Classroom add-on launch, attachment, Marketplace installation or eligibility discovery.

Keep these as concrete remaining delivery gates. The existing Google connector, assignment
lifecycle and presentation/export evidence are described precisely in the verification runbook.
