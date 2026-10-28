# Classroom live acceptance (SCHO-255)

Run against the synthetic `gedu.demo.educateos.io` accounts in Harbor and Cedar Valley. Never
substitute an administrator enrolled as a student. Record timestamp, district, deployment revision,
course/work IDs, actor role and outcome; keep credentials and tokens out of evidence.

| Surface | Required evidence | Current status |
| --- | --- | --- |
| Tenant readiness | Classroom enabled, API access allowed, under-18 OAuth app configured, licenses read back | Verified during SCHO-202 |
| Fixtures | 18 users, six OUs, eight active courses, exact owners and memberships | Seed and verify passed, SCHO-202 |
| District roster | Deployed admin preview/apply, scheduled complete sync, selected courses only, identity quarantine | Library live Harbor sync passed; deployed verification pending |
| Identity | Teacher and student authenticated identities resolve to their intended roster principals; no email identity keys | Pending |
| Coursework | Teacher creates app-owned work through EducateOS; project ownership read back | One provider smoke passed; deployed flow pending |
| Project boundary | Teacher-created or foreign-project work cannot be graded through EducateOS | Fake tests only; live pending |
| Student submission | Correct learner sees work; submit/reclaim state transitions and teacher visibility | Pending |
| Grade approval | Unapproved grade refused; approved exact score/max points published; retry does not duplicate | One real provider passback smoke passed; deployed flow pending |
| Return | Approved grade visible to learner after return; partial patch/return failure recovers safely | Pending |
| Workshop actions | Teacher agent queues write, approval applies it, result appears in Classroom | Reverify SCHO-213 with current deployment |
| Authorization | Other district, unlinked account, learner attempting teacher writes, revoked account refused | Pending |
| Sync recovery | Removal hold, dropped membership, archived course, provider outage, pagination, retry | Fake tests exist; live deployed subset pending |
| Plus capabilities | Eligibility checked before licensed calls; unsupported rubric grade writes documented | Four teacher licenses assigned; feature acceptance pending |

The user expanded SCHO-255 to include rubrics, grading periods and Classroom add-ons on
2026-10-27. These are acceptance requirements. Google's API cannot publish rubric-level grades;
only the teacher-approved total is published. Education Plus seats alone do not establish add-on
support.

Close SCHO-255 only after the required rows have live evidence and each intended production target
has a deployment ID, commit/artifact and healthy acceptance result. Keep unsupported workflows
explicit; do not describe provider fakes or local/in-memory runs as deployed verification.


## Customer demo evidence, 2026-10-27

**Readiness: incomplete. Do not present this as a fully validated customer demo.**

Harbor deployment `e5469214-da12-43fe-ac8a-65c1375bca6f` and Cedar Valley deployment
`65daa33a-52c4-4c21-811f-18e703e09388` are active at
`2b84a5f2e5933445b85123994dafe4da08977b3a`; each `/healthz` returned `ok`.
This proves deployment health, not district roster configuration or authenticated user acceptance.

Real Google provider evidence using the seeded Cedar Valley student:

- Course `895811762849`, alias `d:off_cv-earthsci-p1`, teacher Whitaker, three students.
- App-owned work `896231288996`, created at `2026-10-27T23:52:08.855Z`, 10 points.
- Grade 8.5 posted through the approval gate; repeat `already-posted`; unapproved version refused
  with `policy-violation`; teacher readback confirmed assigned and draft grade 8.5.
- Rubric `896231202644` created successfully on this work, criterion "Scientific explanation",
  levels 10 and 0 points. Rubric listing and grading-period settings returned HTTP 200.
- Shipped connector `gradeAndReturn` hit HTTP 400 `FAILED_PRECONDITION` for the `CREATED`
  submission. It now refuses such work before patching a grade; the student must turn it in first.
- Student turn-in with the current delegation returned HTTP 403
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. `classroom.coursework.me` is not delegated.
- Capability checks for rubrics, grading periods and add-ons returned HTTP 404 "Method not found",
  including with `V1_20240930_PREVIEW`. A 404 is not an eligibility denial: real rubric creation
  succeeded. Investigate Developer Preview enrollment before promising eligibility discovery.
- `classroom.addons.teacher` and `classroom.addons.student` are not delegated. The connector has
  no add-on launch/attachment workflow yet. Add-on setup and any Google publication requirements
  remain open; no add-on demonstration is claimed.

