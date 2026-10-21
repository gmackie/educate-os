# SchoolOS synthetic pilot gate (H01)

- Status: Living document. The tables below are generated; update them with the suite.
- Issue: SCHO-34
- Package: `packages/schoolos-pilot-gate` (`@schoolos/pilot-gate`, test-only)

The pilot gate is the security, availability, term rollover, load, restore and accessibility suite
the roadmap calls H01. It checks every row of the security and production acceptance matrix
(roadmap §14) and every pilot exit criterion (§3.4), plus what H01 adds: policy revocation
mid-session, a smoke-level load run, a restore rehearsal and the accessibility audit.

## How it runs

The suite boots both synthetic districts, Northfield and Riverbend, through the harness
(`@schoolos/harness`): each is its own instance with its own fake IdP, serving the full district
app over in-memory stores. Scenarios act as the districts' people do, through `@schoolos/api-client`
with tokens from the district's IdP. They never read or write the district's records except over
the API. A check calls a domain package directly only where the district app does not route what
the row is about (the fleet, the installer, release offers, school tools, the cartridge importer);
each such check says why, and they are listed below.

```sh
node scripts/vp/run.ts --filter=@schoolos/pilot-gate test  # the suite, as CI runs it
pnpm --filter @schoolos/pilot-gate start                    # run it and print the G0/G1 gate report
pnpm --filter @schoolos/pilot-gate write-doc                # regenerate the tables below
```

One registry, `src/criteria.ts`, holds every criterion and its checks. The test files register
their tests from it: a check marked `test` must have a body, a `todo` must not, and each todo's
name carries the issues that block it. The gate report joins the registry with a run of the suite,
and the tables below are rendered from the same registry. A test keeps them in step.

## Reading the status

- **MET**: every check of the criterion is an executable test in this suite. CI runs them on every
  change. `start` runs them again and reports live: a criterion counts as met there only if each
  of its tests passed in that run.
- **NOT MET**: at least one check cannot be exercised yet, because a kernel seam, a route, a durable
  store or a UI is missing. It is an `it.todo` naming the blocking issue. A partial pass is still
  NOT MET. No check is faked.

## Where the gates stand

**G0 (architectural runnable harness) is MET.** Both synthetic districts boot isolated, with two
schools each and work in three subjects, and cross-district requests are refused at the identity
boundary and by the policy engine.

**G1 (classroom product, synthetic) is NOT MET.** The classroom checks themselves pass: isolation,
privacy, submissions, CI, grade review, budgets, term rollover, revocation and load. G1 stays NOT
MET for these reasons:

- **Accessibility is NOT MET.** The Student, Teacher and Admin UIs (SCHO-22, SCHO-23, SCHO-24) are
  still in review, so there is nothing to audit. The criterion stays NOT MET until they land and the
  todos become audits.
- **Some routes are missing.** The district app has no conversation or AI-helper routes, and does
  not wire AI feedback (SCHO-107). Personal-chat privacy and the AI grader are therefore checked at
  the policy engine and the assessment service, but not yet over the API.
- **Capabilities are not enforced.** Configuration `modules` and `rollout` reach only plan and
  apply. Disabling a capability for some classes predicts its impact and records a revision, but no
  decision reads it (SCHO-120).
- **Two lifecycle steps are missing.** Principals have a `graduated` status that holds no roles,
  but no district app route moves a principal to it yet (SCHO-145). An export offer at term end
  needs the export route (SCHO-90).
- **The district app does not serve its school tools to the gatekeeper yet.** `gatekeeper-schoolos`
  (SCHO-57) exposes school tools to Workshop agents, and the gate drives its session over the
  district app's engine through the in-process district service. A district Worker that exposes the
  same service as the gatekeeper's `SCHOOLOS_DISTRICT` binding, with the district's tools and a
  durable approval store, is still to be built.

### Restore rehearsal

The in-memory rehearsal (`restore.test.ts`) snapshots a working district through its stores'
interfaces, discards the app and restores into fresh stores behind a new one. The directory,
artifacts (by digest), submissions, the AI ledger, configuration revisions and every API view are
then equal. The rehearsal also found what a durable backup must add. The Content Studio's revisioned
items and the catalog mirror's revisioned states cannot be written back through their interfaces,
and the CI run store cannot be listed. The rehearsal re-approves the catalog seeds and omits the
other two. A real D1 and R2 restore waits on the durable stores (SCHO-108), which have to close
that gap.

