# EducateOS district Worker

`@educateos/district-worker` (SCHO-171) deploys the district application
(`@educateos/district-app`) as a Cloudflare Worker. Its state survives restarts and deploys. It
serves the district's `/api` surface, and the `EDUCATEOS_DISTRICT` entrypoints that the AI call guard
and the EducateOS gatekeeper take. Maturity: workerd-tested, not deployed
([maturity.md](../../docs/educateos/maturity.md)).

## Layout

- `src/district.ts` composes one district over its Durable Object's storage: the stores, the
  application, and the academic directory's operations as school tools with a durable approval
  queue. It imports nothing Workers-only, so `tsc` checks it against the web-standard surface with
  the libraries it composes (ADR-0009).
- `src/district-object.ts` is `DistrictObject`, the Durable Object around it. `src/worker.ts` has
  the fetch handler and the entrypoints. Both import `cloudflare:workers`, and the Workers typings
  reject the web-standard sources they compose, so they are checked by running them, like the other
  EducateOS workerd suites. capnweb-validate builds their RPC validators from a Workers-typed program,
  `tsconfig.validate.json`.
- `src/config.ts` is the `DISTRICT_CONFIG` schema. `src/access.ts` is the Access verifier.
- `src/mail.ts` is the district app's `MailSender` over the `SEND_EMAIL` binding, and
  `src/schedule.ts` names the Cron Triggers and the job each runs (SCHO-189).

## Storage: one SQLite Durable Object per district

`DistrictObject` is named by the district ID and reached through `ctx.exports`, so it needs no
binding. It holds every `DistrictAppStores` member in its SQLite storage
(`durableDistrictStores` in `@educateos/district-app/durable-stores`). Where a domain package has its
own Durable Object store, that store is used: workspaces, assessment records, CI runs, the Content
Studio, the catalog mirror, the AI ledger and the policy audit trail. The academic directory uses
`@educateos/academics/durable-object-store`, which keeps the same rows and tables as
`D1AcademicStore`. Guardian relationships and invitations (SCHO-188) and the identity-link log
(`@educateos/identity-links/durable-object-store`) are kept there too. The rest are implemented in
`durable-stores.ts`. All of them use prefixed table
names, and each commits in its own `transactionSync`.

- **Why one object.** Every store is optimistic: a commit names the version it was planned against.
  In one object, each store's version check and write share one synchronous transaction, and the
  stores that cache what they read stay correct, because the object is their only writer. The cost
  is throughput: one object serves the whole district, which suits a pilot district.
- **What is not atomic.** No transaction spans two stores. A submission writes artifact records,
  then assessment records. A roster apply writes the directory, then the roster sources, then the
  workspace grants. Each store commits in turn, as it does over the in-memory stores. The object
  can serve other requests between those commits, so a request planned against a replaced version
  fails with `conflict` and is retried.
- **No D1, no R2.** The hosted deploy service rejects `$D1_<B>_ID` tokens it does not know
  (SCHO-138), and a service's R2 placeholders are no better established. So the directory sits in
  D1-shaped tables inside the object, and revision content that would be an R2 object is stored in
  1 MiB SQLite parts (`DurableObjectBlobBucket`). A Durable Object holds 10 GB, so this suits
  documents, not video. To move later, declare the database and bucket in `cloudflare.config.ts`,
  then copy the `academic_*` rows into a D1 database built from `educateos-academics/migrations`
  and the `educateos_artifact_blob*` objects into R2 by key. After that, construct `D1AcademicStore`
  and a real R2 bucket in `durableDistrictStores`' place.
- **Tables from before the rename (SCHO-232).** The EducateOS rename moved every store's tables from
  `schoolos_*` to `educateos_*`. Each store recovers its `schoolos_*` rows on first use, inside the <!-- rename-educateos: keep -->
  transaction that creates its tables (`@educateos/contracts/legacy-tables`): the rows are copied in
  by the store's rule for conflicts with rows written since, and the legacy table is renamed to
  `schoolos_<name>_premigration`, a backup that is never dropped. A merge the store cannot make <!-- rename-educateos: keep -->
  safely (two personal workspaces for one person, a merged state that breaks its invariants) is
  refused and rolled back, and that store fails until the conflict is resolved by hand.
