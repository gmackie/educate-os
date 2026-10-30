# Full EducateOS demonstration and the Google → Clever explanation

Meeting: **3pm**, Eastern assumed. Calendar date and attendee mix remain unconfirmed.
Use a 30-minute product path with a 15-minute technical appendix available. The shorter 20-minute
Google-focused path in presenter.md is still available when the slot is tight.

## The central explanation

> EducateOS supplies the district application, teaching tools, learning workspaces, reusable
> gadgets, policy and controlled actions. Google currently supplies a testable identity provider,
> Classroom course memberships and learning APIs, plus separately granted Workspace resources.
> We expect Clever to supply district identity, school/section membership and launch context
> through its approved products. We want to validate that expectation with you. We do not assume
> that Clever's identity or roster API replaces Google's document, assignment, submission or grade APIs.

Present this as three cooperating layers, each with a named responsibility:

| Layer | Responsibility | Where to demonstrate it |
|---|---|---|
| District foundation | Identity links, schools, terms, offerings, enrollments and role-scoped access | Real EducateOS applications in the synthetic district demo; Clever/Google adapters separately documented |
| EducateOS experience | Administrator console, Teacher Studio, Learning Home, guardian view, Content Studio/activities, versioned work, grade/feedback release, Workshop agents, gadgets and blueprints | Four-persona product demo plus real Google-connected Workshop examples |
| External learning services | Native files, provider-owned coursework/submissions, approved grade return and communications | Real Google evidence and scoped connector resources; another LMS can fill supported seams |

## Open these before the meeting

- The kit's `district-demo.html`: **the actual existing administrator, teacher, student and guardian
  applications**, compiled with the real district service over in-memory synthetic stores. It is
  self-contained, has no external API calls, has no real authentication, and has AI off. A persona
  selector supplies test identities. State lasts only for the current page until reset/reload.
- https://educateos.io/demo/ is the corresponding public product demo, subject to its current live
  deployment. It uses the same synthetic scenario; it is not a production district login.
- The saved Google-connected Workshop Formats Lab and separate learner Google Classroom session
  from presenter.md. Those are **different fixtures/accounts** from Northfield in the product demo.
- The presentation, `google-clever-bridge.html`, six PDF/PPTX handouts and the companion source.

Open the synthetic district **once** and use Switch persona. A new tab/reload creates a different
in-memory district. Do not reset between submission, teacher review and learner feedback.

## Demonstration script: show the whole product first