### Load

`load.test.ts` runs 24 students at once through one app: concurrent saves, repeated submits and
duplicated AI requests. It asserts that no write is lost, that submits are idempotent and that
ledger totals are exact. It is not a benchmark. Timings and conflict-retry counts are recorded as
test annotations and printed by `start` for information only.

The first runs showed one thing a durable store should change. Each district keeps all artifact
records as one versioned document, so every save from any student races every other. 120
concurrent saves needed about 2,300 `conflict` retries before all of them landed. None was lost,
because the store refuses a stale commit and the client retries. A durable artifact store
(SCHO-108) should version per artifact rather than per district.

### Observations for follow-up

- The Content Studio flags instruction-like text in an imported page as a `blocking` review flag.
  The item is never auto-released and changes no policy, but a teacher can still approve it: the
  flag only orders the queue.
- A student the roster dropped can still open their retained course workspace's record. They can no
  longer write to it, list its activities or spend its AI funding.

<!-- BEGIN GENERATED: pnpm --filter @schoolos/pilot-gate write-doc -->

### Roadmap §14

| Row | Expected | Gate | Checks | Test file | Status | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| District B request to district A resource | Rejected at deployment boundary and policy layer | G0 | test: a Northfield token is refused at Riverbend, and Riverbend's principals find no Northfield record by ID<br>test: Northfield's policy engine denies a Riverbend subject on a Northfield resource before any rule runs (direct) | `security-matrix.test.ts` | **MET** |  |
| Student A attempts B's artifact and private chat | Denied independent of query params/client UI | G1 | test: a classmate cannot read, list, revise, keep or submit another student's artifact, whatever IDs, query or extra fields the request carries<br>test: the district's policy engine denies a classmate reading a student's personal conversation (direct)<br>todo: a classmate cannot read another student's private AI chat over the API (SCHO-107) | `security-matrix.test.ts` | **NOT MET** | SCHO-107 |
| Teacher requests unrelated personal AI conversation | Denied; only explicit assigned-work projections visible | G1 | test: a teacher sees submitted work and course workspace records, never a personal workspace or its contents<br>test: the district's policy engine denies a teacher reading a student's personal conversation (direct)<br>todo: a teacher cannot open a student's personal AI conversation over the API (SCHO-107) | `security-matrix.test.ts` | **NOT MET** | SCHO-107 |
| MCP tool claims other student identity or untrusted `readOnlyHint` | Trusted principal/action policy prevails; denied/approval required | G1 | test: an API request naming another principal or role is refused, and the caller is always the token's verified principal<br>test: a school tool call naming another student is denied, and one with an untrusted readOnlyHint is authorized as its real action (direct)<br>test: through the agent-facing gatekeeper, the subject is the connected account's principal, readOnlyHint is ignored, every write waits for a person, and another district's account reaches nothing (direct) | `security-matrix.test.ts` | **MET** |  |
| OneRoster removes enrolled student temporarily | Workspace retained; access policy updated; no automatic deletion | G2 | test: a roster import that drops a student keeps their workspace and work, revokes their class access on the next request, and a later import restores it | `security-matrix.test.ts` | **MET** |  |
| Imported Thin CC references unregistered LTI tool | Resource can remain referenced but cannot be launched as authorized tool | G4 | test: a Thin CC LTI link is kept as a never-launchable tool reference while its web links reach the class review queue (direct) | `security-matrix.test.ts` | **MET** |  |
| External page embeds prompt injection | Treated as data; no tool/system instruction escalation | G1 | test: an imported page with instruction-like text is flagged for review, never auto-released, and changes no policy, configuration or rights | `security-matrix.test.ts` | **MET** |  |
| Blueprint Git baseline contains answer key in old commit | Publication blocked or sanitized before fork | G3 | test: forking a baseline whose history holds an answer key is blocked, and recreating it yields a parentless commit without the key (direct) | `security-matrix.test.ts` | **MET** |  |
| Stale course AI budget, underfunded student or retry duplication | New inference denied or billed idempotently | G1 | test: a closed term's course budget and an exhausted student cap deny new inference, and a retried request is billed once (direct) | `security-matrix.test.ts` | **MET** |  |
| AI grader suggests a score, teacher has not reviewed | Cannot write consequential official grade by default | G1 | test: evaluator suggestions stay suggestions, a co-teacher's grade waits for the teacher, and the student sees no grade until one is official<br>test: a grade written on an agent's behalf is held for teacher approval (direct)<br>todo: an AI feedback run's suggested score cannot become official over the API (SCHO-107) | `security-matrix.test.ts` | **NOT MET** | SCHO-107 |
| Source content deleted/updated | Immutable prior approved revision remains or unavailability is clearly reported | G1 | test: after its source changes or disappears, the approved release and the activity built on it are unchanged, and a failed re-import says the source is unavailable | `security-matrix.test.ts` | **MET** |  |
| Semester end / graduation | Classroom integration grants revoked; eligible work retained or export offered per retention policy | G1 | test: closing a term revokes class grants and course AI funding, and keeps the students' work readable and keepable<br>test: a graduating student's grants end while their eligible work is kept (direct)<br>todo: the student is offered an export of eligible work (SCHO-90) | `security-matrix.test.ts` | **NOT MET** | SCHO-90 |
| Root `schoolos.dev` unavailable | Existing district login, work, grading and local budgets continue | G2 | test: with the root unreachable, the entitlement cache holds and sign-in, work, grading and AI budgets continue (direct) | `security-matrix.test.ts` | **MET** |  |
| Installer OAuth revoked | No new root deployment action; district app and data remain under owner control | G2 | test: a revoked installer credential halts the upgrade with no further change to the account, and the district app keeps serving its data (direct) | `security-matrix.test.ts` | **MET** |  |
| Public registry catalog compromised | Untrusted/unapproved signatures are rejected; pinned district data unaffected | G3 | test: a release signed by an unpinned key and a tampered framework release are rejected, and the district's pinned release and approved catalog are unchanged (direct) | `security-matrix.test.ts` | **MET** |  |
| Import from another district | Credentials, private peer content and restricted teacher notes not imported | G4 | test: a student's archive from the district app's own records carries no peer work, teacher-only material or credentials (direct)<br>todo: a transfer between the two district apps imports only the authorized work (SCHO-90) | `security-matrix.test.ts` | **NOT MET** | SCHO-90 |
| Accessibility audit | Keyboard/screen reader critical pathways complete and usable | G1 | todo: an audit of the student, teacher and admin critical paths passes (SCHO-22, SCHO-23, SCHO-24) | `accessibility.test.ts` | **NOT MET** | SCHO-22, SCHO-23, SCHO-24 |

