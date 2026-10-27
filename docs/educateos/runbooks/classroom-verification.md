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

The original provider plan excludes Classroom add-ons and keeps rubric results in EducateOS because
Google's API cannot publish rubric grades. Education Plus seats alone do not establish add-on
support. Expand the product scope explicitly before claiming those surfaces are implemented.

Close SCHO-255 only after the required rows have live evidence and each intended production target
has a deployment ID, commit/artifact and healthy acceptance result. Keep unsupported workflows
explicit; do not describe provider fakes or local/in-memory runs as deployed verification.
