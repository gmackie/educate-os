# Workshop demonstration prompts

Paste these into **the account that owns the stated binding**. The agent should inspect the
binding's actual TypeScript API before generating code. Resource names in prompts are suggested
binding names, not automatic grants. Stop if the account, enrolled course or authority differs.
No prompt bypasses an approval. Readback must come from the provider after approval, separately
from any pending/simulated view. Historical evidence and newly executed output must be labeled.

## 1. Teacher code-mode: grounded assignment briefing

Connect only `SCIENCE` to the Google teacher course resource
`https://classroom.googleapis.com/courses/895811762849` as Dana Whitaker.

> Use code mode and the connected SCIENCE resource. Read the binding's declared types, getCourse(),
> getCourseWork("896258346598") and listRubrics("896258346598"). Return the actual course name,
> assignment title, PUBLISHED state, 20-point maximum and rubric criteria/level points. Include
> source IDs and fetch time. Refuse a draft or pending assignment. Explain the learning goal in
> two sentences grounded in the returned instructions. Do not read the roster, submissions or
> grades, request other connections, or write anything. If a read fails, say which step failed.

Expected historical fixture: weathering investigation, rubric Accurate science 8/4/0,
Evidence and reasoning 8/4/0, Clear communication 4/2/0. Compare exact current titles from Google;
the descriptions in this kit are explanatory, not assertions that provider wording never changes.

## 2. Direct teacher gadget: all formats, two classes

The saved Formats Lab already binds `SCIENCE` and `ALGEBRA` to their separate teacher resources.

> Refresh both live assignments in the existing Assignment Formats Lab using its existing course
> bindings. Preserve its server's explicit lesson projection and PUBLISHED/non-pending guard.
> Show Science investigation and Algebra worked-example/practice in Worksheet, Slide deck,
> Practice quiz and Discussion. Keep quiz responses local, label that they do not save or send
> grades, and keep discussion roles anonymous. Do not read learner data or add connections.
> Keep keyboard slide controls, quiz explanations/reset, timer start/pause/reset, mobile layout,
> fetch/source references and each class's worksheet PDF, deck PDF and PowerPoint exports.

For a fresh gadget, give the agent the source at `examples/classroom-formats-lab`, run its build
as the README specifies, and review/accept the built `server.js` and `client.js`. It is a teacher
presentation; projection or a visible warning does not turn teacher authority into student access.

## 3. Controlled instructor write — separate rehearsal work only

> In the synthetic Science course, inspect the actual createCourseWork input type. Propose one
> new DRAFT assignment titled "Clever meeting rehearsal — [unique timestamp]", 10 points,
> asking students to explain one physical and one chemical weathering observation with evidence.
> Do not touch work 896258346598 or its rubric/submissions. Queue the request and wait for my
> approval decision. On the first rehearsal I will reject it: refresh the provider and verify
> it was not created. On a second explicitly requested rehearsal I will approve one draft:
> verify exactly one committed provider record and report its ID and state. Do not publish,
> retry an uncertain action or infer persistence from a simulated pending result.

Draft creation is demonstrated historically. New publication/rubric/grade operations should use
the actual current API and dedicated fixture IDs. Do not promise general modification of courses
or assignments created by a different OAuth project.

## 4. Student code-mode: personal learning briefing

In the learner's separate EducateOS workspace, connect only `GOOGLE_CLASSROOM_STUDENT` to
`https://classroom.googleapis.com/student-courses/895811762849` with the learner's own Google account.

> Inspect GOOGLE_CLASSROOM_STUDENT's real types. Use listCourseWork(), find published work
> 896258346598 and call getMySubmission() for that work only. Explain my task and my current
> submission state, using those returned values and source IDs. Do not accept a user ID argument,
> read other people's work, request a teacher connection or write anything. Explain that file
> access is still checked by Google and returned grades are viewed in Google Classroom. If
> enrollment or OAuth fails, report it without fabricating an assignment or my submission.

## 5. Student direct gadget and turn-in

> Create a personal Classroom companion from the provided student-companion source. It must bind
> only GOOGLE_CLASSROOM_STUDENT, list published assignments/materials, read my own submission,
> and request turn-in after my explicit confirmation and the normal approval decision. Read
> Google after the decision and show confirmed TURNED_IN only when Google returns it. Clear
> previous private content on a connection error. Do not add roster, grades, upload, reclaim,
> classmate or teacher configuration features; those methods are absent from this interface.

Use a fresh synthetic rehearsal assignment whose work was prepared in Classroom. Then:

