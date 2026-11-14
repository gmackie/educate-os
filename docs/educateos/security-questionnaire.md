# EducateOS security questionnaire: pre-filled answers

- Status: Living document. Answers follow [maturity.md](maturity.md); when a maturity row changes,
  change the matching answer here and on the public page in the same PR.
- Date: 2026-11-14
- Issue: SCHO-360 (parent SCHO-358)
- Public copy: `sites/educateos-io/public/it/security-questionnaire/index.html`
  (educateos.io/it/security-questionnaire/), printable to PDF from the browser.

These are answers to the questions district IT and procurement security reviews ask most often.
Every answer names the document or code path it rests on. Paths are relative to the repository
(github.com/gmackie/educate-os). Where something is not done, the answer says so.

## Read this first

- **The district runs EducateOS.** EducateOS is open-source software (Apache-2.0) that a district
  installs in its own Cloudflare account. Its data, logs, keys and backups live in that account.
  Gmacko Ventures LLC develops EducateOS and does not receive student data from installations
  ([ADR-0001](adr/0001-district-data-ownership.md), [ADR-0011](adr/0011-open-source-charter-and-module-ownership.md),
  [ADR-0013](adr/0013-educateos-open-core-control-plane.md)). So many vendor questions are
  **not applicable** to Gmacko Ventures LLC, and the answer is the district's own control of its
  Cloudflare account.
- **No real students use EducateOS yet.** The deployed districts (northfield.educateos.io and the
  demo districts at `<slug>.educateos.io`) run in the owner's account with synthetic data only
  ([runbooks/production-instance.md](runbooks/production-instance.md),
  [runbooks/demo-districts.md](runbooks/demo-districts.md)). No district has run the installer
  ([maturity.md](maturity.md), Installer row).
- **No certifications, audits or tests by third parties.** EducateOS has no SOC 2 report, no ISO
  27001 certificate, no independent security or privacy audit and no penetration test. It is not a
  signatory to any student-privacy pledge. No 1EdTech certification is claimed
  ([maturity.md](maturity.md)).
- **FERPA and COPPA.** EducateOS is built to support the district's FERPA and COPPA obligations.
  It does not certify compliance with them, and no law certifies software. The district makes its
  own legal review ([threat-model.md](threat-model.md), "Out of scope for v1";
  `sites/educateos-io/public/student-privacy/index.html`).
- **The DPA is a draft.** The data processing agreement template
  (`sites/educateos-io/public/student-privacy/dpa/index.html`, version of 2026-10-25) is pending
  counsel review (SCHO-229).
- **Cloudflare.** Facts about the Cloudflare platform cite Cloudflare's public documentation.
  Cloudflare publishes its own compliance reports and certifications at
  <https://www.cloudflare.com/trust-hub/compliance-resources/>; the district obtains them under its
  own agreement with Cloudflare. We make no claim about them here.

### Status labels

| Label | Meaning |
| --- | --- |
| In place | True today, in the code or the Cloudflare platform, as described. |
| Built, not proven in a district | Code exists at the maturity level named in the answer, but has not run in a real district. |
| Not done | Not built, or not done. |
| Not applicable | Gmacko Ventures LLC holds no student data or access, so the question is the district's to answer for its own account. |
| District decides | A setting or process the district owns. |

## 1. Company and assurance

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Who provides the software? | Gmacko Ventures LLC develops EducateOS. It is open source under Apache-2.0. The district installs and operates it. | In place | `LICENSE`, [licensing.md](licensing.md), [ADR-0011](adr/0011-open-source-charter-and-module-ownership.md) |
| Do you have a SOC 2 Type II report or ISO 27001 certificate? | No. | Not done | This document |
| Has an independent party audited or penetration-tested EducateOS? | No. No third-party audit or penetration test has been done. The code is public, so the district or its reviewer can inspect it. | Not done | `sites/educateos-io/public/student-privacy/index.html` ("What we don't claim") |
| Is it in production use with students? | No. No real students use it. Deployed instances hold synthetic data only. | Not done | [maturity.md](maturity.md); [runbooks/production-instance.md](runbooks/production-instance.md) |
| Do you have a documented threat model? | Yes, v1, revisited at each release gate. | In place | [threat-model.md](threat-model.md) |
| Do you carry cyber liability insurance? | Not stated in any repository document. The owner must supply this. | Unknown | Not yet documented |
| Do staff with access to student data have background checks? | Gmacko Ventures LLC staff have no access to student data in the normal course. Background checks for anyone who would do Support Access are not documented. The owner must supply this. | Unknown | DPA template §6; not yet documented |

