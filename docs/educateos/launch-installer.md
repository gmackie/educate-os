# `npx launch-educate-os`

- Status: Published to npm as `launch-educate-os` 0.1.0 (SCHO-341, epic SCHO-320). A full install
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
| `src/cli.ts` | Commands (`install`, `plan`, `upgrade`, `rollback`, `doctor`) and flags. |
| `src/wizard.ts` | The interactive questions. |
| `src/prompter.ts` | Terminal input, with hidden input in raw mode. |
| `src/release-source.ts` | Fetching a release over HTTPS or from a directory, verifying it, and the downgrade check. |
| `src/trust.ts` | The pinned release keys and the default mirror URL. |
| `src/run.ts` | Preflight, plan, confirm, apply and rollback output, URLs and next steps. |
| `src/answers.ts` | `educateos-install.json`: the saved, non-secret answers and the install history. |
| `src/cloudflare.ts` | The installer's HTTP client plus account and zone listing, and the test bridge. |
| `src/output.ts` | Human and `--json` output, with every known secret redacted. |

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

Limits:

- **The district LMS needs a `DISTRICT_CONFIG` file.** Its seed directory names the administrators by
  their Access subject, which nobody knows before they first sign in, so the wizard can't write one.
  Without it the install is the Workshop alone, as the guided install's is.
- **No cross-account managed hostname.** `<slug>.educateos.io` on another account needs educateos.io
  to publish its DNS records (`applyManagedZone`), which only educateos.io's own token can do. The
  wizard offers the managed hostname only when the account holds educateos.io.
- **No registration with educateos.io.** Its registry accepts registrations only from the guided
  install (control-plane.md, "The opt-in registry"). `--registry-url` with a `fleet` section in the
  answers registers with another registry.
- **Gatekeepers beyond the preinstalled ones** are added by editing `gatekeepers` in the answers file.
  Their secrets are read from `EDUCATEOS_SECRET_<PKG>__<NAME>`, or asked for, hidden, on a terminal.

## Tests

`packages/launch-educate-os/__tests__`:

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
