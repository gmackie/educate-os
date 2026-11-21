# `npx launch-educate-os`

- Status: Published to npm as `launch-educate-os` (0.1.0, SCHO-341; 0.2.0 adds `connect`, `status`, `mcp` and
  `uninstall`, SCHO-406, SCHO-407, SCHO-368; 0.3.0 adds `mcp add --connector portal` and the `/mcp` Access
  bypass, SCHO-409). A full install
  into the owner's Cloudflare account completed on 2026-11-04 ([below](#live-install-2026-11-04));
  no district has run it yet.
- Code: `packages/launch-educate-os` (the npm package), `packages/educateos-control-plane/src/release-files.ts`
  (the release mirror on educateos.io).
- Operator docs: the package's [README](../../packages/launch-educate-os/README.md), which is also its
  npm page.

`launch-educate-os` is the district-run install path of `@educateos/installer` as one command. An
operator runs `npx launch-educate-os` on their own machine, answers a few questions, and ends with
EducateOS running in their own Cloudflare account. It is the same reconciler the guided install at
educateos.io/app/install runs, with the operator's machine in place of educateos.io: the token never
leaves that machine, and educateos.io serves only the release files.

## The package

One self-contained ES module, `dist/launch-educate-os.mjs`, bundled with esbuild
(`scripts/bundle.ts`) from `src/` and everything it imports: the installer, its workspace packages
and zod. It has no runtime dependencies and needs Node 22.12 or later. The npm tarball holds that
file, `package.json`, the README and the Apache-2.0 LICENSE.

| File | What it does |
| --- | --- |
| `src/cli.ts` | Commands (`install`, `plan`, `upgrade`, `rollback`, `doctor`, `uninstall`) and flags. |
| `src/wizard.ts` | The interactive questions. |
| `src/prompter.ts` | Terminal input, with hidden input in raw mode. |
| `src/release-source.ts` | Fetching a release over HTTPS or from a directory, verifying it, and the downgrade check. |
| `src/trust.ts` | The pinned release keys and the default mirror URL. |
| `src/run.ts` | Preflight, plan, confirm, apply, rollback and uninstall output, URLs and next steps. |
| `src/answers.ts` | `educateos-install.json`: the saved, non-secret answers and the install history. |
| `src/cloudflare.ts` | The installer's HTTP client plus account and zone listing, and the test bridge. |
| `src/output.ts` | Human and `--json` output, with every known secret redacted. |
| `src/connect/` | `connect` and `status` (SCHO-406): the LTI, Clever, Google Classroom and OneRoster flows, the district's HTTP surface, and the status report. |
| `src/mcp/*.ts` | `mcp status`, `mcp clients` and `mcp add` (SCHO-407): the answers file's MCP facts, the live checks, the client guides. |

The token permissions and the prefilled token-editor link moved from the control plane's `pages.ts`
to `@educateos/installer` (`src/permissions.ts`), so the guided install and the CLI send operators to
the same link.

## Releases: the public mirror and how they are verified

The site Worker (`educateos-site`) already had the `educateos-releases` bucket bound as `RELEASES`
for the guided install, but served nothing from it. SCHO-341 adds a read-only route,
`/releases/*` (in `run_worker_first` and `DYNAMIC_PATHS`):

| Path | Serves | `Cache-Control` |
| --- | --- | --- |
| `GET /releases/latest.json` | `{"releaseId": "<id>"}`: the newest complete release under `releases/` (`latestRelease`, which the guided install uses too) | `public, max-age=60` |
| `GET /releases/<id>/manifest.json` | the manifest | `public, max-age=300` |
| `GET /releases/<id>/manifest.signed.json` | the root's signed statement | `public, max-age=300` (it can be re-signed to extend its expiry) |
| `GET /releases/blobs/modules/<sha256>` | a Worker module or D1 migration | `public, max-age=31536000, immutable` |
| `GET /releases/blobs/assets/<hash>` | a static asset | `public, max-age=31536000, immutable` |

