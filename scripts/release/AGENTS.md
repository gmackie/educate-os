# Release pipeline

How customer instances get deployed.

- `build-release.ts` bundles every deployable worker byte-identically (wrangler dry-run with the
  pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest —
  the contract between this repo's CI and the deploy service, produced by `manifest-lib.ts` from each
  package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`,
  `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
- `upload-release.ts` mirrors the release to R2 content-addressed, manifest last; with `--candidate`
  the manifest lands under `candidates/<id>/` (invisible to the deploy service) so e2e can verify it,
  and `promote-release.ts` then copies it to `releases/<id>/` — publishing is that single
  all-or-nothing manifest copy. The copy is not isolated against concurrent promotions, so CI
  serializes promote runs (a GitLab resource group) and the script's newer-release guard skips
  candidates that a later release has already superseded.
- The manifest is covered by a golden-file test; after an intentional manifest change, regenerate
  with `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts` and review the golden diff.
- Running the flow by hand (upload and promote need `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`):
  - `node scripts/release/build-release.ts --out release-out` — build everything into `release-out/`
    (id defaults to `r<CI_PIPELINE_IID>-<sha7>` in CI, `dev-<timestamp>` locally; override with
    `--release-id <id>`).
  - `node scripts/release/upload-release.ts --release release-out --candidate` — mirror to R2; omit
    `--candidate` to publish directly (bypasses the gate — CI never does this).
  - `node scripts/release/promote-release.ts --release-id <id>` — copy the verified candidate's
    manifest into `releases/<id>/`.

## Deploy-wizard inputs

An installable gatekeeper's user-supplied inputs default to OAuth `CLIENT_ID`/`CLIENT_SECRET`
secrets; a per-package `deploy-inputs.json` overrides them, and `NO_DEFAULT_CRED_INPUTS` in
`manifest-lib.ts` opts out gatekeepers that take no third-party OAuth app credentials (the wizard
blocks Install on unfilled secret inputs, so a spurious default makes a gatekeeper uninstallable).
Backend instance-state vars (`ADMINS`, `CLOUDFLARE_OS_DEPLOYMENT`, ...) are injected by the deploy
service at PUT time, never manifest-templated.

## EducateOS deployment extensions

- A worker's `d1_databases` become `{ type: "d1", name, id: "$D1_<BINDING>_ID" }` bindings, and the `.sql` files in each database's `migrations_dir` (named `NNNN_<words>.sql`) ship as the entry's `d1Migrations`, content-addressed in `modules/` like worker modules. Workers without D1 carry no `d1Migrations` field, so their manifests are unchanged; the hosted deploy service must learn `$D1_<BINDING>_ID` before a deployable package declares a D1 database.

- EducateOS signing: with `EDUCATEOS_RELEASE_SIGNING_KEY` set (the root release key, an Ed25519 private JWK held as a CI secret), `build-release.ts` and `promote-release.ts` write the root's `SignedReleaseManifest` beside the manifest as `manifest.signed.json` (`scripts/release/release-signing.ts`); they then also need `--version <semver> --channel <canary|stable|lts>`. Set the key on the promote job only, so only e2e-verified releases are ever signed. Without it the build is an unsigned development release, which `@educateos/installer` accepts only under its `insecure-pin` mode. See `docs/educateos/release-signing.md`.

- A deployable package that is neither core nor `gatekeeper-*` must be listed in `SERVICE_PACKAGES` in `manifest-lib.ts` (or the release build throws). Such a package is an optional backend service, kind `service`: the backend binds it under a fixed name (`backendBinding`, e.g. `AI_CALL_GUARD` for `educateos-ai-guard`), it is installable once, its wizard inputs come only from its `deploy-inputs.json`, and previews leave it out.

## District school shell integration status

The school shell opt-in introduced by UI PR #9 (`VITE_EDUCATEOS_SCHOOL_MODE=true`) is **not yet wired into the district release defaults**. `build-release.ts` explicitly sets only `VITE_CF_ACCESS_MODE=true` when it builds the Access asset variant; `.forgegraph.yaml`'s district router build command also sets only that Access flag. The installer consumes the already-built, signed manifest and content-addressed assets; it cannot switch this compile-time frontend option during installation. A signed district release alone therefore does not prove that its frontend contains the school shell.

A district build must explicitly supply `VITE_EDUCATEOS_SCHOOL_MODE=true` when building frontend assets, before manifest generation/signing. The frontend build task already fingerprints and forwards `VITE_*`. Keep the generic upstream build default unchanged; coordinate district-only build wiring with PR #9 before claiming end-to-end school-shell delivery. This inspection did not change build flags, deployment configuration, credentials, or frontend code.