Reproduce the provider smoke with
`node packages/educateos-integrations/scripts/classroom-smoke.ts` (creates new synthetic work).
The runner now matches a real enrolled fixture learner and asserts approval refusal and retry
outcomes; it does not create an administrator-as-student principal.

Run read-only tenant preflight with
`node packages/educateos-integrations/scripts/classroom-readiness.ts`. It prints a JSON report and
exits 2 while capability/scope dependencies remain blocked.

Run shipped connector API acceptance with
`node packages/educateos-integrations/scripts/classroom-connector-live.ts`. It uses the existing
synthetic work above, reads its rubric and grading periods, and attempts to return its approved
8.5/10 grade. It currently fails clearly until the learner turns the work in. This is deliberately
an opt-in live test outside normal CI; it is not a deployed Workshop approval-flow test.

Next live acceptance sequence:

1. Restore the shared Google Admin browser session; configure the exact student and add-on access
   needed, investigate capability-preview access, and read back settings.
2. Configure the deployed district roster provider and run admin preview/apply; verify selected
   courses and stable Google identities. Do not overwrite a district's existing directory or source
   authority to force a sync.
3. Sign in the seeded teacher and learner through EducateOS and confirm their linked principals.
4. Queue and approve coursework/rubric creation through the deployed connector; read it in Google.
5. Have the learner turn work in; approve the exact grade, return it, and verify learner visibility.
6. Verify denial, removal/revocation, outage/retry, grading-period management and add-on workflows.
7. Capture the customer walkthrough only after these gates pass. Use synthetic data throughout.

## Workspace and gadget acceptance, 2026-10-28

These are required customer acceptance gates, in addition to provider verification. A local API
runner does not satisfy them. Record the workspace URL, connected Google identity, deployed
revision, tool results, approval decision, and Google readback for each example.

- **Code-mode briefing:** connect course `895811762849` as `CLASSROOM`; inspect its declared API,
  then use `executeCode` to read the course, roster, app-owned work, submissions, rubrics and
  grading periods. The response must derive its counts and grades from the observed results,
  identify failures, and distinguish pending simulated changes from committed data.
- **Direct gadget:** wire that resource into the gadget with `setGadgetBinding`. Its server must
  read its own `env.CLASSROOM`, rather than displaying a pasted chat snapshot. Verify refresh,
  persistence after reload, empty/error states, and a separately authorized collaborator.
- **Approved changes:** using the seeded teacher's OAuth account, queue synthetic coursework and
  rubric creation; verify rejection makes no Google change, approval commits once, and subsequent
  code-mode and gadget reads agree with Google. Grade only an eligible turned-in submission.
- **Boundaries:** verify a different course cannot be read through this course binding, foreign
  coursework cannot be mutated, a student cannot perform teacher writes, and expired credentials
  require reconnection. Never substitute admin authority for a teacher acceptance result.

Workspace started: <https://schoolos.gmac.io/workspace/6803f77edf00585d77d65d58c46267e3f09fb0905131571eaf6658e299532c74>,
named **Classroom — Earth Science live briefing (SCHO-255)**. Connection discovery and an exact
course connection request succeeded. Initial authorization used `gmackie@gedu.demo.educateos.io`;
this is admin access, not teacher sign-in evidence. The teacher-authorized gadget and fresh
code-mode verification below supersede the initial credential failure.

The shared preview refused OAuth pop-ups twice with “Pop-up blocked. Please allow pop-ups and
try again.” A separate Chrome validation profile permits the normal OAuth popup/handoff flow.
Do not bypass the popup nonce or redeem a copied connect URL from a different session.

Tenant preflight now successfully mints delegated tokens for `classroom.coursework.me`,
`classroom.addons.teacher` and `classroom.addons.student` after the user's Google Admin confirmation.
Submission `Cg4I8ZmlsYoaEKThsNyKGg` belongs to An Nguyen (`109086804245677102525`). A read as
Rowan was denied HTTP 403; turn-in as An succeeded HTTP 200. The opt-in shipped connector verifier
then passed (1/1), confirming teacher return and `RETURNED` with 8.5/10. This remains delegated API
evidence, distinct from the workspace and gadget acceptance above. Capability discovery still
returns HTTP 404; rubric listing and grading-period settings return HTTP 200.