### Roadmap §3.4

| Row | Expected | Gate | Checks | Test file | Status | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| Two synthetic districts, at least two schools per district, three subject scenarios, multiple student principals | Both districts run isolated, each with two schools and writing, science and history work by several students | G0 | test: both harness districts serve the full app in isolation, each with two schools, three subjects of installed activities and submissions from several students | `exit-criteria.test.ts` | **MET** |  |
| Unauthorized student A cannot read B's work or teacher-only materials; a teacher cannot read a student's personal workspace | Every such read is refused | G1 | test: student A cannot read student B's work or feedback<br>test: a student sees an activity without its teacher-only material, and cannot reach teacher routes<br>test: a teacher cannot list or read a student's personal workspace | `exit-criteria.test.ts` | **MET** |  |
| One content source imported via a generic URL, one via Thin CC, and one native Blueprint; all normalize into the same resource model | Each source becomes a reviewed release of the same resource descriptor | G1 | test: a generic URL becomes an approved resource release over the API<br>test: a Thin CC web link becomes an approved release of the same resource descriptor (direct)<br>test: a native Blueprint becomes an approved release of the same resource descriptor (direct) | `exit-criteria.test.ts` | **MET** |  |
| One assignment produces a persistent submission snapshot and deterministic CI report; no unreviewed official grade writeback | Pinned snapshot, reproducible report, no official grade without a teacher | G1 | test: a submission pins its revision digests through later edits, its CI report is reproducible, and no grade is official until the teacher records it | `exit-criteria.test.ts` | **MET** |  |
| Admin can enable/disable a capability for a subset of classes, predict impacted users, and roll back configuration | Predicted impact per class, an auditable revision, and a working rollback | G1 | test: planning a capability for two classes predicts each class's students and staff without changing anything<br>test: narrowing to a subset and then rolling back records each step as a revision and restores the earlier desired state<br>todo: a class outside the rollout is refused the capability on its next request (SCHO-120) | `exit-criteria.test.ts` | **NOT MET** | SCHO-120 |
| Artificial root outage does not interrupt existing district student/teacher activity | Students and teachers keep working while the root is down | G1 | test: while every root call fails, students save and submit and teachers review and grade, and the entitlement leaves the classroom unaffected (direct) | `exit-criteria.test.ts` | **MET** |  |
| End-of-term transition retains eligible artifacts without retaining expired course grants | Artifacts kept, course grants gone | G1 | test: after the term closes, its artifacts and submissions remain and can be kept, while its course grants and new class work are refused | `exit-criteria.test.ts` | **MET** |  |
| Full district-local metering reports accurate per-principal and per-funding-pool AI use; no root content transmission | Exact per-principal and per-pool totals; nothing personal reaches the root | G1 | test: the usage report's per-principal, per-class and per-pool totals equal what was settled<br>test: the district's heartbeat to the root carries no names, IDs or content (direct) | `exit-criteria.test.ts` | **MET** |  |
| IdP/roster import errors do not silently remap principals or delete workspaces | Errors are refused or quarantined; principals and workspaces unchanged | G1 | test: a roster import with errors or a conflicting identity applies nothing, and no workspace is deleted<br>test: an expired, foreign-issuer or unknown-subject token resolves to no principal, and extra claims change nothing | `exit-criteria.test.ts` | **MET** |  |
| Accessible keyboard and screen-reader flows for student, teacher and administration | Each surface's critical flow completes by keyboard and screen reader | G1 | todo: the student, teacher and admin flows complete by keyboard and screen reader (SCHO-22, SCHO-23, SCHO-24) | `accessibility.test.ts` | **NOT MET** | SCHO-22, SCHO-23, SCHO-24 |