| Time | Product action | What to say about data and responsibility |
|---|---|---|
| 0–2 | Explain the three layers; open the district demo. | “This first segment is synthetic and runs in the browser. It shows our real district applications. The Google-connected segment follows separately.” |
| 2–5 | Choose District administrator (Avery Admin). Open classes and the English 9 Period 3 roster; use Things to try. Inspect available people/policy/settings views without changing them. | “A district controls which people belong to which classes and what each role may do. In a Clever district, approved roster records would populate this directory through our import pipeline.” |
| 5–8 | Switch to Sam Rivera, English 9 teacher. Open the class, gradebook, activities and resources. Show the school-day essay and Reading reflection. Post a brief synthetic announcement. | “EducateOS provides the teaching workflow and versioned activities. A roster provider establishes teacher/class membership; it does not author these lessons.” |
| 8–11 | Switch to Amara Okafor, Grade 9 student. Open English 9; show the published work and announcement. Open Reading reflection, fill Plan with an outline, Draft with an original paragraph, and Revise with an improved paragraph. Click each step's Save, then Submit → confirm Submit → keep the receipt and click Done. | “Learners work in their own scope. The submission captures a version of their work; it is not an email attachment or an AI answer.” |
| 11–14 | Switch back to Sam. Open the new reflection submission; read it, add feedback, enter Points 4 and Out of 5, click Approve official grade → Yes, approve official grade, then Share feedback with student. | “The teacher decides the result and when feedback becomes visible. This segment records an EducateOS grade; we will show a Google grade-return transaction in the connected segment.” |
| 14–16 | Switch to Amara and read released feedback. Switch to Grace Okafor, the guardian; open Amara's English class and its released grades. | “The student sees released feedback; the approved guardian relationship exposes only its allowed child/course view. Guardian access is an EducateOS invitation/approval flow, not something we have proven Clever supplies.” |
| 16–21 | Switch explicitly to the real Google fixtures. Use the teacher code-mode prompt to read the weathering assignment/rubric and compare it with the refreshed gadget. Show Science and Algebra formats and exports. | “These next values come from an authorized Google course. The agent and application use the same connector capability. Google supplies the source records; EducateOS produces the experience.” |
| 21–24 | Show the preserved Google submission/returned 18/20 and its recorded EducateOS teacher approval. Show the personal student companion design/source; run it live only if separately rehearsed. | “Google accepts authorized, approved actions and supplies readback. The 18/20 is a real historical provider result. Our new EducateOS student turn-in path still needs its live OAuth rehearsal.” |
| 24–27 | Open the Google/Clever responsibility explorer. Walk through identity → school/term/class → membership → safe capabilities. | “These are the specific foundation records and claims we believe Clever can make available; please correct the mapping and confirm the product/consent requirements.” |
| 27–30 | Show the two sandbox errors, access requests and pilot contract. | “We have adapters and harness evidence. We need the enabled API version, roster product/fields, roles, district sharing and events contract to prove the real integration.” |

If an expected UI operation is not visible, use the built-in Things to try and existing seeded
school-day essay/feedback. Do not claim a click succeeded without the resulting record. The
seeded result remains a fallback. The offline package execution check independently runs the exact
new reflection → receipt → comment → official 4/5 approval → feedback release → learner/guardian
readback sequence through the compiled UI with all network fetches refused. Native service tests
also verify teacher-route and unrelated-child denials.

## How Google's current integration delivers each district ingredient

### 1. Sign-in is not an enrollment

Google OpenID identifies the account with issuer and stable subject. EducateOS resolves a principal
through district-scoped identity links; an email is display metadata. Course roles come from
Classroom membership, not from an assumption that every signed-in Google user is a teacher.
The exact Google sign-in/roster identifier association still needs full live district acceptance.

Clever's proposed equivalent is its verified user identity plus the configured district claim.
Our implementation supports `multi_role_user_id`/`sub` and matching district fields. We need
Clever to confirm their actual token/userinfo claims and a multi-role fixture. A principal can have
both a verified Clever identity and a Google identity; administrator-confirmed linking must not
merge accounts merely because their emails match.

### 2. “Course” does not mean the same object everywhere

Google Classroom course is the actual taught class. EducateOS's Google roster adapter reads
courses plus teacher/student lists. Classroom has no full district school/term/catalog-course
model in that path, so EducateOS configuration supplies schools, term dates and grade bands.
Explicit selected-course lists keep two districts sharing one Workspace domain separate.

Clever can potentially provide a richer district foundation: districts, schools, terms, catalog
courses, sections, users, and section teacher/student membership. The adapter maps Clever's
section to EducateOS's offering and its membership lists to enrollments. Confirm the actual fields,
secondary teachers, staff and multi-role handling with Clever. More complete roster records do
not grant access to Google files or permit teacher grade writes.

### 3. Import turns provider records into local authorization context

Both roster adapters feed the shared preview/quarantine/apply pipeline. Administrators can inspect
proposed changes; malformed or uncertain data must not silently replace the last good directory.
Large removals can be held for an exact decision. Stable source IDs preserve identity despite
renamed people/classes. Google uses complete polling in this roster path; Clever's implemented
events path could add membership deltas once entitled. Event permissions and expiry semantics
remain questions for Clever, not a demonstrated live result.