> For the dedicated rehearsal work ID [paste recorded ID], read my current submission. If it is
> CREATED or RECLAIMED_BY_STUDENT, request turnIn() once and wait for my approval. Read the actual
> submission back. If rejected, timed out or not confirmed, report the uncertainty and refresh
> before any new request. Do not turn in the returned weathering exemplar or upload attachments.

This student EducateOS path is implemented, with automated checks; live acceptance remains open.

## 6. Publish a learner-safe blueprint

> Prepare the committed personal companion for Publish as blueprint. The only required binding
> is GOOGLE_CLASSROOM_STUDENT, title "My enrolled Classroom course", type pattern
> https://classroom.googleapis.com/student-courses/:courseId. Each student must install their own
> instance and supply their own connection; omit a class-specific suggestion for wider reuse.
> Explain the new binding step and review/accept update flow. Do not include teacher bindings,
> chat history, personal submissions, credentials or workspace storage. Do not publish or share
> a live teacher workspace as the student blueprint. Use the existing blueprint UI and validate
> a fresh second student's copy before calling the distribution flow verified.

## 7. Additional Google surfaces — preparation recipes, not rehearsed proof

Use synthetic files and separate exact resources. Do not ask for all of these at once. The
[matrix](capability-matrix.md) records what exists and what must still be exercised live.

| Binding / use | Copyable prompt |
|---|---|
| `LESSON_DOC` / reading guide | Inspect types; call listTabs() and getContent(tabId) on this exact Google Doc. Make a reading guide with source tab IDs and quotations. Propose appendText of three comprehension questions only after I ask for an edit; inspect approval and read back after commitment. Do not change file sharing. |
| `LAB_SHEET` / synthetic investigation | Inspect types, getSpreadsheet(), then readRange on the explicit bounded data range I select. Explain patterns using actual values and units. Propose a small updateSpreadsheet change set on a dedicated practice tab; wait for approval and distinguish pending cells from committed Google readback. Do not read a gradebook. |
| `LESSON_SLIDES` / native presentation | Inspect types, getPresentation(), then getSlides() for selected IDs, at most 20. Produce a lesson outline from actual content. If I request an edit, propose updateSlides on the selected slide only, await approval and read back. Distinguish this native Google resource from the Formats Lab's local deck/PPTX renderer. |
| `CLASS_LIBRARY` / folder resource | Get the bound scope, list/search only the chosen Drive folder's direct children, drain cursor.next() until null, and dispose the cursor. Open one in-scope native Google file read-only and dispose that session too. Show source links; do not upload, share, delete, recurse the whole account or infer that students can open the files. |
| `CLASS_CALENDAR` / selected calendar | Inspect getCapabilities(), getCalendar(), listEvents() for my explicit window. Summarize the agenda. Propose a synthetic study event only on my request, state any sendUpdates behavior and wait for approval. Use a stable calendar ID, not primary. Check student invitations/visibility separately. |
| `CLASS_THREAD` / selected Chat thread | Read getMetadata() and the bounded thread messages through its cursor, then dispose it. Summarize questions with source references. On my request propose a reply via post(), wait for approval and read back. Never connect the teacher's whole Chat account into a student lesson. |
| `TEACHER_MAIL` / private mailbox | In a teacher-only workspace, inspect the scoped mailbox API and summarize my selected synthetic thread. Propose a draft/reply only as explicitly requested; keep the recipient and final send decision visible. Never put mailbox content or the binding in a learner blueprint. |
| `TEACHING_DATA` / synthetic BigQuery table | Inspect the bound project/table and schema. Dry-run a bounded read-only query, state the estimated bytes/cost controls and query the synthetic aggregate only within the configured limit. Do not join student identities, execute DML or treat query-cost approval as permission to disclose personal records. |

## 8. Clever pilot request, after access is enabled

> With the authorized district configuration and synthetic token in its secret store, preview a
> complete Clever roster sync through the existing district adapter. Report API version, run ID,
> counts, proposed changes, quarantines and any held removals. Apply only through the supported
> admin control; do not change the version, scopes or service principal to bypass a refusal.
> Verify stable principals and class memberships, then demonstrate one enrollment delta or full
> refresh according to the enabled products. Keep tokens and provider bodies out of logs and
> presentation output. Link the result to SCHO-211 and preserve the last successful roster on error.

This is a pilot acceptance script for an administrator; it is not a claim that the current Google
gatekeeper exposes Clever methods or that district admin authorization is already configured.