### H01 additions

| Row | Expected | Gate | Checks | Test file | Status | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| Policy revocation mid-session | Revoking a grant, role or policy takes effect on the next request, with no cached authority | G1 | test: a student dropped by a roster import is refused their class and its AI funding on the next request, with the same token<br>test: a teacher removed from a class loses its roster, submissions and grading on the next request<br>test: an applied configuration that disables AI spending denies the next AI request<br>todo: a capability disabled mid-session is refused on the next request (SCHO-120) | `revocation.test.ts` | **NOT MET** | SCHO-120 |
| Concurrent students (smoke-level load) | No lost writes, idempotent submits and exact ledger totals under concurrency | G1 | test: concurrent saves by many students lose no write<br>test: concurrent repeated submits produce one submission per student<br>test: concurrent AI requests, retries included, leave the ledger totals exact | `load.test.ts` | **MET** |  |
| Restore rehearsal | A restored district is equivalent: directory, artifacts, submissions, ledger and configuration | G3 | test: a district snapshotted, destroyed and restored into a new app serves equivalent directory, artifacts, submissions, ledger and configuration<br>todo: the same rehearsal against D1 and R2 backups (SCHO-108) | `restore.test.ts` | **NOT MET** | SCHO-108 |
| Accessibility of the pilot UIs | WCAG 2.2 AA critical paths for each UI | G1 | todo: Student Learning Home critical paths meet WCAG 2.2 AA (SCHO-22)<br>todo: Teacher Studio critical paths meet WCAG 2.2 AA (SCHO-23)<br>todo: District admin console critical paths meet WCAG 2.2 AA (SCHO-24) | `accessibility.test.ts` | **NOT MET** | SCHO-22, SCHO-23, SCHO-24 |

### Checks that call a domain package directly

