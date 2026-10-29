# Teaching capabilities and the Clever access needed

Status at preparation, 2026-10-29. **Demonstrated** means historical real-provider/UI evidence in
the verification runbook. **Implemented** means source/automated coverage exists; it does not
claim a full live rehearsal. **Open** means missing implementation, configuration or acceptance.
The generated `google-api-inventory.json` lists current declared resource patterns, OAuth scopes,
interfaces and method signatures; counts are source inventory, not successful API calls.

| Surface / grant | Instructor and learner use | Evidence and boundaries | What Clever can enable |
|---|---|---|---|
| Classroom teacher / one taught course | Agent-grounded lesson briefing; app-owned coursework; submission review; approved total grade and return | **Demonstrated:** Science published assignment/rubric, real learner attachment, approved 18/20 returned; Algebra 10-point task; code-mode and gadgets. Teacher connection exposes roster/submissions; never a student grant. Only this project's coursework is visible/gradable through it. | Roster and launch context identify the teacher and course. Learning records/actions continue through Google or another LMS. |
| Classroom student / own work in one enrolled course | Published work/materials, own submission and approval-backed turn-in | **Implemented/deployed:** distinct API and new personal companion source. **Open:** real EducateOS learner OAuth and turn-in, second-user/revocation rehearsal. No roster, grades, answer authoring, file upload or collaboration. | Stable learner identity and section enrollment; separate role logins and negative fixtures. Clever SSO alone grants no Google OAuth authority. |
| Plus rubrics and grading periods | Criteria scaffolds, total-grade feedback, period organization | **Demonstrated:** rubric creation/read and total grade return. **Implemented:** rubric replacement/deletion and period replacement. **Open:** live mutation/recovery/unlicensed cases. Google cannot publish criterion-level rubric grades. | No equivalence assumed; ask whether Clever has any relevant separately contracted product or LMS partner path. |
| Classroom add-ons | Potential embedded assignment attachment/launch experience | **Open:** add-on implementation, project/Marketplace setup, teacher/student launch. Delegated scopes minted; eligibility preview endpoints returned 404. No functional add-on claim. | Confirm any supported Clever distribution/launch product and review program independently of Google Marketplace. |
| Drive account | Instructor resource discovery across accessible Drive/shared drives | **Implemented**, live teaching recipe unrehearsed. Metadata/search, read-only native file access; broad account visibility is unsuitable for a learner template. No generic upload/share/delete API. | Discovery/roster context can select approved class resources; Clever does not confer Google file ACLs. |
| Drive folder | Course resource library | **Implemented**, direct-child navigation and scoped search; learners still need native file permission. No implicit recursive crawl or ACL mutation. | Class membership can inform intended audience; verify consent and file access separately. |
| Drive exact file | Reading one selected resource | **Implemented**, exact-file metadata/native read-only access; no arbitrary file opening. | Stable resource associations, if a supported product provides them; do not assume content APIs. |
| Google Doc / exact document | Reading guide, individual worksheet, instructor feedback | **Implemented** native tab reads and approved Markdown edits/create-resource flow; live teaching/sharing unrehearsed. Native tables/smart structures have edit limits. Separate personal copies/Google ACLs for responses. | Identity/roster can guide setup. Docs content and edits stay with Google. |
| Google Sheet / exact spreadsheet | Synthetic lab data, calculations and analysis | **Implemented** bounded ranges/formats and approved change sets/create-resource flow. Live classroom privacy/approval readback open. Never expose a teacher gradebook to learners. | Class/role metadata can help choose authorized activities. It does not supply learner analytics or grade writeback automatically. |
| Google Slides / exact presentation | Native lessons, discussion prompts and learner presentations | **Implemented** native read/edit/create-resource flow, live teaching recipe open. Formats Lab's **demonstrated** slides/PDF/PPTX are a separate gadget renderer, not proof of native Google Slides edits. | Launch/audience context for the lesson. Native presentation authority comes from Google. |
| Calendar / one selected stable calendar | Class agenda, study planning, approved event writes | **Implemented**, live invitation/student-visibility recipe open. Whole-account availability requires explicit opt-in; no primary alias binding. | Term/section information may anchor schedules; calendar access is separately consented. |
| Chat account | Private instructor assistant across accessible conversations | **Implemented**, intentionally unshareable; live classroom recipe open. Keep out of student gadgets. | Identity only; no inferred access to conversations. |
| Chat conversation | Scoped class discussion/help | **Implemented**, observer membership must be verified; live multi-user/revocation acceptance open. | Enrollment is context, not a substitute for Chat membership. |
| Chat thread | Focused help thread or seminar question | **Implemented**, narrowed conversation authority; live teaching recipe open. Approved posting and subscription recovery need rehearsal. | Role-aware launch into an independently authorized thread. |
| Gmail / private or query/label scoped mailbox | Teacher communication assistant | **Implemented**, live teaching recipe open. Account-private content and send approvals; never part of a student lesson binding. | No email/message authority requested from Clever. |
| BigQuery / project optionally dataset/table | Controlled synthetic or approved aggregate exploration | **Implemented**, live classroom recipe open. Read-only queries and bytes/cost controls; no DML; resource scope does not anonymize rows. | District-approved metadata may inform cohorts. Any analytics product/data agreement must be confirmed separately. |
| Blueprint publication | Instructors share code/required binding shape; learners create personal copies | **Implemented** platform feature. Formats Lab source and personal companion included. **Open:** fresh two-student teaching-blueprint install/update acceptance. No credentials, storage or history included. | SSO onboarding and authorized roster context reduce setup; learner rebind still required. |
| District sync / identity | Preview, quarantine, apply, scheduled sync and held-removal approval | **Harness-tested** Clever complete/events and Google adapter paths. **Open:** full deployed real district/identity acceptance. Service principal and Google subject links must be verified. | Enable matching API version, full roster product/fields, consented district token, SSO fixtures and events or agreed complete-refresh fallback. |

## Clever access matrix for the call

| Required domain | Current recorded access | Request and validation |
|---|---|---|
| API contract | Adapter v3.1; app rejects v3.1 with 403 version-not-supported | Enable v3.1 or confirm a supported v3.0 contract and migration plan; retest separately from scope changes. |
| District data | v3.0 `/districts` 200 | Verify correct sandbox district and consent/sharing metadata. |
| Schools/users/sections/terms | v3.0 collections 401 resource-not-available-for-token | Enable roster data entitlement and district field sharing; page all collections and compare counts/relationships. |
| Courses | Adapter consumes courses; access not established by recorded successful calls | Confirm endpoint/entitlement/version explicitly. Do not list it as a proven token success. |
| Events/delta | `/events` 401 | Enable events with documented cursor/retention/removal semantics, or agree complete-sync fallback. |
| Role SSO / portal | Implemented claim mapping and shared launch, live acceptance open | Synthetic role logins, multi-role subject, district claim and portal launch registration; verify correct principals. |
| Negative/recovery fixtures | Harness covers faults; real sandbox exercise incomplete | Second student/district, non-member, removal, revoked token, scope refusal, quota and reset instructions. |
| Content/grades | No Clever coursework/grade-write authority established | Identify the actual product/provider. Continue Google connector for the demonstrated learning lifecycle. |

Recorded restrictions come from SCHO-211's 2026-10-27 probes, not a new authenticated Clever run.
Official developer pages returned HTTP 403 during this preparation, so their current program
requirements have not been independently revalidated. Ask Clever to confirm the matrix on the call.