## 2. Data location and residency

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Where is student data stored? | In the district's own Cloudflare account: Workers, Durable Objects (SQLite) and, where enabled, KV, R2 and D1. The district application keeps its records in one SQLite Durable Object per district. Nothing is stored in an account Gmacko Ventures LLC controls. | In place (design); Built, not proven in a district | [ADR-0001](adr/0001-district-data-ownership.md) rule 1; `packages/educateos-district-worker/src/worker.ts`, `district-object.ts`; [maturity.md](maturity.md), District application row |
| Does any student data reach educateos.io or Gmacko Ventures LLC? | No, in the normal course. educateos.io hosts the website, releases, an optional guided install and an optional managed hostname. No classroom path calls it. Instance registration is opt-in, content-free and off by default. | In place (design) | [ADR-0011](adr/0011-open-source-charter-and-module-ownership.md) decisions 3, 4, 7; [ADR-0013](adr/0013-educateos-open-core-control-plane.md); [README.md](README.md), "Rules every EducateOS change follows" |
| What about the optional `<slug>.educateos.io` hostname? | It is routing only: the hostname, certificate, Worker route and Access application live on a zone in the district's account, and educateos.io publishes DNS records. Gmacko Ventures LLC configures no logging, storage or inspection of requests. A district can use its own domain instead, and must for now if its account does not hold educateos.io. | Built, not proven in a district | [ADR-0013](adr/0013-educateos-open-core-control-plane.md) decision 4 and addendum A1; [installer-permissions.md](installer-permissions.md), "Managed-only installs" (SCHO-243) |
| Is data kept in the United States? | On a new install, the district's records are pinned to Cloudflare's US jurisdiction; existing districts are not. The installer's launcher (`npx launch-educate-os`) sets `dataJurisdiction: "us"` for every new install. The district's Durable Object, which holds its records, is then created in Cloudflare's `us` jurisdiction, and so are the install's KV namespaces, R2 buckets and D1 databases. Cloudflare's jurisdiction controls where that storage runs and is stored. It does not control where requests are answered, and KV may still cache values outside it. Not pinned, even on a new install: the AI Workshop's, gatekeepers' and AI call guard's Durable Objects, logs and analytics, and installs made through educateos.io's guided install. The demo districts, and every install made without `dataJurisdiction` (all installs before ADR-0015), are not pinned and are not migrated, because Cloudflare cannot move storage between jurisdictions. Level: Unit-tested; no pinned install has run on Cloudflare yet. | Built, not proven in a district | [ADR-0015](adr/0015-us-data-jurisdiction.md); `packages/educateos-district-worker/src/jurisdiction.ts`; `packages/educateos-installer/src/desired.ts`, `plan.ts`; <https://developers.cloudflare.com/durable-objects/reference/data-location/>, <https://developers.cloudflare.com/r2/reference/data-location/>, <https://developers.cloudflare.com/d1/configuration/data-location/>, <https://developers.cloudflare.com/kv/reference/data-location/> |
| Can the district export or take its data elsewhere? | Yes. A district administrator exports the whole district (directory, course work and submissions with their files, grades, feedback, class content, weekly notes, Content Studio materials, activities, rubrics, the course library and marketplace packs, guardian relationships, configuration) as one ZIP of JSON and content files, from the admin console or an admin-only, audited endpoint. It is streamed, so there is no size limit (SCHO-367); it has not yet been timed against a large district. Teachers can also export a course as Common Cartridge and a gradebook as CSV. Students' personal workspaces are not in the district export: each student downloads their own work (personal workspaces, finished classes' work, their submissions and the feedback shared with them) as a `.educateos` archive from the Student app, every item decided and audited by the policy engine, while they can still sign in (SCHO-371). The district also holds the account, so its data never leaves its control. Leaving is described in the offboarding runbook. | Harness-tested, not proven in a district | `packages/educateos-district-app/src/routes.ts` (`admin.exportDistrict`, `student.exportArchive`, `teacher.exportCartridge`, `teacher.exportGradebookCsv`); [educateos-archive-format.md](educateos-archive-format.md#district-export); [runbooks/district-offboarding.md](runbooks/district-offboarding.md) |

## 3. Encryption

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Is data encrypted at rest? | Yes, by Cloudflare. Durable Object data and metadata are encrypted with AES-256 (LUKS); KV and R2 with AES-256-GCM. Keys are managed by Cloudflare. EducateOS adds no application-level encryption of records. | In place (platform) | <https://developers.cloudflare.com/durable-objects/reference/data-security/>, <https://developers.cloudflare.com/kv/reference/data-security/>, <https://developers.cloudflare.com/r2/reference/data-security/> |
| Is data encrypted in transit? | Yes. Public traffic is HTTPS, terminated by Cloudflare in the district's account. Traffic between Workers, Durable Objects and Cloudflare's network uses TLS. Worker-to-Worker calls use service bindings inside the account. | In place (platform) | Same Cloudflare pages; [ADR-0014](adr/0014-one-origin-per-district.md) |
| Can the district hold its own encryption keys? | No. Cloudflare manages storage encryption keys. The district holds its integration credentials and signing keys as Worker secrets. | Not done | Cloudflare pages above |
| How are secrets stored? | As Cloudflare Worker secrets in the district's account. Cloudflare does not show a secret's value in the dashboard or Wrangler after it is set. The release signing key is a CI secret on the publisher's side and is never written to disk. | In place | <https://developers.cloudflare.com/workers/configuration/secrets/>; [release-signing.md](release-signing.md); `packages/educateos-ai-guard/README.md` |

## 4. Access control and administrative access

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| How do users sign in? | Through Cloudflare Access in the district's account, using the identity provider the district already uses (SAML or OIDC; Google, Microsoft Entra ID, Clever and others). The district Worker verifies the Access assertion (signature, issuer, audience, expiry) and resolves it to a person in the district's own directory. Setting Access closes the Workshop's password sign-in. | In place (Access sign-in); Built, not proven in a district (directory) | `packages/educateos-district-worker/src/access.ts`; [ADR-0003](adr/0003-principal-identity.md); [runbooks/production-instance.md](runbooks/production-instance.md) |
| How is authorization decided? | One default-deny rule table decides every school read and write, using the person's identity, role and enrollments. Requests across districts are refused before any rule runs. Identity comes from sign-in, never from a tool argument or model output. Level: Harness-tested. | Built, not proven in a district | `packages/educateos-policy`; [ADR-0010](adr/0010-one-rule-table-and-record-grants.md); [threat-model.md](threat-model.md) T1-T5; [maturity.md](maturity.md), Policy engine row |
| Can students see each other's work, or teachers see students' private AI chats? | Policy denies both. Artifact isolation is tested over the API. Personal-chat privacy is tested at the policy engine but not yet over the API, because the chat routes are missing (SCHO-107). | Built, not proven in a district | [pilot-gate.md](pilot-gate.md), Roadmap §14 rows 2-3 |
| Do agent writes need a human? | Yes. Grades and other records an agent drafts wait for a teacher's approval. Level: Harness-tested; school tools are Deployed for the demo district. | Built, not proven in a district | `packages/gatekeeper-educateos`; `packages/educateos-policy/src/approvals.ts`; [maturity.md](maturity.md), School tools row |
| What happens when a person leaves or is deactivated? | Access is revoked on the next request. Capabilities already issued in the Workshop are revoked by restarting the objects that hold them, within a bounded delay. | Built, not proven in a district | [security/live-capability-revocation.md](security/live-capability-revocation.md); [pilot-gate.md](pilot-gate.md) (revocation mid-session) |
| Who are the administrators? | District administrators, named by the district. The last administrator cannot be removed. Cloudflare account roles are the district's. | District decides | `packages/educateos-district-app/src/routes.ts` (`admin.grantDistrictAdmin`, `admin.revokeDistrictAdmin`); [admin.md](admin.md) |
| Does Gmacko Ventures LLC have standing or remote administrative access? | No. The default runtime has no remote administrative access for anyone outside the district. The guided install uses a credential for the length of the install only, and the district then deletes or revokes it. | Not applicable | [ADR-0011](adr/0011-open-source-charter-and-module-ownership.md) decision 4; [installer-permissions.md](installer-permissions.md); DPA template §9 |
| What if the district wants vendor support with its data? | Only at the district's written request, with credentials the district grants and revokes, limited to the task, and recorded (DPA §6, draft). An optional hosted operations console (admin.educateos.io) is designed so a district can enroll it with scoped keys it can remove; its `directory` scope would show the district's people list. It is not deployed, and no district has enrolled it. An open-source edition runs in the district's own account instead. | Not done | DPA template §6; [admin.md](admin.md) |
| What can the installer credential reach? | Cloudflare's permission groups are coarser than the installer needs, so the limit is in the code: the installer has no operation that reads KV values, R2 objects or Worker logs, and runs only migration SQL against D1. | Built, not proven in a district | [installer-permissions.md](installer-permissions.md), "What the credential can reach" |

## 5. SSO and MFA

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Do you support SSO? | Yes, through Cloudflare Access with the district's identity provider. Clever SSO through Access is Harness-tested; ClassLink sign-in is Implemented, tested against fakes only. The admin console's Sign-in screen shows, read-only, the configured provider, the issuers the district trusts and how many people each signs in, and no secret (SCHO-376). | In place (Access); Built, not proven in a district (Clever, ClassLink) | [maturity.md](maturity.md), Clever SSO and ClassLink rows; `packages/educateos-identity/src/clever-sso.ts` |
| Is MFA enforced? | The district enforces MFA in its identity provider or in its Access policy (Access can require an MFA authentication method, or prompt for MFA itself). EducateOS has no passwords of its own to protect. | District decides | <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/> |
| Session length and timeout? | Set by the district in its Access application. | District decides | Cloudflare Access application settings |
| Is email used as an identity key? | No. Identity is `(district, issuer, subject)`. Email is display metadata, so a shared family email cannot take over an account. | Built, not proven in a district | [ADR-0003](adr/0003-principal-identity.md); [threat-model.md](threat-model.md) T4 |

## 6. Sub-processors

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Which sub-processors handle student data for Gmacko Ventures LLC? | None. Gmacko Ventures LLC receives no student data. For its own website and services it uses Cloudflare (hosting, DNS, operator sign-in, email routing), an email provider, and Stripe once billing exists; none receives student data from Gmacko Ventures LLC. | Not applicable | DPA template §8; `sites/educateos-io/public/privacy/index.html` |
| Which third parties does the installation itself use? | The district's own: Cloudflare (always), its identity provider, and the integrations it turns on (for example Google Classroom, Clever, ClassLink, an LMS). AI models run where the district configures them: Workers AI in its Cloudflare account, or other providers through its AI Gateway under the district's agreement with them. These are the district's sub-processors, under the district's contracts. | District decides | [runbooks/production-instance.md](runbooks/production-instance.md); `docs/ai-gateway-conventions.md`; [maturity.md](maturity.md) |
| Will you notify us before adding a sub-processor? | The draft DPA promises 30 days' notice before adding one that would receive student data. | Not done (DPA draft) | DPA template §8 |

## 7. AI and model data use

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Is student data used to train AI models? | Not by EducateOS or Gmacko Ventures LLC. Cloudflare states that it does not use Workers AI customer content (prompts, outputs, embeddings) to train models and does not keep inputs or outputs after a request unless a storage or logging feature is turned on. Other providers a district adds are governed by the district's agreement with them. | In place (platform, Workers AI) | <https://developers.cloudflare.com/workers-ai/platform/data-usage/> |
| Are prompts logged? | Not by default. The installer creates the AI Gateway with logging off, because gateway logs would hold prompts. Server code must never log prompts, secrets, headers, tokens or request bodies. | Built, not proven in a district | `packages/educateos-installer/src/cloudflare-http.ts` (`createAiGateway`, `collect_logs: false`); `packages/observability/AGENTS.md` |
| How is student AI use screened? | Before a model sees a new message, the AI call guard sends it to Hall Monitor and applies the decision. Student profiles must also screen model replies before a student sees them, and fail closed when Hall Monitor is down. Hall Monitor runs in the district's own account; there is no hosted Hall Monitor. Level: Deployed (guard, from source) for the demo instance. | Built, not proven in a district | `packages/educateos-ai-guard/README.md`; [ADR-0007](adr/0007-hall-monitor-and-ai-call-guard.md) and its 2026-10-21 note; [maturity.md](maturity.md), AI call guard row |
| Can AI spend be capped? | Yes. Every call holds its maximum cost against the person's allowance on the district's own ledger, then settles at the actual cost. Safety checks come from a separate pool. | Built, not proven in a district | `packages/educateos-ai-guard`; [threat-model.md](threat-model.md) T9 |
| Can AI make an official grade? | No. An AI-suggested score stays a suggestion until a teacher approves it. Tested at the policy and assessment layers; the over-the-API check waits on SCHO-107. | Built, not proven in a district | [threat-model.md](threat-model.md) T10; [pilot-gate.md](pilot-gate.md) |
| Can the district turn AI off? | Yes. Student AI can be turned off entirely; teacher-facing AI starts off. | Built, not proven in a district | `sites/educateos-io/public/student-privacy/index.html` (COPPA section); `packages/educateos-district-worker/src/ai-disabled.ts` |
| Do you profile students or advertise? | No advertising, no sale of data, no profiling for non-school purposes. Automated social-emotional profiling is prohibited in every policy profile. | Built, not proven in a district | `packages/educateos-contracts/src/policy-floor.ts` (`automatedSelProfiling`); `sites/educateos-io/public/student-privacy/index.html`; DPA template §7 |

## 8. Logging and audit

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Are access decisions audited? | Yes. Every authorization decision is written to an audit trail with who, what action, which resource, the outcome and the deciding rule, as identifiers only, never content. If the audit record cannot be written, the request is refused. A district administrator reads them, read-only, in the admin console: Safety decisions lists every decision, filtered by outcome, rule and record kind, with Hall Monitor's decisions on discussion posts; Admin audit log lists the changes administrators were allowed to make. Only a district administrator, signed in as a person, can open either (SCHO-376). | Built, not proven in a district | `packages/educateos-policy/src/audit.ts`, `durable-object-audit-sink.ts`, `engine.ts`; `packages/educateos-admin-ui/src/audit/` |
| Are agent and gadget actions logged? | Gatekeepers log every action and read an agent or gadget makes. EducateOS adds a record of each AI call attributed to a person, class and feature. | In place (action log, Cloudflare OS); Built, not proven in a district (AI call records) | `sites/educateos-io/public/security/index.html` ("An audit trail"); `packages/educateos-ai-guard` |
| Are sign-ins logged? | Cloudflare Access records sign-ins in the district's account. | In place (platform) | Cloudflare Access logs |
| Are operator actions audited? | If the district enrolls an operations console, every verified request is recorded in the district for 400 days. Not deployed. | Not done | [admin.md](admin.md), "The district side" |
| Where are logs kept, and for how long? | In the district's Cloudflare account, under its retention settings. Gmacko Ventures LLC receives none. | District decides | [ADR-0001](adr/0001-district-data-ownership.md); `packages/observability/AGENTS.md` |
| Do logs contain sensitive data? | The logging rules forbid secrets, prompts, headers, tokens and request or response bodies. | In place (rule) | `packages/observability/AGENTS.md`; `REVIEW.md` |

## 9. Retention and deletion

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| How long is data kept? | The district decides. A closed course's workspace is kept for a district-set number of days (default 365), then becomes eligible for deletion. A legal hold blocks deletion, and each deletion leaves a tombstone. Students' personal workspaces are not removed by this process. The retention job is unit-tested but is not scheduled in the district Worker yet. | Built, not proven in a district | `packages/educateos-workspaces/src/retention.ts`, `lifecycle.ts`; `packages/educateos-district-app/src/app.ts` (default 365); `packages/educateos-district-worker/src/config.ts` (`retention`) |
| Does ending a term or a roster removal delete work? | No. Access is revoked; people are deactivated, not deleted; enrollments are kept as history. A sync that would deactivate a large share of people is held until an administrator approves it. | Built, not proven in a district | [threat-model.md](threat-model.md) T6; [maturity.md](maturity.md), OneRoster and Clever rows |
| How is data deleted at contract end? | The district owns the account and deletes its resources. Gmacko Ventures LLC holds nothing to delete, except anything it held under Support Access, which the draft DPA requires deleted within 30 days with written confirmation. | Not applicable | DPA template §11 |
| Can parents request access, correction or deletion? | Requests go to the district, which holds the data. Gmacko Ventures LLC forwards any it receives within 5 business days (draft DPA). | District decides | DPA template §12 |

## 10. Backups and recovery

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Is data backed up? | The district's data lives in its own Cloudflare account, so its backups are the district's. Every district record, files included, is in one SQLite Durable Object, for which Cloudflare keeps 30 days of point-in-time history. EducateOS adds operator routes that restore that object to any moment in those 30 days, and undo the restore (SCHO-373); they are off unless the district sets a recovery token, and need the token and an Access sign-in. The optional operations database is D1, which Cloudflare's Time Travel restores to any minute in 30 days. Not covered yet: anything older than 30 days, a deleted Worker or Cloudflare account (the district export is a copy of the records but has no importer, SCHO-396), and the AI Workshop's, AI guard's and integrations' data and its KV and R2 content (SCHO-397). | Built, not proven in a district | [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md); `packages/educateos-district-worker/src/recovery.ts`; <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>; <https://developers.cloudflare.com/d1/reference/time-travel/> |
| Has restore been tested? | Not against Cloudflare's storage. On 2026-11-14 a local rehearsal ran the restore routes in the Workers runtime over a real district object (bookmarks, both credentials, refusals, the order of restore and restart), the in-memory whole-district snapshot and restore, and a district export of a seeded district; local storage keeps no history, so the restore itself and its undo were not exercised. A live rehearsal on a test district is planned (SCHO-395). | Not done | [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md), "Rehearsal log"; [pilot-gate.md](pilot-gate.md), "Restore rehearsal" |
| What are your RTO and RPO? | Targets, not commitments, for the district's operator following the runbook: for district records damaged and found within 30 days, an RPO of 5 minutes before the damaging event and an RTO of 4 business hours from the decision to restore; a restore takes the whole district back, so writes after the restore point are lost. For the optional operations database, 1 minute and 4 business hours. No target for the AI Workshop's and integrations' data, or for loss beyond 30 days or of the account. Gmacko Ventures LLC does not operate the installation and makes no recovery commitment. | Built, not proven in a district | [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md), "Recovery targets" |
| What if educateos.io goes down? | Classroom activity continues: no classroom path calls educateos.io. This is a required pilot-gate test. | Built, not proven in a district | [ADR-0001](adr/0001-district-data-ownership.md) rule 4; [ADR-0013](adr/0013-educateos-open-core-control-plane.md) |
| Can a bad update be rolled back? | Yes. The installer redeploys the previous Worker versions. Database migrations are listed as irreversible, and the district acknowledges each before approving a release. | Built, not proven in a district | [installer-permissions.md](installer-permissions.md); [release-signing.md](release-signing.md) |

## 11. Incident response and breach notification

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| Do you have an incident response plan? | No written incident response plan exists yet. | Not done | Not yet documented |
| Who do we contact about a security issue? | hello@educateos.io is the only published contact. There is no dedicated security address or vulnerability disclosure policy yet. | Not done | `sites/educateos-io/public/security/index.html`; not yet documented |
| How fast will you notify us of a breach? | For student data Gmacko Ventures LLC holds or accessed (only under Support Access), the draft DPA says within 72 hours. For the installation itself, the district operates it and runs its own response; Gmacko Ventures LLC will help on request. | Not done (DPA draft) | DPA template §10 |
| What if your release key is compromised? | Releases are signed and the district verifies them offline against keys it pinned. A stolen online release key cannot change the district's trust; only a key set signed by a threshold of offline root keys can. Until a new set lands, the district's approval of each release is the defence. | Built, not proven in a district | [threat-model.md](threat-model.md) T12; [release-signing.md](release-signing.md) |

## 12. Vulnerability management and secure development

| Question | Answer | Status | Source |
| --- | --- | --- | --- |
| How are dependencies kept current? | Dependabot opens grouped npm and GitHub Actions update PRs on the 1st and 15th of each month, with a 7-day cooldown (14 for majors). pnpm refuses package versions younger than a day. | In place | `.github/dependabot.yml`; `pnpm-workspace.yaml` (`minimumReleaseAge`) |
| Do you scan for vulnerabilities? | Yes, for dependencies. CI runs `pnpm audit` against every pnpm lockfile on each pull request, each push to `main` and nightly. A pull request that adds a high or critical advisory in a production dependency fails. Advisories already present are listed in a checked-in baseline, each with a reason, a tracking issue and an expiry; there are none critical. There is no static-analysis (SAST) scanner for EducateOS's own code. | In place | `.forgejo/workflows/ci.yml`; [security/dependency-scanning.md](security/dependency-scanning.md) |
| How are patches applied to a district? | The district applies a signed release with the installer when it chooses. There is no automatic update. | Built, not proven in a district | [release-signing.md](release-signing.md); [launch-installer.md](launch-installer.md) |
| What is your secure development process? | Every change goes through a pull request; CI runs lint, type checks, builds, the EducateOS package tests, the pilot gate's security matrix and a dependency vulnerability audit before merge. Review guidelines put capability-security invariants and secret leakage first. | In place | `.forgejo/workflows/ci.yml`; `REVIEW.md`; [pilot-gate.md](pilot-gate.md) |
| Are releases signed? | Yes. Ed25519 signatures over the exact manifest bytes, verified offline against pinned keys. Level: Unit-tested; one signed release was installed into the owner's own account on 2026-11-04. | Built, not proven in a district | [release-signing.md](release-signing.md); [maturity.md](maturity.md), Signed releases and Installer rows |
| Is test data real? | No. Tests use only synthetic fixtures with `.example` domains, and a test enforces it. | In place | [threat-model.md](threat-model.md) T14 |
| How is untrusted code isolated? | Gadgets and agents start with no access and run in a sandbox that reaches the internet only through the gatekeepers a person granted. Imported content is treated as data and cannot change policy or tools. | In place (Cloudflare OS sandbox); Built, not proven in a district (EducateOS policy) | `README.md` (repository root); [threat-model.md](threat-model.md) boundaries 5-7, T7 |

## For the owner to supply

These answers are marked unknown or not done because no repository document settles them:

- A dedicated security contact and a vulnerability
  disclosure policy.
- A written incident response plan and a breach notification commitment for the installation
  (the DPA's 72 hours covers only data Gmacko Ventures LLC holds).
- Cyber liability insurance, if any.
- Background checks for anyone who would do Support Access.
- Whether to offer any recovery commitment beyond the runbook's targets, once a live restore has
  been rehearsed (SCHO-395).
- Counsel's review of the DPA (SCHO-229).