Only GET and HEAD. Every name is checked against its pattern before it becomes an R2 key, and
`candidates/` is never read: a candidate isn't signed until it passes the release gate. Anything else
under `/releases/` is a 404. `latestRelease` now passes over a release whose statement is uploaded
but whose manifest isn't yet (upload-release.ts writes the manifest last), rather than reporting no
release at all.

The launcher trusts none of it:

1. `latest.json` only names an ID.
2. The statement must verify against the release keys pinned in `src/trust.ts`, which are the
   site's `RELEASE_TRUST` (a test fails if they drift), and must name the ID that was asked for. A
   mirror that serves another release's genuine files under a newer ID is refused.
3. The manifest must hash to the statement's SHA-256.
4. The installer checks every module blob's SHA-256 and every asset's size as it uploads them.
5. A release older than the one the account runs is refused unless the operator runs `rollback` or
   passes `--allow-downgrade`. The installed release is read from the installer's marker on the
   backend Worker, its version from `educateos-install.json` or the installed release's own
   statement. Releases of the same version are ordered by their CI sequence number. A release whose
   statement says it can't upgrade from the installed version (`minimumCompatibleVersion`) is
   refused too.

This closes the downgrade the control plane names under "Release downgrade" for the CLI (whoever can
write to the bucket could delete newer releases so an older signed one is "latest"), not for the
guided install, which keeps no install history.

`--release-dir <dir>` reads the same files from a `build-release.ts` output directory instead, for
an air-gapped install. `--trust <file>` replaces the pinned keys, for a district or fork that signs
its own releases; it prints a notice that it is not using the EducateOS keys.

## What it installs

The answers become a `DistrictInstallConfig` (`--config` takes the same file): the account, a zone
and subdomain (or, where the account holds educateos.io, a managed-only `<slug>.educateos.io`), an
instance ID `ins_<name>`, the Zero Trust team read from the account, the admitted email domains and
addresses, the administrators, an optional AI Gateway, and optionally the district service with its
`DISTRICT_CONFIG` (one origin: the LMS at `/`, the Workshop at `/ai`) and the OSS admin.

When the team's only login methods are Cloudflare-account login or one-time email codes, the
wizard offers Google Workspace or Microsoft Entra ID (SCHO-443): it prints the account's Zero Trust
Authentication page (`https://one.dash.cloudflare.com/<account>/settings/authentication`) and
Cloudflare's setup steps, waits while you add it, and checks again. Declining keeps going; preflight
still blocks a team nobody at a school can sign in to, and warns on one-time codes alone.

A new install's answers also carry `"dataJurisdiction": "us"`: the district's Durable Object and the
install's KV namespaces, R2 buckets and D1 databases are created in Cloudflare's US jurisdiction
([ADR-0015](adr/0015-us-data-jurisdiction.md)). Answers saved before that have none, and stay
unpinned: Cloudflare can't move existing storage, so the installer refuses to add, change or remove
`dataJurisdiction` where the install's storage or district already exists.

Limits:

- **The district's starting configuration is written from answers (SCHO-441).** The wizard asks for
  the district's name, time zone and each administrator's name, and writes `DISTRICT_CONFIG` (and, for
  a school release, `MCP_CONFIG`): no people in the directory, the administrators as
  `bootstrapAdmins` (each created on their first sign-in with that email, then never again), and a
  Workshop policy that lets staff create workspaces and chat while students stay off (SCHO-442). The
  backend's `ADMINS` lists each as `principal:<id>` beside the emails, so they reach Workshop admin
  settings. Answer "no" to use your own JSON files instead.
- **No cross-account managed hostname.** `<slug>.educateos.io` on another account needs educateos.io
  to publish its DNS records (`applyManagedZone`), which only educateos.io's own token can do. The
  wizard offers the managed hostname only when the account holds educateos.io.
- **No registration with educateos.io.** Its registry accepts registrations only from the guided
  install (control-plane.md, "The opt-in registry"). `--registry-url` with a `fleet` section in the
  answers registers with another registry.
- **Gatekeepers beyond the preinstalled ones** are added by editing `gatekeepers` in the answers file.
  Their secrets are read from `EDUCATEOS_SECRET_<PKG>__<NAME>`, or asked for, hidden, on a terminal.