Connector production deployment `077ea80d-5cec-4815-b1c0-e9a7de26e99a` reports active at
`719d37eaf2a99f6b266cb7b0d515c8ff2df8d2cd` (PR #170). Full customer readiness remains incomplete.


Teacher OAuth and reusable dashboard acceptance passed at 2026-10-28 01:23–01:28 UTC:

- Normal OAuth reconnect completed as `cv-teacher-whitaker@gedu.demo.educateos.io`. Course
  discovery returned Earth Science 8 Period 1. The Workshop login remains the admin; this proves
  teacher connector authorization, not teacher EducateOS principal linking.
- Replaced the gadget's expired admin binding through Connections with the teacher course binding,
  named `CLASSROOM`, and accepted the draft. The gadget reads its own binding on every refresh.
- Live render showed Dana Whitaker, three students, four app-owned assignments, rubric
  `Scientific explanation`, and no configured grading periods. Work `896231288996` showed
  An Nguyen `RETURNED` / 8.5; Bao Nguyen and Rowan Ellis `CREATED` / ungraded. Rows join by userId.
- Refresh advanced the fetched timestamp from 01:23:17 to 01:23:33 UTC. Reload retained the
  accepted gadget and binding and fetched at 01:23:38 UTC.
- A fresh conversation in the same workspace invoked `executeCode` against
  `ES_SCHO_255_BRIEFING.rpc.fetchDashboard()`, corrected an initial roster-shape assumption, then
  explicitly asserted all three submission states/grades. Its final response reports those exact
  values, the rubric levels (10/0), no grading periods, and fetch time `2026-10-28T01:26:31.220Z`.
  This is a real gadget RPC read through the connector, not pasted chat data.

Two defects were exposed during validation. The first conversation initially matched students
by response order and misattributed An's grade to Rowan; deterministic userId joins corrected it.
The longer conversation then failed screening: guard call
`e6dedad6-4a4e-4d50-a505-571813c9b839` admitted after 19,026 ms while the kernel timed out at
15,000 ms. The fix allows input screening 60 seconds, retains the 15-second output deadline,
fail-closed behavior and immediate Stop, and tests successful 19-second screening plus refusal at
60 seconds. This fix still requires deployment and replay of the original failed conversation.

Remaining customer gates: real Workshop approval/rejection and committed readback, student
EducateOS sign-in and grade visibility, district sync/identity linkage, collaborator isolation,
Plus grading-period writes/add-ons/rubric editing, and final production health. The live read-only
example is usable; full Classroom delivery is not complete.

## Workshop writes and visual acceptance, 2026-10-28

The persisted gadget initially had no stylesheet (zero CSSStyleSheets, Times computed body font).
Its `client.js` now installs a sandbox-local stylesheet with 46 rules, and changes were accepted.
After reload the computed font is sans-serif, dashboard padding is 16px, roster uses grid, and
coursework cards have 1px borders. At 390px width the header/roster become single-column and the
page's scrollWidth remains 390px; all four original tables have overflow wrappers. Live refresh
advanced 01:56:59 to 01:58:32 UTC and still showed An's returned 8.5. Styling is persisted gadget
content, not a Workshop frontend deployment.

PR #171 is active in production at `4ca51756b1376547f48e8dbd4368b4f2e4f01e32`: backend deployment
`148e5e37-8ccf-410f-961c-abe682d0519e`, router `328853ca-4c5a-4315-94a5-01b6022adb68`.

A separate conversation in the same workspace authorized `CLASSROOM_TEACHER` explicitly as
`cv-teacher-whitaker@gedu.demo.educateos.io`. It exercised real `executeCode` and Workshop actions:

1. Queued **SCHO-255 approval rejection check 2026-10-28**, DRAFT, 10 points. Workshop showed a
   provisional `pending:create:1`; Google readback before approval still showed only four existing
   published assignments. Denied in Workshop; Google readback at 02:12:44 UTC still showed only
   those four. The connector subsequently asserted no rejected title or pending assignment.
2. Queued **SCHO-255 approved teacher demo 2026-10-28**, DRAFT, 10 points, and approved it in
   Workshop. Google readback at 02:13:30 UTC showed exactly one new work, `896248644916`, matching
   title/state/points. The connector independently verified it was committed and not pending.
3. Queued and approved a rubric for that work. Google readback at 02:14:21 UTC returned
   `896250232565`, criterion **Evidence-based explanation**, levels Supported/Developing/Needs
   evidence at 10/5/0. The gadget's refresh displayed the new draft and the same rubric.
4. Attempted to grade Rowan's CREATED submission at 7. The connector refused before queuing:
   “This submission has not been turned in. Ask the student to turn it in before grading and
   returning it.” Connector readback confirmed Rowan remained CREATED with no pending grade.
5. Queued An's already-returned submission at its existing 8.5, approved it in Workshop, and read
   Google again at 02:16:42 UTC: An RETURNED with assignedGrade/draftGrade 8.5; Rowan CREATED with
   neither grade. This validates approval of regrading without changing the demonstrated grade;
   it is not evidence of interactive student sign-in or a new turn-in.

Final code-mode comparison passed 11 assertions across direct connector and gadget data, including
single committed assignment, rejected title absence, exact rubric, and both learner grades/states.
It exposed one fetch failure: Google returns HTTP 400 when the gadget lists submissions on the
new committed DRAFT. The connector fix returns an observed empty submission list for an owned
draft, without calling that unsupported endpoint. Ownership is checked first; errors on published
work still propagate. Regression reproduces the unnecessary request before the fix. Production
replay is required after deployment.

Harbor sign-in as `gmackie@gedu.demo.educateos.io` currently reaches “You're signed in, but you
haven't been added to this school yet.” Access subject is
`ca2e0a56-0adf-5403-bd68-d526c0ee0d93`. No principal was created or linked to bypass this boundary.
An existing Harbor administrator is needed for roster setup and verified teacher/student links.
Full Plus management and add-on acceptance remain outstanding.

## Complete assignment and presentation examples, 2026-10-28

The reusable workspace now contains three teacher-authorized gadgets:

| Gadget | Classroom | Presentation |
| --- | --- | --- |
| `ES_SCHO_255_BRIEFING` | Earth Science 8, Period 1 (`895811762849`) | Live teacher dashboard |
| `SCIENCE_LESSON_STUDIO` | Earth Science 8, Period 1 (`895811762849`) | Investigation lesson slides and private teacher review |
| `ALGEBRA_LESSON_STUDIO` | Algebra I, Period 3 (`896141390025`) | Worked example, independent practice, answer checks and teacher overview |

Each has its own persistent `CLASSROOM` resource binding authorized as Dana Whitaker. Projector
mode is a display choice inside a teacher-authorized gadget, **not** a student authorization
boundary. Do not share the workspace or gadget with students on the strength of the mode switch.
Projector RPCs omit roster/submission reads and their responses contain no learner names/grades.
Student-capability bindings remain a separate implementation/acceptance requirement.

### Real published assignment round trip

1. Workshop's teacher approval conversation used `executeCode` to check for duplicates, then queued
   **Earth Science field investigation — Weathering evidence (SCHO-255)**. Approval created exactly
   one app-owned assignment, `896258346598`, **PUBLISHED**, 20 points, at 03:52:38 UTC.
   The prompt includes a learning goal, a 200–300 word claim/evidence/reasoning task, observations,
   alternative explanations, a labelled sketch option, and peer discussion.
2. Workshop approved rubric `896259887221` at 03:53:34 UTC: Accurate science (8/4/0), Evidence and
   reasoning (8/4/0), Clear communication (4/2/0). Google readback and the real student's browser
   showed the same 20-point rubric. Criterion-level grade publication is unsupported by Google's API.
3. Signed into Google Classroom interactively as **An Nguyen**,
   `cv-student-an@gedu.demo.educateos.io`, Google user `109086804245677102525`, using a synthetic
   browser credential retained only in Keychain. An saw the assignment and rubric under the
   correct enrolled course. This is Google student sign-in, not EducateOS district principal linking.
4. Used Classroom's normal file picker to attach a 200–300 word synthetic response,
   `scho255-weathering-an.txt` (Drive file `1odfC33humWychfxB9-BsTvndvlY97KWC`). The response explicitly
   labels its observations as invented and includes no personal location data. Confirmed **Turn in**
   in the student browser. Google history records `TURNED_IN` at 04:02:21.846 UTC by An's own user ID.
5. Teacher code mode read submissions and asserted the exact learner, state and submission
   `Cg4I8ZmlsYoaEOacpOmKGg`, then queued **18/20** for approval. Google history records the teacher's
   approved total at 04:03:28.710 UTC and `RETURNED` at 04:03:29.302 UTC. Reloaded An's actual browser:
   assignment displays **18 points out of possible 20**, **Graded**, the attachment, and **Resubmit**.
6. Science gadget teacher refresh independently displayed An **RETURNED / 18 / not pending**;
   Bao and Rowan remained **CREATED / ungraded / not pending**. Names join by `userId`.

A second real assignment was created through the Algebra teacher binding and approved:
**Algebra I — Explain and solve two-step equations (SCHO-255)**, `896261051224`, **PUBLISHED**,
10 points. Google readback at 04:18:04 UTC found exactly one item. It includes a worked example,
three practice equations, substitution checks and a 6+4 point success criterion.

### Visual and persistence checks

The Science and Algebra gadgets retain sandbox-local CSS after accepting changes and reloading.
Computed font is sans-serif; at 1019px their scroll width matches the viewport. Science at 390px
also has scroll width 390px. Algebra's Next button opens the worked example; ArrowRight opens
independent practice; Teacher shows the live one-teacher/two-student roster and honest empty state
before the new assignment was published. Science Teacher refresh shows the returned 18/20.

Browser acceptance exposed a lesson parsing defect: the Learning Goal slide initially repeated the
entire one-paragraph assignment description. Corrected and observed the exact goal alone after
acceptance; numbered instructions and success criteria are parsed separately. Final accepted edits
were reloaded and verified: Science shows exactly four task instructions and the goal alone; Algebra
shows the live published assignment title/10 points and a separate Assignment Details slide, followed
by the worked-example/practice slides. Teacher notices explain that the whole gadget remains
teacher-authorized. Six checks against the exact downloaded server sources (both gadgets × published,
draft, pending) passed: hidden work has no returned assignment/rubrics, and projector execution never
calls roster or submissions. These are source-level boundary checks, alongside live browser acceptance,
not proof of a separately authorized student or collaborator.

The earlier unstyled shared preview was a stale loaded gadget frame: full workspace reload loaded
the saved stylesheet and fresh data. Merely inspecting the separate validation Chrome missed that
window-specific symptom. No repository CSS change was needed to recover it.

### Production and remaining gates

PR #172 is active on Google connector deployment `9633e7f9-bccb-4598-9168-562cf92e3fc4`, commit
`2259d9a76fe2391c5474222e8181380dbad4ad8d`. Refreshing the accepted briefing gadget now reads the
committed draft's empty submissions without its previous HTTP 400 fetch error.

These demonstrations prove teacher connector reads/writes, real student Classroom submission and
grade visibility, and multiple persistent live gadget presentation styles. They do **not** complete:

- Harbor administrator authentication, deployed roster preview/apply/scheduled sync and identity links.
- Teacher/student EducateOS principal sign-in and a student-scoped connector/gadget submission flow.
- Separately authorized collaborator/course isolation and removal/revocation/recovery acceptance.
- Plus rubric editing/deletion, grading-period management, add-on launch/attachment and eligibility discovery.
- Portable gadget/slide exports: the current custom gadgets expose no verified export workflow.

Keep SCHO-255 open. Do not describe this evidence as full Classroom/Plus surface-area acceptance.

### Assignment Formats Lab — 2026-10-28

Saved gadget: [Classroom — Assignment Formats Lab](https://schoolos.gmac.io/workspace/6803f77edf00585d77d65d58c46267e3f09fb0905131571eaf6658e299532c74?w=13).
Reproducible source and build instructions are in `../examples/classroom-formats-lab/`.
The code-mode conversation authorized and wired exact teacher course bindings `SCIENCE`
(895811762849) and `ALGEBRA` (896141390025), then performed six live resource reads. Final
files were completed and accepted through Workshop's normal Code editor.

Both classes now provide all four requested customer presentation formats:

| Format | Verified behavior |
| --- | --- |
| Worksheet | Live published task, points, success criteria, available Science rubric, response spaces; two-page printable PDF per class |
| Slide deck | Live learning goal/task/criteria, Science investigation steps or Algebra worked example/practice, discussion prompt, source references; next/previous and arrow keys |
| Practice quiz | Three class-specific reasoning questions; correct and incorrect explanations, unanswered guard, reset; local only, no saved responses or grade passback |
| Discussion | Agenda, rotating roles, class-specific prompt, teacher notes, timer start/pause/reset |

Real browser checks passed for both classes: all quiz answers correct (3/3), incorrect-answer
feedback, reset clearing inputs, timer countdown/pause/reset, expanded notes, slide buttons and
keyboard navigation, class switching, saved class/format after full reload and persistent CSS.
Shared preview at 519px also rendered the styled lab. This is teacher-authorized presentation;
it does not establish student-scoped gadget sharing.

Workshop's normal Export Gadget menu offers six class-specific formats. Actual downloaded
PowerPoint files passed ZIP CRC, required OPC/presentation XML and per-slide XML validation:
Science 9 slides (19,861 bytes), Algebra 7 slides (16,903 bytes). PDF deck exports contained 9 and
7 pages respectively. Final worksheet PDFs each contain 2 pages, with response areas beginning
on a separate page. PDF signatures, readable assignment text/source IDs, and absence of learner
names/grade records were checked. Exports fetch the live assignment before capture; browser PDF
uses a top-level awaited load. PowerPoint reuses the bundled renderer with its existing quotas.

The initial export appeared to stall because Chrome's native Save dialog was awaiting a file
location. Automated download verification used the platform's supported blob fallback by disabling
the optional File System Access API in that test page only. Native Save-dialog completion remains
an operator step; this does not establish that path's automated acceptance.

The source boundary check covers published projection, rejected draft, rejected pending and
unknown class. Draft/pending assignments are rejected before rubric reads. No roster or submission
methods are called. A live long-conversation preview returned opaque internal errors even with a
minimal constant server; opening the saved gadget without `chat=` restored it. This is a recovery
workaround, not a resolved kernel regression. Preserve this as a remaining recovery gate.

PR176 was approved with exact-head green CI and merged as
`28cdcc1b53fc51377311acf41903040229804dbf`; it records the earlier assignment lifecycle evidence.
Production target deployment `083387c4-6dc1-4487-8cfe-c26e34dbecd2` was active for that commit at
04:53:40 UTC; other targets were still pending when inspected. SCHO-255 remains open for the
remaining district/student/collaborator authorization, recovery and full Plus/add-on acceptance.

### Plus management implementation follow-up

The teacher connector now adds `updateRubric`, `deleteRubric` and
`updateGradingPeriodSettings` on the existing course session. Changes wait for a decision through
the existing action journal; no speculative Plus mutation is shown. Rubric writes recheck
project ownership when applied, preserve existing criterion/level IDs for edits and rely on
Google's post-grading restrictions. Period replacement requires explicit
`applyToExistingCoursework`, validates real calendar dates, chronological non-overlap and unique
titles/IDs, and warns that omitted entries are deleted. An uncertain mutation is claimed and
not resent, since missing IDs could create new items on a repeated request.

The course resource now requests `classroom.courses` rather than its readonly variant because
Google's grading-period update endpoint requires it. Existing readonly connections need renewed
consent. This does not expose general course editing. Add-on scopes remain absent.

Implementation validation is separate from live acceptance. Use the rehearsal sequence in
[classroom-customer-demo.md](classroom-customer-demo.md) after deployment. Do not edit/delete the
graded weathering exemplar. Harbor still shows the current Google admin as an unlinked identity;
the existing operator administrator must sign in before supported roster/identity setup proceeds.


### Harbor setup continuation, 2026-10-28

Owner email PIN sign-in restored the existing `prn_hb-school-admin` (Marisol Vega) at
`/admin/`; `/api/me` confirms district-admin for `dst_harbor`. No recovery elevation or reseed
was used. The initial dashboard has one staff member, no courses and no configuration revision.
The supported config preview found `untrusted-roster-issuer`: Harbor's stored directory trusts
Access but not Google's issuer. A startup `additionalTrustedIssuers` deployment setting now adds
explicit issuer trust without changing existing identities, roles or LTI trust. This requires
its own deployment before the Classroom revision can apply.

Google connector deployment `6824917a-5019-4522-a5f2-5d32ff7dd2ae` is active at
`47d5d25189f8e5e117ddd7e14721f64f0a4b2043` (PR179). Live rubric/period mutations are still
pending. Harbor's DWD credential was stored in ForgeGraph; prepared course selection contains only
the four Harbor courses, never Cedar Valley's courses. Configuration and roster apply have not
occurred yet. Scheduled sync still requires an authorized service principal.
