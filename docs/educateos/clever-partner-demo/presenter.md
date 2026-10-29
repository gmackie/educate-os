# Presenter runbook

## Meeting outcome

Meeting time: **3pm**. Assume Eastern (America/Detroit) for preparation; the calendar date and
attendee mix are not confirmed. Use the [30-minute full product script](full-system-demo.md) as the primary path.
The 20-minute Google-focused path below is the shorter option; keep the technical appendix ready.

Show the full district product and the Google-backed teaching workflow, then leave with a named Clever technical owner, the supported
API version, a sandbox entitlement plan and a date for a joint test. Opening statement:

> EducateOS turns authorized school data into instructor-built applications and agent workflows.
> Our real district apps show administrator, instructor, learner and family workflows using synthetic data.
> Google lets us show separately authorized assignments, controlled actions and several teaching formats.
> We want Clever to provide the identity, enrollment and launch foundation for the same experience
> across schools, with learning content and submissions supplied by the appropriate LMS connector.

Do not ask for unrestricted access to live children or production districts. Ask for an approved
synthetic sandbox and the products, scopes and district-sharing controls Clever supports.

## Accounts and entry points — presenter only

- Workshop: https://schoolos.gmac.io
- Saved Formats Lab: https://schoolos.gmac.io/workspace/6803f77edf00585d77d65d58c46267e3f09fb0905131571eaf6658e299532c74?w=13
  Open without `chat=`. The saved gadget works; an older conversation preview had an unresolved
  internal error. A failed old preview does not establish that source or a new OAuth session works.
- Teacher Dana Whitaker: `cv-teacher-whitaker@gedu.demo.educateos.io`.
- Student An Nguyen: `cv-student-an@gedu.demo.educateos.io`. Use a separate signed-in profile.
- Science course `895811762849`; published work `896258346598`; rubric `896259887221`; 20 points.
- Algebra course `896141390025`; published work `896261051224`; 10 points.
- An's weathering submission: `Cg4I8ZmlsYoaEOacpOmKGg`; Google user `109086804245677102525`.
- District consoles: https://harbor.educateos.io and https://cedarvalley.educateos.io.
  Healthy public endpoints are not proof of an authorized admin or completed roster setup.
- Shared Clever portal entry: https://educateos.io/clever/launch.
  Implementation exists; do not claim current live Clever login acceptance from this URL alone.

Passwords, MFA and OTPs stay in their normal browser prompts. Do not open keychain output,
deployment secrets, tokens or credential configuration on the projected screen.

## Rehearsal checklist

1. Rehearse the native district cycle in `district-demo.html` using [full-system-demo.md](full-system-demo.md).
   Use the same tab for all personas. Submit Reading reflection as Amara, review as Sam, approve
   4/5, share feedback, and read the result as Amara and Grace. Reset only when finished.
2. Open the saved teacher workspace; refresh Science and Algebra and verify fetch times advance.
   Compare the actual title, work ID, publication state and points with the connector response.
3. Check every format: worksheet; slide advance/back and arrow keys; quiz wrong/correct/reset;
   discussion start/pause/reset and teacher notes. Repeat class switch and narrow-screen layout.
   Quiz answers are local practice, not persisted assessment or grade passback.
4. Open all six bundled exports locally. Inspect source reference/time; Science has nine slides,
   Algebra seven. Use these snapshots if Google/Workshop is unavailable.
5. Open An's own Google Classroom session and verify the retained 18/20 result. Do not resubmit,
   overwrite the grade or delete its rubric. Show the historical screenshot if the session expires.
6. Before choosing a new live mutation, create a **separate synthetic rehearsal assignment** through
   the existing teacher approval flow. Record its ID. Reject one draft request and verify absence;
   approve one draft request and verify exactly one committed record. Do not repeat a request when
   a timeout leaves the outcome uncertain: refresh/read Google first.
7. If student OAuth/authoring is available, install the personal companion in the student's own
   EducateOS workspace as described in its README. Read published work and own state. Prepare an
   answer/attachment in Google Classroom; request and approve turn-in; read TURNED_IN from Google.
   Use a second learner, non-member, other-course ID and revoked user for denial checks. Record
   exact identities, resource URL, gadget revision, approval decision and timestamp. This entire
   EducateOS student rehearsal remains a gate until actually recorded.
8. Blueprint rehearsal: publish committed personal companion source with only the student binding;
   instantiate a fresh copy as a different student and require their own Google connection. Check
   code update preview/accept and that no binding credentials or personal response data travel.
   Students cannot collaborate on a personal student resource; use independent copies.
9. Verify roster preview/apply/scheduled runs only after authorized district admin setup works.
   Owner email PIN restored the existing Harbor administrator on 2026-10-28; that run then found
   a roster-issuer trust/configuration dependency. Renew the authorized admin session and verify
   the supported preview/apply state. A Google admin is not automatically a Harbor admin.

Record PASS/BLOCKED/FAIL with UTC time and evidence location. **Do not change a planned gate to
PASS just because unit tests pass.** If a gate fails, omit that live step and state the limitation.

## 20-minute live path

