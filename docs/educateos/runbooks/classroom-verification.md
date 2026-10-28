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
