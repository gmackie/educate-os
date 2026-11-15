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
The seed does not manufacture grade approvals or claim grade-return acceptance.

### Northfield learner work, teacher review and LTI acceptance

`scripts/demo/canvas-participation.ts` populates the seeded courses from the showcase fixtures:
learners submit their fixture work, post their discussion entries and take the quizzes with their
fixture answers; each course's teacher grades work the fixture marks graded or released, posts
their discussion replies and scores essay items. Each person acts as themself with a Canvas API
token minted in the Canvas Rails console that expires within the hour (`scripts/demo/canvas-actors.ts`;
the console is reached with `ssh labnuc`, overridable with `CANVAS_RAILS_RUNNER`), and every token
a run minted is expired before it exits. Reruns add nothing, a teacher's later grade is kept, and
each run checks that a learner cannot read a classmate's submission. These are Canvas-native
workflows, not EducateOS grade approval or AGS passback.

```sh
node scripts/demo/canvas-participation.ts run    --out /tmp/canvas-work.json
node scripts/demo/canvas-participation.ts verify --out /tmp/canvas-work-verified.json
```

`scripts/demo/canvas-lti-acceptance.ts` drives genuine LTI 1.3 launches with a scripted browser
signed in to Canvas as each synthetic person (a single-use Canvas session token), following the
same OIDC forms and redirects a browser would, and refusing to go anywhere but Canvas and the
district tool. `launches` has each connected course's teacher and a learner open EducateOS from
course navigation; each must be accepted as themself in that course's offering. `deep-link` has a
course's teacher add two EducateOS activities to its first module through Canvas's module
external-tool picker (`LtiDeepLinkingRequest`, `link_selection`); Canvas saves the signed content
items as module items, the teacher publishes them, and a learner's launch of each must open exactly
the selected activity. A rerun reuses the items, and a learner must not reach the picker.
Canvas is behind Access, so pass a `CF_Authorization` value for canvas.mackie.house (agent-inbox's
`scripts/access-sign-in.ts`).

```sh
node scripts/demo/canvas-lti-acceptance.ts launches --access-cookie <file> --out /tmp/launches.json
node scripts/demo/canvas-lti-acceptance.ts deep-link --offering off_nf-eng8-fall-p2 --access-cookie <file> --out /tmp/deep-link.json
```

### Northfield teacher-approved grade return (AGS)

`scripts/demo/canvas-grade-return.ts` returns every teacher-approved EducateOS grade in the twelve
showcase courses to Canvas, through LTI AGS (SCHO-413). For each assignment holding approved
official grades, a district administrator routes the offering's grades to its Canvas course, finds
or creates its Canvas column ("[educateos-approved] <title>", found again by the assignment ID on a
rerun) and binds it to the assignment. Each grade is then published by the teacher who approved
it, from their own EducateOS session: the district takes the score from that approval, never from
the request, and refuses anyone else, which each run checks with the administrator's own attempt.
Each learner then reads the score from their own Canvas submission with a short-lived credential.

Teachers sign in as presenters. Each band has one presenter sign-in (agent-inbox's
`teacher-k2|35|68|912@agents.gmac.io`). The script links it to the band teacher it acts as, through
the showcase link route, and links every presenter back to its original persona when it ends,
including after a failure. `verify` writes nothing but those links, and reports grades not yet
returned. Reruns publish nothing twice (`already-posted`).

```sh
# Each cookie file holds a CF_Authorization value for northfield.educateos.io (access-sign-in.ts).
node scripts/demo/canvas-grade-return.ts run    --admin-cookie <admin> \
  --presenter K-2=<file> --presenter 3-5=<file> --presenter 6-8=<file> --presenter 9-12=<file> --out /tmp/grade-return.json
node scripts/demo/canvas-grade-return.ts verify --admin-cookie <admin> --presenter ... --out /tmp/grade-return-verified.json
```

Canvas columns are looked up in the Canvas console (`ssh labnuc`, as for `canvas-actors.ts`), because
the REST API does not list AGS line items by resource ID.

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

### Harbor's "From Google Classroom" panel

Grades teachers return in Classroom show in EducateOS read-only (SCHO-403). A student's class
page has a "From Google Classroom" section listing their own returned work: the assignment
(linked to Classroom), its grade out of the coursework's points, and "Returned". A teacher's or
co-teacher's gradebook for a class has the same section below the official grid: each enrolled
student against the class's 50 most recent coursework, with any assigned grade and whether the
work is turned in, returned or not yet turned in.

Grades are read live on each page load through the district Worker's Classroom connection
(`DISTRICT_CONFIG.classroom` and the `GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY` secret), acting as the
course owner with the delegated scopes in their `rosterScopes` form plus
`classroom.coursework.students` (`.readonly` for a read-only delegation). Nothing is stored in
EducateOS and nothing is written to Classroom. A student's read asks Classroom only for their own
returned submissions; neither panel shows anyone the roster did not import. Offerings and people
are matched through the roster's source map (Classroom course ID and user ID), so the panel shows
only where the head configuration's roster is `google-classroom`. Without the connection or its
key, the routes (`/api/student|teacher/offerings/:offeringId/classroom-grades`) answer
`not-connected` and the panel is hidden. If Classroom does not answer within about 15 seconds or
refuses, the panel says "Google Classroom can't be reached right now", the rest of the page loads,
and the Worker logs `district.classroom-grades.unavailable` with Google's error codes only.

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

### Harbor's administrator

Harbor's administrator is Marisol Vega (`prn_hb-school-admin`, district admin). Her only sign-in is
the deployment owner's own Access identity, linked when the district was first configured
(`DISTRICT_CONFIG` directory seed). Present the administrator by signing in with that identity.
Access emails the code to the owner, so an agent needs the owner to hand it the code each time.

A test mailbox such as admin@agents.gmac.io **cannot** become Harbor's administrator, and should
not:

- Harbor is a roster district (`external:oneroster`), so the directory seed is read once and
  ignored after that.
- The operator's identity-link route refuses administrators and district-scoped roles.
- An administrator is linked only by an existing administrator approving an identity request.

Signing in as admin@agents.gmac.io answers `/api/me` with `unauthenticated` and an
`unlinkedSignIn`. That is correct; don't work around it. Northfield is different: there,
admin@agents.gmac.io is already linked to one of the co-op's administrators (Admin2).

Role checks, with one Access cookie per role (owner as administrator, teacher@ as Kwame Asante,
student@ as Nia Fontaine). Verified 2026-11-15:

| Request | Administrator | Teacher | Student |
|---|---|---|---|
| `/api/me` | 200 Marisol Vega | 200 Kwame Asante | 200 Nia Fontaine |
| `/api/admin/health`, `/api/admin/offerings` | 200 | 403 | 403 |
| `/api/teacher/offerings` | 200 | 200 | 403 |
| Marine Science (Kwame's) roster and gradebook | 200 | 200 | 403 |
| Math 7 (Ruth Delaney's) roster | 200 | 404 | 403 |
| `/api/student/offerings`, Marine Science activities | 403 | 403 | 200 |
| Math 7 activities (Nia not enrolled) | 403 | 403 | 404 |

The 404s are deliberate: a class a person doesn't teach or take is answered as if it didn't
exist, so it can't be discovered. Rerun the table with `curl -s -o /dev/null -w '%{http_code}'`
and each role's cookie. A changed cell is a regression.

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
