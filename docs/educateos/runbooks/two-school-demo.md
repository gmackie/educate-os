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
second turned in for review. Reruns change nothing. A grade a teacher has since edited is kept, and
so is review work a teacher has since graded and returned (as the Workshop's Classroom grading does).
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

## Presenter walkthrough

Use a separate browser profile, or a private window, for each sign-in, since Access keeps one
session per browser. Sign in with the address and Access's emailed code. Agents read the codes
from agent-inbox (`access-sign-in.ts`); the owner's code goes to the owner's own mailbox. A session
lasts about a day. Check who you are at `/api/me` before presenting.

| School | Sign-in | Presents as |
|---|---|---|
| Harbor | the owner's own email | Marisol Vega, district administrator |
| Harbor | `teacher@agents.gmac.io` | Kwame Asante (Marine Science, US Government) |
| Harbor | `student@agents.gmac.io` | Nia Fontaine (Marine Science, Composition) |
| Northfield | `admin@agents.gmac.io` | Admin2, a co-op administrator |
| Northfield | `teacher-k2@`, `teacher-35@`, `teacher-68@`, `teacher-912@` | Daniel Yazzie, Fatima Al-Sayed, Hannah Kowalski, Morgan Lee |
| Northfield | `student-k2@`, `student-35@`, `student-68@`, `student-912@` | Mateo Delgado, Abena Mensah, Kofi Mensah, Lucía Delgado |
| Northfield | `guardian-rosa@`, `guardian-kwame@` | Rosa Delgado (Mateo, Lucía), Kwame Mensah (Abena, Kofi) |

`canvas-grade-return.ts` borrows the `teacher-*` sign-ins and links each one back when it ends.
Check `/api/me` if a run was interrupted.

### Harbor, on Google Classroom (harbor.educateos.io)

1. **Administrator.** The dashboard (`/admin/`) shows 6 students and 3 staff in 4 classes, with
   Google Classroom as the roster. Under Roster sync, imports wait for an administrator's preview.
   Point out that teachers and students cannot open these pages (403).
2. **Teacher, Kwame Asante.** My classes (`/teach/`) lists Marine Science and US Government. Open
   Marine Science, then Gradebook. Under the official grid, **From Google Classroom** shows each
   student's Classroom grades for both seeded activities:
   - Tide Pools: Nia 9, Owen 7, Pia 8.
   - Coastal Water: Nia 8 and Pia 9 returned, Owen turned in and awaiting review.

   These grades are read live; EducateOS writes nothing to Classroom here.
3. **Student, Nia Fontaine.** Home lists Marine Science and Composition. On Marine Science
   (`/courses/<offering>`), From Google Classroom shows only her own returned grades: Coastal Water
   8/10 and Tide Pools 9/10. Opening a class she is not in answers as if it did not exist.

### Northfield, on Canvas (northfield.educateos.io, canvas.mackie.house)

1. **Administrator.** All classes lists 15 classes:
   - the twelve showcase classes, three per band (K-2, 3-5, 6-8, 9-12);
   - a spring Biology I section;
   - the co-op's own Earth Science and a standards-check ELA class.
2. **Teacher, Hannah Kowalski (`teacher-68@`).** My classes shows English 8 · Period 2. Its
   gradebook holds the grades she approved. Each one is already in the Canvas course's
   "[educateos-approved] …" column, sent by the teacher who approved it. An administrator cannot
   send a teacher's grade.
3. **Student, Kofi Mensah (`student-68@`).** Home lists English 8 with its announcement. Its
   modules are Argument Writing, Theme, Memoir and Poetry. **Grades** (`/grades`) shows "Phones in
   the Classroom" at 15 of 16, the same 15 that his own Canvas submission shows.
4. **Canvas.** The EducateOS Demo account (account 3) has the same twelve courses, with modules,
   discussions, quizzes and learners' submissions. In every course, the first module holds two
   EducateOS activities that open from Canvas over LTI 1.3 as the person who launched them. Each
   approved grade also shows in the learner's own Canvas grades.

   To show a person's own Canvas view, open it with `canvas-open-as.ts` (below) in a separate
   browser profile, signed in to Access. Kofi's English 8 grades (Canvas course 10) show
   "[educateos-approved] Phones in the Classroom" at 15/16:

   ```sh
   node scripts/demo/canvas-open-as.ts prn_nf-student-kofi /courses/10/grades
   ```

   Canvas's **Act as user** does not work here, and must not be made to. Account 3 is its own
   root account, but canvas.mackie.house answers as the PlayTrek root account (1), where the demo
   administrator has no rights. Granting it rights there would hand it the PlayTrek school.
   `canvas-open-as.ts` mints a single-use session token for the person in the Canvas console (as
   the acceptance scripts do) and passes the sign-in link to the browser without printing it. The
   synthetic people have no passwords.

### Northfield's families (guardians)

A guardian sees each of their children's classes, but only what the teachers have shared with
that child. They never see the child's own work or personal space. Verified 2026-11-15 (SCHO-426):

1. **Rosa Delgado (`guardian-rosa@`)** goes straight to **Family**, which has a tab for each child.
   - Lucía: Biology I · Period 2, graded so far 6 of 8 points. The class page shows the teacher's
     announcement ("Lab day Tuesday: closed-toe shoes") and each activity's due date, with "No
     feedback yet" until the teacher shares some.
   - Mateo: Grade 1 Reading Foundations and Grade 1 Mathematics, 10 of 10 points in each.
2. **Kwame Mensah (`guardian-kwame@`)** has the same view for Abena (grade 4) and Kofi (grade 8).
3. **What a guardian cannot reach:**
   - Another family's child (Rosa asking for Kofi, or Kwame for Mateo) answers 404, as if the
     child did not exist.
   - Teacher, student and administrator pages answer 403.

| Request, as Rosa | Status |
|---|---|
| `/api/guardian/children` | 200: Lucía Delgado, Mateo Delgado |
| `/api/guardian/children/prn_nf-student-lucia/offerings` | 200 |
| `/api/guardian/children/prn_nf-student-kofi/offerings` | 404 |
| `/api/teacher/offerings`, `/api/student/offerings`, `/api/admin/health` | 403 |

### The AI workspace (Workshop, `/ai` on either district)

As Hannah at Northfield, open **AI workspace**. The home page greets her by name and offers a
model the district funds. The workspace "Coastal Water Quality Assignment Grade Updates" shows the
teacher-approved Classroom grading flow (SCHO-402):

- The agent proposed grades for Kwame's Marine Science course through Hannah's connected Google
  account.
- Hannah approved Nia's 8 and Pia's 9, and they were returned in Classroom.
- She denied Owen's grade, so his work is still awaiting review.

To close the loop, show the same grades in Harbor, in Kwame's gradebook and in Nia's own class
page.

## Live evidence, 2026-11-15

Every check below was a read-only `verify` against the live systems, with reports under
`/tmp/scho415/` (mode 600). Each report shows 0 problems.

- **Canvas seed** (`seed-canvas-demo.ts verify`): 32 people, 12 courses, everything as seeded.
- **Canvas participation** (`canvas-participation.ts verify`): 46 submissions, 32 teacher reviews,
  12 discussion entries, 22 quiz attempts, 12 isolation checks.
- **LTI launches** (`canvas-lti-acceptance.ts launches`): 24 of 24 accepted. In each of the 12
  courses, the teacher and a learner opened EducateOS from Canvas course navigation, and each was
  admitted as themself in that course's offering.
- **Grade return** (`canvas-grade-return.ts verify`):
  - 40 teacher-approved grades in 12 courses are in Canvas.
  - All 40 were read back by their own learner.
  - 19 of 19 administrator publish attempts were refused.
  - Every presenter was linked back afterwards.
- **Northfield showcase** (`seed-showcase.ts verify`): 35 personas, 12 of 12 sample courses
  installed; each band has 3 classes and 50-61 activities.
- **Harbor seed** (`seed-harbor-classroom.ts verify`): 4 courses, 8 app-owned activities.
- **Harbor learner work** (`harbor-classroom-work.ts verify`): 20 submissions (12 returned, 8
  awaiting review) and 6 isolation checks.
  - Coastal Water for Nia and Pia now counts as returned by their teacher, since the Workshop
    grading demo returned them, and verify accepts that.
- **Sign-ins**: every address in the walkthrough table resolved through `/api/me` to the person
  listed. Harbor's role table is under [Harbor's administrator](#harbors-administrator).
- **Browser**, headless, signed in as each person: Harbor's administrator dashboard, Kwame's
  Marine Science gradebook with From Google Classroom, Nia's Marine Science page, Hannah's My
  classes and her AI workspace home. Each loaded with no console errors.
- **Deep links** (`canvas-lti-acceptance.ts deep-link`, SCHO-419): all 12 courses now have two
  EducateOS activities in their first module.
  - The ten new courses each answered `linked`. A learner's launch of each item opened exactly the
    activity its teacher selected, and the learner could not reach the picker.
  - A rerun of all 12 answered `reused` with 2 of 2 items opening and 0 problems, so nothing was
    added twice.
- **Canvas as a learner** (`canvas-open-as.ts`): opened as Kofi Mensah on English 8 grades, in
  English, showing 15/16 for the approved column.

Grade return differs by school: Harbor's grades are read from Classroom, not sent to it.
Northfield's go to Canvas through AGS.

### Canvas showing Arabic (fixed 2026-11-15)

Node's `fetch` sends `Accept-Language: *`, and Canvas resolves the wildcard to its first locale,
Arabic. Requests from the demo scripts therefore did two things:

- They recorded `ar` as the browser locale of 31 demo users, which Canvas uses when neither the
  user nor the account chooses a locale.
- They named each course's default assignment group "المهام".

The fix has three parts:

- Account 3's default locale is `en`.
- Those users' browser locale was cleared, and the 12 groups were renamed "Assignments".
- The scripts' Canvas clients now send `Accept-Language: en-US`.

If Canvas pages show Arabic again, look for a client that sends no language.

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