- **Seeding.** On first start, the directory is seeded from `DISTRICT_CONFIG.directory`. After that
  the stored directory is kept, and a configuration that names another district is refused.

## Sign-in

`/api` requests and the gatekeeper's `authenticate` are verified the way the kernel verifies them
(`verifyCfAccessJwt` in workshop-backend). The `cf-access-jwt-assertion` header is checked with
RS256 against the Access team's published certs, `CF_ACCESS_ISS` and the audiences
`CF_ACCESS_AUD` lists. The verified claims then go through `identityFromAccessPayload`
(`@educateos/identity`), and the identity is resolved through the district's own directory. A
request with no valid assertion proves no one. The district must list `CF_ACCESS_ISS` in its
`trustedIssuers`.

`CF_ACCESS_AUD` is a comma-separated list of Access application audience tags; entries are trimmed
and empty ones ignored, and an assertion for any listed application is accepted. Usually it holds
two:

- the district's own application, in front of its hostname and `/api`;
- the instance's Workshop application, when the instance runs the EducateOS connector
  (`gatekeeper-educateos`). Its connect page is served on the Workshop's hostname, so the browser's
  assertion there is for the Workshop's application, and the connector hands that request to
  `authenticate` (SCHO-218).

Both applications must be on the same Access team (one `CF_ACCESS_ISS`), so a person's `sub` is the
same in each and resolves to the same principal. Listing the Workshop's audience means anything
that holds a person's Workshop assertion can sign in to the district as them; Access issues that
assertion only to the person's own browser, and the Workshop itself is already trusted with it. A
district with no connector lists its own audience alone.

### Clever (SCHO-203)

A district that signs in through Clever sets `DISTRICT_CONFIG.cleverSso` (`districtId`, Clever's ID
of the district, and optionally the `issuer` its identity links name, `https://clever.com` by
default). A sign-in whose Access token carries Clever's claims (passed through by an Access OIDC login
method for Clever, including `multi_role_user_id`) is then resolved by the Clever user ID, and a
person's token without them is refused. Access tokens do not say which login method was used, so the
district's Access application must offer Clever as its only login method for people.

Clever's portal ("Instant Login") sends people to the app's first redirect URI with a code and no
`state`, which Access refuses, so the district Worker serves no launch route of its own. Portal
launches go through the one shared URL `https://educateos.io/clever/launch` (SCHO-249), which
redirects to the district registered for the user's Clever district, where Access starts its own
Clever sign-in. A self-hosted install registers its own landing page as the first redirect URI
instead (see ADR-0013).

## Entrypoints

| Entrypoint | For | Contract |
| --- | --- | --- |
| default `fetch` | browsers, behind Access | `/api/*`, and `/healthz` (a liveness probe with no sign-in, which reads nothing); everything else is 404 |
| `DistrictGuardDirectory` | the AI call guard's `EDUCATEOS_DISTRICT` | `GuardDirectoryPort` (`guardSubject`, `admittedSubject`, `ledgerDirectory`) over `DistrictApp.guardDirectory` |
| `DistrictSchoolTools` | the EducateOS gatekeeper's `EDUCATEOS_DISTRICT` | `SchoolToolService` over the directory's operations; every agent call waits for a person in the object's approval queue. Its `serveAs` serves the `/api` surface for a principal the gatekeeper verified, for its school pages (SCHO-218) |
| `DistrictApi` | the release's backend binding, `EDUCATEOS_DISTRICT_API` | the same `/api` surface; holding it grants nothing |

## LTI 1.3 Tool (SCHO-177)

With `LTI_TOOL_ORIGIN` set (an https origin, no trailing slash), `src/lti.ts` serves the district as
an LTI 1.3 Tool: `@educateos/lti`'s broker and handlers over `@educateos/lti-district`'s stores in the
district's object, and the administrators' operations at `/api/lti/*`. Unset, `/lti/*` and
`/api/lti/*` are 404. The fetch handler passes `/lti/*` to the object; a deployment that serves the
UIs as assets must run the Worker first for `/lti/*` too.