## MCP setup (SCHO-407)

`npx launch-educate-os mcp` guides district IT through MCP once EducateOS is installed. The guide is
[mcp-setup.md](mcp-setup.md); this is how the commands work.

| Command | Reads | Writes | Live checks |
| --- | --- | --- | --- |
| `mcp status` | the answers file; with `CLOUDFLARE_API_TOKEN`, the account's Worker list and the portal Worker's settings | nothing | the district's `/.well-known/oauth-protected-resource/mcp` and an unauthenticated `POST /mcp` |
| `mcp clients` | the answers file, or `--url` | nothing | the same, then the authorization server's RFC 8414 (or OpenID) metadata |
| `mcp add` | the answers file | the answers file, after showing the changes and asking (`--yes`) | the server: an MCP `initialize` with no credentials, its RFC 9728 metadata and its authorization server's metadata |

- **Where the answers come from.** `src/mcp/facts.ts` reads the install config (the public origin,
  `gatekeepers`) and, from the enabled service whose vars hold `DISTRICT_CONFIG`, only `mcp`,
  `workshopPolicy.connectors`, `workshopPolicy.teacherConnectors` and the trusted issuers. It doesn't
  bundle the district Worker, so the Worker still validates the whole `DISTRICT_CONFIG` when it starts.
- **What `add` changes.** `gatekeepers` gains `gatekeeper-mcp`, and `DISTRICT_CONFIG.workshopPolicy.connectors`
  gains `{"vendorId": "mcp", "access": "all"}`, the district Worker's vendor-wide grant (district
  administrators only). The vendor ID is the install slug the backend derives from the
  `GATEKEEPER_MCP` binding. Every other byte of `DISTRICT_CONFIG` is kept, re-serialized in the same
  style. A `DISTRICT_CONFIG` without `workshopPolicy` is left alone and reported, since writing one
  means deciding every other Workshop grant. `teacherConnectors` is never touched: it is for
  connectors confined to a teacher's own teaching, and an arbitrary MCP server isn't.
