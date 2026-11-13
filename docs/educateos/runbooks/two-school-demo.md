# Harbor/Classroom and Northfield/Canvas demo

SCHO-354 owns the two-school build-out. Both use invented people and coursework. Vendor data
provisioning is separate from acceptance of authenticated EducateOS workflows.

## Northfield and Canvas

Northfield's live district is `dst_gmacko-coop`, with its existing co-op records plus the additive
Northfield showcase. Do not replace it with the `dst_northfield` fixture. The showcase offering IDs
already exist there. `seed-showcase.ts verify` checks the live district through an administrator's
Access session, including all twelve installed sample courses.

`scripts/demo/seed-canvas-demo.ts` provisions the real Canvas account **3**, EducateOS Demo, at
`canvas.mackie.house`. Its stable SIS IDs begin `educateos-demo:`. It creates missing users,
enrollments, twelve courses, twenty-four activities, two modules per course, introduction pages,
and module links. It never resets rosters or edits existing learner work. It refuses ambiguous
duplicate identities and assignment-name collisions without its ownership marker. Existing
course **2**, its LTI tools, graded exemplar, and paging students remain untouched.

```sh
node scripts/demo/seed-canvas-demo.ts dry-run --out /tmp/canvas-plan.json
node scripts/demo/seed-canvas-demo.ts run --out /tmp/canvas-seeded.json
node scripts/demo/seed-canvas-demo.ts verify --out /tmp/canvas-verified.json
```

Reports must be new files; they are created mode 600 before vendor writes. The API token is read
only in memory from Keychain service `educateos-canvas-demo-admin-token`. New synthetic logins
receive no email or stored password. Rerunning creates missing objects, and verification reports
configuration drift rather than overwriting teacher edits. After an uncertain write, verify the
provider before retrying. For hosts with a slow IPv4 connection and no IPv6 route, Node options
`--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000` may be needed.

The new Canvas courses still need their own LTI deployments and approved context/identity mappings
to the live district. A matching fixture ID is **not** an approved identity link. Modules include activities, introductions and discussion links. The seed also creates published
synthetic discussion topics and announcements using stable titles and ownership markers; it refuses
collisions and preserves existing content. Eight Canvas Classic quizzes are also seeded and linked into modules. Questions preserve numeric
tolerances and choice keys in teacher-only question fields. All-or-nothing multiple-select items
become explicitly teacher-scored responses because Canvas Classic uses different automatic scoring.
Results stay hidden (`hide_results: always`); Canvas ignores `show_correct_answers` in this mode.
Existing incomplete quizzes are reported for inspection, never blindly recreated or published.
Quiz attempts, discussion participation and learner work remain to be populated.
The seed does not manufacture grade approvals or claim grade-return acceptance.

## Harbor and Classroom

The existing Google tenant is `gedu.demo.educateos.io`. `seed-google-demo.ts --verify` reads its
accounts and exact course rosters. Do not rerun roster mutations blindly: that script makes planned
rosters exact, including removing manually added members.

`scripts/demo/seed-harbor-classroom.ts` adds two Harbor-specific assignments to each of its four
courses: Marine Science, Composition, US Government and Math 7. It resolves existing course aliases,
acts as each course's teacher with the existing delegated credential, checks project ownership,
and preserves every existing exemplar. It touches no Cedar Valley course.

```sh
node scripts/demo/seed-harbor-classroom.ts dry-run --out /tmp/harbor-plan.json
node scripts/demo/seed-harbor-classroom.ts run --out /tmp/harbor-seeded.json
node scripts/demo/seed-harbor-classroom.ts verify --out /tmp/harbor-verified.json
```

The credential is Keychain service `educateos-classroom-demo-sa-key`. Reports contain IDs and
outcomes, never credentials. Teacher-scoped delegated API operations prove provider provisioning;
they do not prove an authenticated teacher or student EducateOS session. The previous graded
exemplars are documented in [Classroom verification](classroom-verification.md).

### Harbor learner work and teacher review

`scripts/demo/harbor-classroom-work.ts` gives the seeded Harbor activities real learner work. Each
learner turns in their own submission with a token delegated to their own synthetic account
(`classroom.coursework.me`, which reaches only their own submission). Each course's own teacher
then grades and returns its first activity with the script's synthetic scores, and leaves the
second turned in for review. Reruns change nothing, and a grade a teacher has since edited is kept.
Each run also checks that a learner's attempts to read or grade a classmate's submission are refused.

