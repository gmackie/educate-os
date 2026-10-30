# Gatekeeper Clever

Connects Clever to Gadgets (SCHO-282). A user signs in with Clever; agents then reach their
district's class records as that user may see them: the sections they teach or are enrolled in,
rosters by name and grade level, and the assignments and grades of each section's learning
management system (Google Classroom, Canvas or Schoology) through Clever LMS Connect. Every change
waits for a person's approval, and reads show it as made in the meantime.

## Resource types

| Card | Resource | URL | Binding | Session |
|---|---|---|---|---|
| Clever profile | Clever profile | `https://api.clever.com/me` | `CLEVER_PROFILE` | `CleverProfileSession` |
| Sections you teach | One section you teach | `https://api.clever.com/sections/:sectionId` | `CLEVER_SECTION` | `CleverSectionSession` |
| | Sections you teach | `https://api.clever.com/me/sections` | `CLEVER_TEACHER` | `CleverTeacherSession` |
| Your classes | One class you are in | `https://api.clever.com/enrolled-sections/:sectionId` | `CLEVER_STUDENT_SECTION` | `CleverStudentSectionSession` |
| | Your classes | `https://api.clever.com/me/enrolled-sections` | `CLEVER_STUDENT` | `CleverStudentSession` |
| Every section in your district | Every section in your district | `https://api.clever.com/district/sections` | `CLEVER_DISTRICT` | `CleverDistrictSession` |

No URL matches another type's pattern, but each card still declares its narrower type first. None
is separately grantable: the one sign-in covers them all, and what each reaches is decided on every
call. The teacher and student cards use a `HierarchyPicker`: "all of" the root is the whole-role
type, a section is the one-section type, and a known resource URL pre-fills it.

## Credentials

- **Identity.** Connecting is a Clever sign-in: OAuth 2.0 authorization code with PKCE against
  `<CLEVER_OAUTH_BASE>/oauth/authorize` and `/oauth/tokens`, then `<CLEVER_API_BASE>/userinfo`. It
  only proves who signed in. The account Durable Object keeps the Clever user ID and district ID,
  confirmed against the district's records, and drops the sign-in's tokens, which are never used for
  data. A reconnect must sign in as the same user and is staged until the Workshop commits it.
- **Data.** Every read and LMS Connect write uses the district's district-app token, from the
  `CLEVER_DISTRICT_TOKENS` secret: a JSON object of Clever district ID to bearer token. Agents never
  see it. A district with no token there cannot connect.

## Scoping

Decided per call, against the district's own records, in `src/clever-access.ts`:

- A teacher's section must list the user in its `teachers` (or `teacher`).
- A student's section must list the user in its `students`.
- The district-wide connection needs `roles.district_admin` on the user's record. It is checked in
  `describe()` (so nobody else can grant it), on every session start, and on every call, through a
  user-record cache of one minute.
- Anything else answers not-found, exactly as a record that does not exist.

Rosters return ID, name and a student's grade. `src/clever-api.ts` parses records field by field, so
email, credentials, contacts and demographics never leave it, whatever the district's data holds.

A student sees their own sections, those sections' teachers, the assignments posted through this
gatekeeper, and their own submission; its points and comment only once the work is returned.
Classmates are never listed.

## Assignments

LMS Connect has no listing of a section's assignments, and only assignments created through this
gatekeeper are visible to agents. The `CleverDistrictLedger` Durable Object, one per district named
by its Clever ID, registers each one when its creation is applied. Teachers and administrators list
and grade the section's registered assignments (so co-teachers share them); students see the same
list as the work EducateOS posted.

## Approvals and simulation

`createAssignment`, `setGrade` and `turnIn` are submitted for approval and applied only in
`applyAction`, which re-checks the user's place on the roster (or their administrator role) first.
Until then a creation is listed as `pending:create:{n}` with `pending: true`, a grade is shown as
given with `pending: true`, and a turned-in submission reads `submitted`. A grade must be between 0
and the assignment's `pointsPossible`, for a student on the roster, and its comment goes to LMS
Connect as `grade_comment`. Creating is claimed before it is sent, since LMS Connect takes no
request ID; grading and turning in are safe to apply again.

The teacher session's `listTools`/`callTool` call the same operations by name; a change answers
`awaiting-decision`.

## District audit log

Every read and change through the district-wide connection is appended to the district's
`CleverDistrictLedger` audit table: the administrator's Clever user ID, the action
(`read:roster`, `request:set-grade`, `applied:set-grade`, `rejected:set-grade`, …), the records by
Clever ID (`section:<id>/assignment:<id>/student:<id>`), and the time; and logged as
`clever.district.audit`. A read is recorded after its observation is authorized and before its data
is returned, and a failed write fails the read. No token, body or student data beyond IDs is
recorded.

## Observers

See `docs/observers.md`: one section is strategy B (the observer must teach it too), all a
teacher's sections strategy C (tracked by section), and the profile, student and district bindings
strategy A.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | secret | The Clever app's OAuth client. Its redirect URI is `{PUBLIC_BASE_URL}/gatekeeper/clever/oauth`. |
| `CLEVER_DISTRICT_TOKENS` | secret | JSON map of Clever district ID to district-app token. |
| `CLEVER_API_BASE` | var | Default `https://api.clever.com`. The Data API is `<base>/v3.1`, userinfo `<base>/userinfo`. |
| `CLEVER_OAUTH_BASE` | var | Default `https://clever.com`. |
| `CLEVER_LOGIN_HINT_FORM` | var | `"true"` asks who to sign in as before going to Clever and passes it as `login_hint`, for the demo's fake Clever, which has no sign-in page. Never needed against Clever. |

Locally, `pnpm dev-server` maps `CLEVER_CLIENT_ID`/`CLEVER_CLIENT_SECRET` to the client, and passes
the other four through from the shell or the root `.dev.vars`.

LMS Connect needs a Clever Complete agreement. Built to Clever's published v3.1 OpenAPI file and
tested against `CleverDataFake` and `OidcFake` (`clever` preset) from `@educateos/provider-fakes`,
not against Clever.

## Tests

`pnpm --filter @educateos/gatekeeper-clever test:run`: Node tests for URL grammar, the
configurators, tool arguments and record parsing; workerd tests for the sign-in, scoping and
privacy, approvals and simulation, tools, the audit log and observers, all against the provider
fakes installed at `fetch`.