- **What it doesn't do.** It changes nothing in Cloudflare; `npx launch-educate-os --config <file>`
  applies the answers. It can't read or write Workshop admin settings (which connectors are offered:
  `AdminApi.setGatekeeperMode`) or connect a server for anyone (the connect flow is the Workshop's,
  with the server's own OAuth), because both need a Workshop session behind Cloudflare Access. It
  prints the pages and steps instead.
- **Live checks.** `src/mcp/probe.ts` sends no token or cookie and follows no redirect: a redirect to
  `<team>.cloudflareaccess.com` is reported as Access in front of the path. Bodies are read up to 64
  KiB, each request times out after 10 seconds, and an address the Workshop's connector would refuse
  (`isBlockedHost` from `@gadgets/mcp-shared/endpoint`, the same blocklist) is refused before any
  request. The checks run from the operator's machine, not Cloudflare, and say so.
- **The portal** (SCHO-409, added in 0.3.0; it needs a release built after SCHO-409, r000004 or
  later): `mcp add --connector portal` writes the portal's non-secret deploy
  inputs (`MCP_PORTAL_URL`, `MCP_PORTAL_NAME`, `MCP_PORTAL_AUTH`) to `gatekeeperInputs`; its token is
  the optional `MCP_PORTAL_TOKEN` secret, read at apply from
  `EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN`. The `/mcp` Access bypass is the
  installer's (`ACCESS_MCP_BYPASS_PATHS`, added when `DISTRICT_CONFIG` has `mcp`), so `status` failing
  an endpoint that is on but behind Access means the answers aren't applied yet.
- **The wizard** doesn't offer MCP setup at its end yet. The LMS connect offer (SCHO-406) owns that
  hook; a "Set up MCP now?" offer can follow it.

Not run against a live district: the district `/mcp` isn't deployed anywhere (NATH-6), and the
commands are tested against a scripted fetch and the installer's simulated Cloudflare.

## Uninstall (SCHO-368)

`npx launch-educate-os uninstall` removes an instance, for district offboarding
([runbooks/district-offboarding.md](runbooks/district-offboarding.md), step 5). It is the installer
library's `uninstall` (`packages/educateos-installer/src/uninstall.ts`), the installer CLI's
`uninstall` command too, and it needs the answers file and the install token, nothing else.

- **The release.** `--release <id>`, else the release the account's backend marker names, else the
  answers' last install, else the newest. The release only supplies the names of the install's
  Workers and storage; anything with the prefix it doesn't name is reported as `unclaimed`.
- **Plan by default.** Without `--confirm <instanceId>` it prints the plan and changes nothing. On a
  terminal it shows the plan and asks for the instance ID; a blank answer stops. `--yes` never
  deletes. A wrong ID exits 2 before any change.
- **What it deletes.** Workers carrying the instance marker; the custom domains, managed hostname
  and Worker routes routed to them; the Access applications (while they still front the install's
  hostname) and policies (once nothing uses them), the AI Gateway, KV namespaces, R2 buckets and D1
  databases by the exact names the config and release give them. Never a prefix match.
- **Order.** Hostnames, Workers (each after the Workers that bind it), Access, storage. A failure in
  a phase stops the next one, so storage never goes from under a running Worker.
- **R2.** The installer has no object operation, so it never empties a bucket. A non-empty bucket is
  refused by Cloudflare (code 10008) and reported with what to do; once the operator empties it,
  running again finishes.
- **Resumable.** Planning observes the account each run; a 404 on a delete counts as done.
- **Output.** The plan, each delete as it lands, failures, and the leftovers found by observing the
  account afterwards. With `--json`: `release`, `uninstall-plan` (steps, `unclaimed`, `registered`),
  `step` events and `done` with `status` `planned`, `removed`, `incomplete` or `refused`. Exit 0 for a
  plan or a clean removal, 1 for incomplete or a stopped prompt, 2 for a wrong confirmation.

Not yet run against a live Cloudflare account (SCHO-378). It was added in 0.2.0.

## Connect and status (SCHO-406)

`npx launch-educate-os connect [<integration>]` takes a district from install to a working LMS and
roster; the wizard offers it after a successful install of the district LMS. `status` reports what
is connected and healthy, and `doctor` ends with the same report. Both read the answers file for the
district's origin and Worker name, and need no release.

Every flow stores what the product already reads, through the path the product already uses. Nothing
new was added to the district:

| Integration | Stored in | How | Live check |
| --- | --- | --- | --- |
| Canvas, Moodle | The district's LTI stores | `POST /api/lti/invitations`, then `GET /api/lti/registrations`, `POST /api/lti/trusted-issuers`, `POST /api/lti/pending/<id>/approve` ([lti.md](lti.md)) | `GET /lti/jwks` (public) has keys; the registration is approved |
| Clever | `CLEVER_DISTRICT_TOKEN`, a Worker secret on the district Worker (district Worker README) | `putWorkerSecret` with the install token | `GET https://api.clever.com/v3.1/districts` reads the named district, then `users?limit=1` (roster scope) |
| Google Classroom | `GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY` (Worker secret) and `DISTRICT_CONFIG.classroom` plus `additionalTrustedIssuers` ([google-classroom.md](integrations/google-classroom.md#district-worker-connection-scho-255)) | `putWorkerSecret`; the answers file, applied with the installed release (never an upgrade) | A delegated token for the Workspace administrator at Google's token endpoint, then `GET /v1/courses` |
| OneRoster CSV | The district directory | `POST /api/admin/roster/preview`, then `apply` | The preview: every change, blocking on any error |
| Schoology | Not available | Schoology registers tools manually, and the district accepts only Dynamic Registration | |
| ClassLink | Not available | The district Worker builds no ClassLink or OneRoster API roster source; use a OneRoster CSV export | |

Credentials:

- **The district's admin API** (`/api/lti/*`, `/api/admin/*`) sits behind the district's Access
  application, and the district accepts only Access assertions there. The launcher sends a district
  administrator's own Access token (`cloudflared access token --app <origin>`) as `cf-access-token`,
  the way the runbooks' `curl` commands do, to the district's origin only, with redirects refused. A
  redirect to the Access team means the token wasn't accepted. Without a token, the flows print the
  requests to make. Access service tokens would need an identity link to a service principal, which
  nothing sets up yet, so the launcher doesn't use them.
- **Worker secrets** are set with the Cloudflare API token (`CLOUDFLARE_API_TOKEN`, asked for hidden
  when needed). The installer uploads Workers with `keep_bindings: ["secret_text"]`, so the secrets
  survive upgrades.
- **Provider credentials** (the Clever token, the Google key) are read hidden or from
  `EDUCATEOS_CLEVER_DISTRICT_TOKEN` and a file, registered for redaction, sent only to the provider
  and Cloudflare, and never written to the answers file.

Each flow returns `connected`, `pending` (a step remains in the other system or the admin console),
`failed` (a live check failed), `skipped` or `unsupported`, with next steps; `--json` emits one
`connect` event. Exit 0 for connected or pending, 1 otherwise. `status --json` emits one `status`
event with a row per area (`ok`, `not configured`, `failing`, `unknown`, `not available`) and its
fix; exit 1 when a row is failing.

Not proven live: no flow has been run against a real LMS, provider or district through this
command. The Canvas and Moodle registrations it drives passed live runs by hand (2026-10-26); Clever
roster sync and Google Classroom district roster sync have never imported a real roster
([maturity.md](maturity.md)). The Canvas click path ("Developer Keys > + Developer Key > LTI
Registration") is Canvas's documented Dynamic Registration entry, which the 2026-10-26 run could not
use on a single-domain Canvas.

## AI providers (SCHO-445, SCHO-446)

With an AI Gateway (the wizard's default), Workers AI is on from the first sign-in: the backend's
`CF_AI_GATEWAY_PROVIDERS` is `cloudflare`, and models run in the district's account through the
`WORKERS_AI` binding with no key. Anthropic and OpenAI stay off until an administrator adds a key:

```sh
npx launch-educate-os ai add anthropic     # or: ai add openai
npx launch-educate-os ai status
npx launch-educate-os ai remove anthropic
```

`ai add` shows what turning the provider on means (what staff and students type goes to that
provider), asks for the key without echo (or reads `EDUCATEOS_ANTHROPIC_API_KEY` /
`EDUCATEOS_OPENAI_API_KEY` with `--yes`), and checks its shape. It then lists the provider's models
through the district's own gateway with the key, which runs no model: a 401 or 403 is "that key was
rejected" and nothing is stored. A good key is stored as the gateway's default key for the provider
(`POST /accounts/{account}/ai-gateway/gateways/{gateway}/provider_configs`; Cloudflare keeps it in
the account's Secrets Store), the provider is added to the answers' `ai.providers`, and the install
is applied with the release the account runs. The key is never written to the answers file, a
Worker var, or any output, and a provider's error body is never read, since it can echo the key.

The token needs **AI Gateway: Edit** and **Secrets Store: Edit** besides the install's permissions.
`ai remove` takes the provider out of `ai.providers` and applies, which turns it off at once; the
key stays in the gateway until deleted in the dashboard (the command prints the link). A gateway
that already holds a default key for the provider is not overwritten: replace it in the dashboard.

## Tests

`packages/launch-educate-os/__tests__`:

- `connect.test.ts`: in process, against an installed district in the Cloudflare fake, a stand-in
  for the district Worker's HTTP routes (`connect-harness.ts`), `CleverDataFake`,
  `GoogleClassroomFake` and `GoogleServiceAccountTokenFake` (new in `@educateos/provider-fakes`):
  Canvas registration over two non-interactive runs, Moodle on a terminal, Access in front of
  `/lti/*`, no Access token, Schoology and ClassLink refused, Clever stored and refused (wrong
  district, declined), Google Classroom stored, configured and applied with the installed release
  (and refused without delegation), a OneRoster preview and apply, `status` healthy and failing, and
  the help text. The wizard test covers the end-of-install offer.

- `uninstall.test.ts`: in process: the plan by default, `--yes` and a wrong ID refused with nothing
  changed, `--confirm` removing everything with `--json` events, and the terminal prompt stopping on
  a blank answer and deleting on the instance ID.

- `mcp.test.ts`: in process, with a scripted fetch for the district endpoint, its authorization server
  and outside MCP servers: usage; `status` offline, live with the connectors' Workers in the fake
  account (the token never printed, no credential sent), an endpoint behind Access, an untrusted
  issuer, an endpoint configured on but 404, and one off as configured; `clients` with every guide,
  one guide as JSON, `--url` alone, an authorization server without metadata or registration, and a
  refused address; `add` saving the gatekeeper and the policy grant then finding nothing to change,
  refusing to save without `--yes`, asking on a terminal, following a 401 to an authorization server
  without registration, leaving a missing `workshopPolicy` alone, refusing a metadata address before
  any request, and the portal refused with nothing changed.
- `release-source.test.ts`: the mirror read, a statement signed by an unpinned key, a tampered
  statement and manifest, a mirror serving another release's files, a substituted blob and asset, the
  URL rules, the downgrade rules, and that the pinned keys equal the site's.
- `wizard.test.ts`: the CLI in process on a scripted terminal: a one-origin install with the OSS
  admin, the reuse of saved answers, a refused token asked again, hidden secret prompts, a declined
  plan, and no terminal.
- `e2e.test.ts`: the bundle as a child process, non-interactive with `--json`: plan, install, a no-op
  re-run, upgrade, a refused downgrade, rollback and doctor; an unpinned release refused before any
  Cloudflare call; an offline install from a directory; a substituted blob in a directory. Then
  `npm pack` of the staged package and `npx --yes ./launch-educate-os-0.1.0.tgz`, with `--help` and a
  plan.

The tests reach the installer's in-memory fake (`cloudflare-fake.ts`) through a loopback bridge
(`LAUNCH_EDUCATE_OS_TEST_CLOUDFLARE_RPC`, http on 127.0.0.1 or localhost only, announced on every
run), and releases signed by a key generated for the run, pinned with `--trust`.
`packages/educateos-control-plane/__tests__/release-files.test.ts` covers the mirror in workerd.

## Live install, 2026-11-04

`npx launch-educate-os` 0.1.0, from npm, installed signed release `r000002-f690372` from the
educateos.io mirror into the owner's Cloudflare account, at launch-trial.educateos.dev. It created
13 resources, and a second `plan` with the saved answers showed nothing to change.

What this does not show yet:

- **A district running it.** The account was the owner's, not a district's.
- **The district LMS through the installer.** Not verified; it needs a `DISTRICT_CONFIG` file (see
  Limits above).
- **Managed hostnames for other accounts.** `<slug>.educateos.io` is still possible only in the
  account that holds educateos.io (SCHO-243).

## Publishing

Deploy first, in this order:

1. **The site route.** Merge, then let `educateos-site` deploy (ForgeGraph app `educateos-site`), and
   check `https://educateos.io/releases/latest.json` answers a release ID.
2. **A signed release** under `releases/<id>/` with its blobs (`upload-release.ts` then
   `promote-release.ts`, signed with the release key `RELEASE_TRUST` pins). control-plane.md names
   `r000001-088ddc0` as the first one; once the route is live, `latest.json` shows the newest, and
   its statement must not have expired more than 30 days ago.
3. **A live check.** With a scoped token for a test account:
   `node packages/launch-educate-os/dist/launch-educate-os.mjs doctor`, then a plan.

Then publish from the package directory:

```sh
cd packages/launch-educate-os
pnpm exec vp run build              # tsc, then bundles dist/launch-educate-os.mjs
npm pack --dry-run                  # expect 4 files: LICENSE, README.md, dist/launch-educate-os.mjs, package.json
npm publish --access public         # prepack re-bundles first; needs an npm account with 2FA
```

`npm publish` keeps `workspace:*` in `devDependencies` as written, which is harmless (npx never
installs dev dependencies). `pnpm publish --access public` rewrites them to versions instead.

Provenance (`npm publish --provenance`) needs an OIDC token from a CI provider npm supports, such as
GitHub Actions with `id-token: write`. No workflow publishes to npm yet, so the first publish is
manual and without provenance. A GitHub Actions job on a tag can add it later.