```sh
node scripts/demo/harbor-classroom-work.ts run    --out /tmp/harbor-work.json
node scripts/demo/harbor-classroom-work.ts verify --out /tmp/harbor-work-verified.json
```

These are provider-side workflows by each actual synthetic account, through the same Classroom
calls the Google connector makes. They are not a Workshop approval flow (see
[Classroom verification](classroom-verification.md)).

### Signing presenters in as Harbor personas

Harbor's roster comes from Classroom, so its teachers and students have no Access sign-in of
their own. A presenter's Access sign-in can be linked to one synthetic teacher or student with the
demo operator route. The route needs **both** the operator token (Keychain
`educateos-harbor-demo-operator-token`) and the presenter's own Access assertion:

```sh
curl -X POST https://harbor.educateos.io/api/demo/operator/identity-links \
  -H "authorization: Bearer $OPERATOR" -H "cf-access-jwt-assertion: $CF_AUTHORIZATION" \
  -H "content-type: application/json" -d '{"principalId":"<teacher or student principal>"}'
```

The link goes through the district's own identity request and administrator approval, so it is
audited. Administrators, district-scoped roles, unknown or ambiguous personas and service tokens
are refused. A sign-in another principal already owns returns 409. Verify the result with
`/api/me` in the presenter's session.

## Demo sign-in credential recovery

Agent-inbox's supported source of truth is app `agent-inbox`, stage `production`, secret
`INBOX_TOKEN`. Retrieve it with `forge secret get INBOX_TOKEN --stage production --json` **inside a
process that captures stdout privately**, verify the inbox read API, then write its value to
`~/.config/agent-inbox/token` with mode 600. Never print the response or pass its value in command
arguments. A stale local token alone does not require rotation. See agent-inbox's own README for
rotation and its `scripts/access-sign-in.ts` for the ordinary OTP flow.

Use distinct synthetic role sessions. A successful Access cookie must also resolve through `/api/me`
to the intended district principal. An administrator acting through a provider API does not count
as student sign-in. Harbor OTP rejection is separate from inbox authorization; do not weaken Access
policies or elevate an unlinked identity to make a demo pass.

## Live evidence, 2026-11-12

- Canvas seed and read-only verification: 32 people, 12 published courses, 24 assignments,
  24 module introductions and linked activities, four discussion topics and fourteen announcements;
  GET-only verification reports no configuration problems.
- Harbor seed and read-only verification: four real courses, eight published app-owned assignments; no reported problems.
- Northfield showcase verification: twelve sample courses installed, all four bands populated;
  35 personas, ten linked. Existing co-op offerings retained.
- Northfield administrator, teacher-68 and student-68 Access sign-ins succeeded. Teacher-68 resolved
  to Hannah Kowalski, student-68 to Kofi Mensah; each listed one class. Teacher-to-student,
  student-to-teacher and both admin API calls returned 403. LMS launch acceptance remains open.
- Harbor administrator OTP was rejected; existing inbox credentials were recovered and verified
  HTTP 200. This does not establish Harbor administrator access.

Required before completion: authenticated role/principal verification, student isolation, LTI
launches in each intended course, learner submissions, teacher review and approved grade return,
readback from the learner's session, and production publication evidence for the implementation.

## Connecting additional Canvas courses

An authenticated district administrator can append a course to an existing approved registration
with `POST /api/lti/registrations/course-links`:

```json
{
  "issuer": "https://canvas.mackie.house",
  "clientId": "<approved Canvas client ID>",
  "contextId": "<actual Canvas LTI context ID>",
  "offeringId": "<live district offering ID>",
  "deploymentId": "<actual installed tool deployment ID>"
}
```

Obtain context and deployment IDs from the installed Canvas tool; numeric Canvas course IDs are
not LTI context IDs. Exact retries are idempotent. The operation rejects context rebinding, unknown
offerings and untrusted issuers, preserves existing course/activity mappings and endpoints, and
requires district administration (school administrators, teachers and students are refused).
Read `/api/lti/registrations` back to verify the saved mapping. This does not link identities or
prove a launch: use the separate identity approval workflow, then verify a genuine student launch
and its reported services before configuring grade routes.