`/lti/login`, `/lti/launch`, `/lti/jwks`, `/lti/deep-link` and `/lti/register` must be exempt from
Access (one bypass application for exactly those paths), because LMS users launch from their own
browsers with no Access session. `/api/lti/*` stays behind Access. The routes, what each is decided
as, and why each Tool path is safe without sign-in are in
[docs/educateos/lti.md](../../docs/educateos/lti.md#the-district-workers-tool-scho-177).

## Configuration and release

The deploy inputs are in `deploy-inputs.json`. They are all vars:

- `DISTRICT_CONFIG`: JSON matching `DistrictWorkerConfig`. It has the seed `directory` (the district,
  its trusted issuers, and at least the administrators who will import the roster), and optional
  `authority`, `fundingPools`, `aiMonthlyDistrictCapUsdNano`, `cloudflareAccount`, `modelCatalog`,
  `approvedExternalHosts` and `retention`. Workers vars are limited in size, so the seed should be
  small. The roster arrives through `admin.applyRoster`.
- `authority` names who owns the directory: `"oneroster"` (the default), `"clever"` or `"local"`, or a full
  `AuthorityMap` for a mixed district. A district with no roster, such as a homeschool co-op, sets
  `"local"`: its administrators then create schools, terms, courses, sections and students and enroll
  them through the admin API (`admin.createCourse`, `admin.enroll`, `admin.createPrincipal` and the
  rest, SCHO-186), and a roster import is refused. A local principal is created with the Access
  subject that signs them in; inviting someone by email before they have signed in is not built yet.
  Administrators then correct a person's name, email or kind (`admin.updatePrincipal`), deactivate
  or reactivate them (`admin.setPrincipalStatus`), and make staff district administrators or take
  that away (`admin.grantDistrictAdmin`, `admin.revokeDistrictAdmin`, SCHO-212). The district always
  keeps one active administrator, and nobody can remove their own administration.
- `CF_ACCESS_ISS` and `CF_ACCESS_AUD` (a comma-separated list, see [Sign-in](#sign-in)).
- `CLEVER_DISTRICT_TOKEN` (optional secret, SCHO-203): the district-app token Clever issued for the
  district, for the scheduled Clever roster sync. It is not a deploy input (the wizard requires every
  input, and most districts have no Clever roster); set it with `wrangler secret put` or the
  deployment's secret sync. With it, `DISTRICT_CONFIG.authority` should be `"clever"` (the Clever
  roster owns every record type, as `external:clever`) and `DISTRICT_CONFIG.rosterServicePrincipalId`
  names the `service` principal, granted district administration, that the sync acts as.
- `LTI_TOOL_ORIGIN` (optional): the LTI Tool's public origin (see [LTI 1.3 Tool](#lti-13-tool-scho-177)).
  It is not yet a deploy input, so the installer does not offer it; the schoolos.gmac.io production
  config sets it from the district hostname.
- `email` (optional, in `DISTRICT_CONFIG`): `from`, an address on a domain the district has
  onboarded to Cloudflare Email Service in this account, an optional `fromName`, and an optional
  `appUrl` linked from every email. Without it, or without the binding, nothing is emailed.

## Email and scheduled jobs (SCHO-189)

Notification and family digest email leaves through the `SEND_EMAIL` binding, a
[Cloudflare Email Service](https://developers.cloudflare.com/email-service/) `send_email` binding
in the district's own account. EducateOS hosts no sender (ADR-0011). The binding is unrestricted,
because recipients are the district's own principals, read from its directory. The sender is
`DISTRICT_CONFIG.email.from`, and its domain must be onboarded to Email Service before mail is
accepted. The district app sees only the `MailSender` interface, so an SMTP relay or another
provider can replace the adapter in `src/mail.ts`.

Two Cron Triggers run the district's communication jobs (`src/schedule.ts`):

| Cron | Job |
| --- | --- |
| `7 * * * *` | Brings every active student's in-app notifications up to date (new announcements and assignments, work due within 48 hours and not submitted, released feedback and grades), then emails those owed an email, honouring each principal's preferences. Notifications are keyed by what they are about, so a rerun adds and sends nothing twice. |
| `0 14 * * SUN` | Sends the weekly family digest for the week starting the next morning. Each guardian's week is claimed in a send ledger before the send, so it goes out at most once; a provider refusal is retried on the next run. |

The hourly trigger also runs whichever roster sync is due (SCHO-203): the head configuration
revision's `rostering` names the provider (only `clever` is wired in the Worker), its
`identityMapping`, `schedule` and `removalHold`, and `rostering.clever` the Clever district. The
sync reads the live directory, keeps only its mirror, cursors and run history beside it, and
applies through the same importer as a CSV import. A sync that would deactivate a large share of
the roster is held: `admin.rosterSyncStatus` shows it, `admin.approveRosterRemoval` approves exactly
that removal, and the next sync applies it; `admin.runRosterSync` runs one now. Without a token, a
Clever roster configuration or a roster service principal, the job logs why and does nothing; a
failed sync never stops the notification job.

The scheduled handler hands each trigger to the district's object (`DistrictObject.runScheduled`).
An expression it does not know runs nothing.

The release lists the package in `SERVICE_PACKAGES` (`scripts/release/manifest-lib.ts`), which
makes it kind `service`, singleton, and absent from previews. The backend binds it as
`EDUCATEOS_DISTRICT_API` → `DistrictApi`. That binding is deliberately not either `EDUCATEOS_DISTRICT`
entrypoint, because each of those is for one consumer only.

## Not done yet

- **Cron Triggers on install.** The release manifest carries the two schedules as `crons`, but the
  district installer does not apply Cron Triggers yet (SCHO-148). Until it does, set them on the
  Worker by hand, or nothing is emailed on a schedule. In-app notifications still update whenever
  a student opens them.
- **Email Service.** The deploy service must learn the manifest's `send_email` binding type before
  it can install this Worker; the installer's manifest schema accepts it.

- **Routing.** Nothing routes browsers to the district's `/api`. The instance router sends `/api/*`
  to the Workshop backend. Until that changes, the district needs its own hostname behind an Access
  application.
- **Consumer bindings.** No installer binds the guard's or the gatekeeper's `EDUCATEOS_DISTRICT` to
  `DistrictGuardDirectory` or `DistrictSchoolTools`. The manifest can only describe a binding the
  backend gains (`backendBinding`). Binding the guard and the gatekeeper needs a manifest field that
  both `@educateos/installer` and the hosted deploy service learn.
- **Tools.** The school tools are only the academic directory's operations. Assessment and artifact
  tools are still to come.
- **Codex.** Published class Codexes are stored in the object (`DurableObjectCodexPublisher`), not
  mapped onto the Context gatekeeper.
- **Scale.** Artifact records are one chunked document per district. The pilot gate's restore notes
  already ask for versioning per artifact (SCHO-108).
- **Two ledgers.** When the guard is installed, it keeps its own ledger (`DistrictAiLedger`). This
  object keeps the district app's ledger, which `aiGovernor` and the admin AI reports read.

## Tests

`pnpm --filter @educateos/district-worker test:run` runs the workerd suite (`vitest.config.ts`). The
key is an RSA Access signing key generated for each run, and the test `DistrictObject` (in
`__tests__/worker.ts`) verifies against it. It also serves a synthetic web. Everything else,
storage included, is the deployed code.

- `district.test.ts` drives the Worker's own fetch handler. It applies a OneRoster import, has a
  teacher set up an assignment and a student submit, then restarts the object
  (`evictDurableObject`). It reads the roster's new student, the assignment, the submission and its
  content back, and checks the `academic_*` rows. It also calls both entrypoints over real service
  bindings, and decides a queued school tool call after a restart.
- `stores.test.ts` covers the store paths the journeys do not reach: conflicts, refused rows,
  seeding, chunked objects and approval transitions.
- `lti.test.ts` registers a synthetic LMS by invitation, trusts and approves it, links a student
  and launches as her across a restart, and refuses a replayed launch, a launch signed by another
  key, one without the state cookie and one with the wrong nonce. It also keeps the tool keys and a
  rotation across restarts. The test object's `platformFetch` is the synthetic LMS.

## Workshop capability policy

`DistrictWorkshopCapabilityPolicy` is the backend-only `WORKSHOP_CAPABILITY_POLICY` service target
(SCHO-299, stacked on SCHO-292). It resolves current principal status and scoped roles from district
stores and applies ABAC to exact deployment grants. Without `DISTRICT_CONFIG.workshopPolicy` it
denies every request. No binding is enabled by this change. See
[security boundaries and integration wiring](../../docs/educateos/security/district-workshop-capability-policy.md)
before binding it; a binding holder is trusted to assert the Workshop user ID.