### 4. Workshop resources express authority more narrowly than an account

Google OAuth may authorize several service scopes, but a Workshop binding grants a specific
course/document/folder/calendar. The agent and gadget only receive that resource capability.
The teacher course includes roster/submission/grade authority; the personal student course exposes
published work, own state and approved turn-in only. A teacher display filter does not replace a
student boundary. A blueprint shares source/requirements; each learner must supply their own grant.

For Clever, the district token and roster import belong in the district integration service, not
in a student gadget. Its district/class membership can inform EducateOS policy. Clever SSO, roster
consent and native Google OAuth are separate authorization decisions.

### 5. Google is also a learning/content provider; Clever's roster is a different product surface

Classroom supplies coursework, materials, personal submissions and total grades. Google's project
ownership rule limits writes to this app's coursework. Teacher approval and provider readback are
required by the demonstrated EducateOS flow. Google Docs/Sheets/Slides/Drive/Calendar/Chat/Gmail
are additional separately scoped services; implementation exists, while many teaching recipes
still need live acceptance. The Formats Lab's local quiz does not persist responses or pass grades.

With Clever alone, EducateOS can provide native district activities, student work and teacher
feedback after roster/identity onboarding. Google-native file editing or Classroom grade return
still needs Google; a Canvas/Schoology/LTI workflow needs its own supported integration. Ask Clever
which partner products offer any additional learning/context APIs, and document those separately.

### 6. Operational control stays with the district

The architecture keeps educational records in the district's account or explicitly approved
provider. Optional installation/marketplace services do not confer standing access to classroom
data. Roles, approved connections, action policy, activity versions and feedback release belong to
EducateOS's district runtime. AI governance and budget controls exist in the platform, but the
synthetic product demo does not run AI; live agent behavior is shown only in the Google Workshop.
Use the architecture/runbooks as design evidence; do not describe every deployment/recovery gate
as production-accepted just because the synthetic applications run.

## What we need Clever to confirm in the room

1. Are identity, district/school/section/user/term/catalog-course data and field sharing available
   to this app under the intended partner product? Which roles and scopes/entitlements are needed?
2. Can the app use v3.1? If v3.0 is the supported contract, which schema/endpoints differ and how do
   you recommend upgrading the existing adapter? Fix version and entitlement as separate gates.
3. How do district approval, school filtering, multi-role users, staff/secondary teachers, section
   membership and removal events work for this sandbox? Can we get fixtures for each?
4. What is the stable identity key connecting SSO to the roster? What claims survive the launch
   path? How should a district map a Clever principal to a separately authorized Google account?
5. Which launch URLs and role/district parameters are supported, and what review is required?
6. Are events available; what are retention, expired-cursor and full-resync rules? What quotas,
   token rotation and revocation controls should the district expect?
7. Which requested items fall outside Clever's identity/roster/launch products, and which actual
   LMS/content partner should provide them? No implied Clever coursework or grade-write claim.

## Evidence labels for every stop

- **Synthetic product execution:** real EducateOS apps and district service in the browser; no
  vendor calls, real SSO or AI. Supports showing product interactions, not provider conformance.
- **Historical Google acceptance:** recorded real OAuth/code-mode/gadget/approval/grade-return
  evidence dated 2026-10-28. A saved screenshot is not a new API response.
- **Current live read:** only after refresh succeeds against the connected provider, with source
  IDs/fetch time visible. Authentication and Google ACLs remain separate from Clever membership.
- **Implemented / awaiting live acceptance:** personal student path, remaining Plus/recovery and
  district sync gates. Present their source/tests or plan, with the label intact.
- **Clever assumption to confirm:** supported product/data contract, version, fields, role claims,
  launch and events. Current locked-down sandbox has not proved a complete real roster sync.

This makes the full platform demonstrable while giving Clever a precise path to help us validate
its district foundation, without describing Google's entire Workspace product suite as a Clever API.