| Row | Check | Why not over HTTP |
| --- | --- | --- |
| District B request to district A resource | Northfield's policy engine denies a Riverbend subject on a Northfield resource before any rule runs | Over HTTP a foreign principal is refused at the IdP boundary and never reaches the engine, so the district app's own engine is asked directly. |
| Student A attempts B's artifact and private chat | the district's policy engine denies a classmate reading a student's personal conversation | The district app has no conversation routes yet, so the decision is asked of its engine directly. |
| Teacher requests unrelated personal AI conversation | the district's policy engine denies a teacher reading a student's personal conversation | The district app has no conversation routes yet, so the decision is asked of its engine directly. |
| MCP tool claims other student identity or untrusted `readOnlyHint` | a school tool call naming another student is denied, and one with an untrusted readOnlyHint is authorized as its real action | The district app does not expose school tools; the tool runner is driven over the district app's own policy engine. |
| MCP tool claims other student identity or untrusted `readOnlyHint` | through the agent-facing gatekeeper, the subject is the connected account's principal, readOnlyHint is ignored, every write waits for a person, and another district's account reaches nothing | The district app does not expose its school tools to the gatekeeper yet; the gatekeeper's session is driven over the district app's own policy engine through the in-process district service. |
| Imported Thin CC references unregistered LTI tool | a Thin CC LTI link is kept as a never-launchable tool reference while its web links reach the class review queue | The district app has no cartridge import route, so the importer is driven directly against the district app's Content Studio storage; the review queue is read over HTTP. |
| Blueprint Git baseline contains answer key in old commit | forking a baseline whose history holds an answer key is blocked, and recreating it yields a parentless commit without the key | The district app saves projects but has no baseline or fork route, so its project service is built directly over the app's stores and engine. |
| Stale course AI budget, underfunded student or retry duplication | a closed term's course budget and an exhausted student cap deny new inference, and a retried request is billed once | Model requests reach the governor through the kernel AI Gateway seam (SCHO-72), not a district route, so `app.aiGovernor` is called as that seam would; usage is read over HTTP. |
| AI grader suggests a score, teacher has not reviewed | a grade written on an agent's behalf is held for teacher approval | No district route acts on an agent's behalf, so the assessment service is built over the app's stores and engine with an agent-channel caller. |
| Semester end / graduation | a graduating student's grants end while their eligible work is kept | The district app has no lifecycle route yet, so the administrator's graduation runs through the domain service the route will call (transitionPrincipal), over the district app's own stores and policy engine; the student's class work is then checked over HTTP. |
| Root `schoolos.dev` unavailable | with the root unreachable, the entitlement cache holds and sign-in, work, grading and AI budgets continue | The root and the district's entitlement cache are fleet components with no district route; they are driven directly while the district works over HTTP. |
| Installer OAuth revoked | a revoked installer credential halts the upgrade with no further change to the account, and the district app keeps serving its data | The installer acts on the district's Cloudflare account, not through the district app, so it runs against the fake account directly. |
| Public registry catalog compromised | a release signed by an unpinned key and a tampered framework release are rejected, and the district's pinned release and approved catalog are unchanged | Release offers and catalog installs have no district route yet (SCHO-107 adds the catalog routes), so the release manager and the app's catalog mirror are called directly. |
| Import from another district | a student's archive from the district app's own records carries no peer work, teacher-only material or credentials | The district app has no export route, so the P01 exporter is built over the app's stores and engine. |
| One content source imported via a generic URL, one via Thin CC, and one native Blueprint; all normalize into the same resource model | a Thin CC web link becomes an approved release of the same resource descriptor | The district app has no cartridge import route, so the importer is driven directly against the app's Content Studio storage; review and approval are over HTTP. |
| One content source imported via a generic URL, one via Thin CC, and one native Blueprint; all normalize into the same resource model | a native Blueprint becomes an approved release of the same resource descriptor | The district app has no Blueprint import route, so the release is submitted directly to the app's Content Studio storage; review and approval are over HTTP. |
| Artificial root outage does not interrupt existing district student/teacher activity | while every root call fails, students save and submit and teachers review and grade, and the entitlement leaves the classroom unaffected | The root client and entitlement cache are fleet components with no district route; they are driven directly. |
| Full district-local metering reports accurate per-principal and per-funding-pool AI use; no root content transmission | the district's heartbeat to the root carries no names, IDs or content | The heartbeat is built by the fleet agent, which has no district route. |

### Criteria by the gate that first requires them

| Gate | Criteria | MET | NOT MET |
| --- | --- | --- | --- |
| G0 | 2 | 2 | 0 |
| G1 | 21 | 12 | 9 |
| G2 | 3 | 3 | 0 |
| G3 | 3 | 2 | 1 |
| G4 | 2 | 1 | 1 |

<!-- END GENERATED -->