| Time | Action and narration | Proof / fallback |
|---|---|---|
| 0–2 | Frame the platform: named resource capabilities → code-mode reasoning → gadgets → approved actions. | Presentation flow. No unattended grade changes implied. |
| 2–5 | Use teacher read prompt to compare Science assignment and rubric with the live gadget. | Real provider values and advancing fetch time. Otherwise label bundled screenshots historical. |
| 5–8 | Show the recorded teacher approval and real student attachment/returned 18/20. | EducateOS approved grade/return + student Google UI; it is not an EducateOS student-turn-in claim. |
| 8–11 | Show Science investigation, then Algebra worked example through worksheet, slides, quiz and discussion. | Eight format views; six portable exports. Distinguish gadget slide/PPTX output from native Google Slides editing. |
| 11–13 | Explain blueprint reuse and personal student companion. Show live only if rehearsed. | Separate student capability; source and tests otherwise. Do not share the teacher workspace. |
| 13–17 | Show the Clever access matrix and two recorded errors. | Version 403 versus token-product 401; ask which configuration/program resolves each. |
| 17–20 | Agree a synthetic two-class/two-district pilot, evidence and owners. | Read back API version, products/scopes, fixtures, district consent process and next test date. |

For a ten-minute slot, use one Science format, one Algebra slide and the returned-grade proof;
reserve four minutes for Clever requests. For engineers, expand to schemas, event cursor behavior,
partial failure, deletion holds, identity claims and token rotation. For partner staff, emphasize
teacher creation, reusable templates and the least-privilege pilot outcome.

## Exact Clever conversation

The last real probe was **2026-10-27**, recorded in SCHO-211, against `educateos-dev` and its sandbox
district (`6ade4156…`). It is not a freshly retried request today.

| Priority | Ask Clever | Evidence / successful answer |
|---|---|---|
| P0 | Confirm our app's enabled Data API version. Can v3.1 be enabled, or is v3.0 the supported target? | v3.1 returns 403 `version not supported`; adapter pins v3.1. We need an explicit version and access plan before changing the client. |
| P0 | Enable the appropriate roster product and district-approved sharing for districts, schools, users, terms, courses and sections. Confirm collection and field availability individually. | v3.0 `/districts` 200; schools/users/sections/terms 401 `Resource is not available for token`. Current basic identity scopes are insufficient. Courses have not been established available by this probe. |
| P0 | Provide synthetic district admin, school admin, two teachers, two students in a shared class, a non-member and a multi-role user, plus a second isolated district. | Stable user and district IDs; memberships/roles; documented login paths; no real student data required. |
| P0 | Verify SSO claims and partner launch setup, including `multi_role_user_id`, district, redirect/launch registration and role selection. | Real role logins map to roster principals without email matching; wrong-district claims denied; portal launch reaches the intended district. |
| P1 | Confirm events entitlement, event types, retention, expiration response and recovery rules. If unavailable, agree complete-sync cadence. | `/events` 401. Seed → membership change → delta → revoke; expired cursor triggers safe full recovery without premature removals. |
| P1 | Explain district consent, field sharing, activation/revocation controls, test tenant resets, quota/rate limits, token rotation and support path. | A documented contract and reproducible denied-access cases; revoke removes access and preserves prior good roster state. |
| P1 | Name products/programs for additional LMS handoffs, content or grade workflows, if any. | Identify who owns coursework/grades and any separate partner review. Do not infer a Clever Data API grade-write endpoint. |
| P1 | Name technical and partner owners and agree a joint validation session. | Written version/scopes/fixtures checklist, responsibilities and target date. |

The current scope names are `read:district_admins_basic`, `read:school_admins_basic`,
`read:students_basic`, `read:teachers_basic`, `read:user_id`. Ask Clever for **their supported
product/scope names** rather than inventing a broader OAuth scope string.

## Pilot acceptance contract to agree

1. Read complete synthetic district roster with paging; preview and apply without duplicate people.
   Stable IDs survive email/name changes; teachers/students have the correct class roles.
2. Log in each role and launch to the right district. A second learner and a non-member cannot read
   another learner's work. A second district cannot access the first district's principals/resources.
3. Add/remove an enrollment and observe events delta or agreed full refresh. Uncertain/large removals
   are held for exact approval. Failed imports preserve the last successful roster/cursor.
4. Connect the authorized Google teacher and individual learners to their own enrolled courses.
   Produce a reusable lesson, create coursework with teacher approval, prepare student work, request
   turn-in, approve grade/return and read provider state back. Clever proves roster/launch; Google
   proves learning actions. These are distinct connector responsibilities.
5. Revoke access, expire/rotate a token, inject 429/outage and recover. No silent broadening, duplicate
   assignments/grades or cross-user data; show a truthful blocked state and successful recovery.
6. Keep an evidence record: app/product/API version, consented fields/scopes, synthetic principal
   IDs, deployed revision, run/action IDs, UTC time, expected/actual provider result and screenshots.
   Agree jointly which cases have passed before describing the pilot as validated.

## Current limits to say plainly

Full district identity/scheduled-sync acceptance, student EducateOS OAuth/turn-in, collaborator and
revocation recovery, Plus rubric edit/delete/period mutation and Classroom add-ons remain open.
The 2026-10-29 tenant preflight read rubrics and grading-period settings and minted delegated tokens
for student/add-on scopes; preview eligibility endpoints returned 404. A delegated token is not a
working add-on, Marketplace installation, eligible license confirmation or user OAuth connection.
Google rubric-level grade publishing is unsupported by its API; total-grade return is supported.
The source inventory is implementation coverage; it is not a claim that every Google method ran live.
