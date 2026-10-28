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
