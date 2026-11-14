# Dependency vulnerability scanning

- Status: In place since SCHO-375 (parent SCHO-358), 2026-11-13
- Code: `scripts/security/dependency-audit.ts` (CLI), `scripts/security/dependency-audit-lib.ts`
  (the rules, unit-tested in `dependency-audit-lib.test.ts`)
- Baseline: `scripts/security/dependency-audit-baseline.json`
- CI: the `Dependency vulnerability audit` step of the `ci` job in `.forgejo/workflows/ci.yml`

CI checks every pnpm lockfile in the repository against the npm registry's advisory database on
every pull request, every push to `main` and the nightly run. A pull request that adds a high or
critical advisory to a production dependency fails. Advisories that were already there are written
down in a baseline, each with a reason and an issue, so they are tracked and do not hide new ones.

## The tool: `pnpm audit`

The scan runs `pnpm audit --json` (all dependencies) and `pnpm audit --prod --json` (production
dependencies) for each lockfile:

| Lockfile | Workspace |
| --- | --- |
| `pnpm-lock.yaml` | the root workspace: every package under `packages/`, the sites and `scripts/` |
| `apps/mobile/pnpm-lock.yaml` | the Expo app, a separate workspace |
| `tools/launch-factory/pnpm-lock.yaml` | the Launch Factory video engine, a separate workspace |

Why `pnpm audit` and not OSV-Scanner:

- **It is already there.** The CI container has pnpm through Corepack, at the exact version
  `packageManager` pins (11.17.0). OSV-Scanner is not installed in the runner image or in the
  repository, and adding it means downloading and pinning a Go binary on every run.
- **It reads the lockfile, not `node_modules`.** It needs no install, so it adds no install time.
  `apps/mobile` and `tools/launch-factory` are audited without installing them. A run takes
  seconds.
- **It knows pnpm's dependency types.** `--prod` drops `devDependencies`, which is what the gate
  needs, using pnpm's own reading of the lockfile and its workspace importers.
- **Same data.** `pnpm audit` asks the registry's bulk advisory endpoint, which serves the GitHub
  Advisory Database. OSV imports that database too, so the coverage for npm packages is the same.

It does need the registry. If the registry cannot be reached (after one retry), the scan prints a
warning that names the lockfile it skipped and passes, so an outage cannot block a merge. The next
run reports what that one missed. It is not a static-analysis (SAST) scanner and does not look at
EducateOS's own code.

## What fails CI

| Run | Fails the `ci` job when |
| --- | --- |
| Pull request | A **high or critical** advisory in a **production** dependency (`dependencies` or `optionalDependencies`, as `pnpm audit --prod` sees them) that is **new**: the vulnerable version is not in the base branch's copy of the lockfile, and no live baseline entry covers it. Also when the baseline file is invalid. |
| Push to `main`, nightly | Only when the baseline file is invalid. Everything else is reported as warnings. |

Everything else is reported but does not fail:

- moderate, low and info advisories;
- advisories in dev-only dependencies;
- high or critical advisories that are **already on the base branch** but not in the baseline, for
  example an advisory published today against a version `main` already has. These print
  "Unbaselined" warnings until someone triages them;
- baseline entries whose `expires` date has passed. They print a warning asking for re-triage.
  They fail a pull request only if that pull request also introduces the version;
- baseline entries the audit no longer reports, which print a notice to remove them.

So upstream noise (a new advisory against something `main` already depends on) never turns `main`
or an unrelated pull request red. It shows up as a warning in every run until it is triaged. This
follows the advisory pattern SCHO-357 used for `workshop-tests`: the step's last word is a warning,
and the log keeps the details.

The step is part of the gating `ci` job, so on a pull request its failure is reported to
ForgeGraph like any other gate failure.

## Triage

When the step fails on your pull request, or a run prints an "Unbaselined" warning:

1. **Read the advisory.** The message names the advisory ID and URL, the package, the installed
   version, the fixed range and one dependency path.
2. **Upgrade if you can.** Bump the direct dependency (or its catalog entry in
   `pnpm-workspace.yaml`), or add a `pnpm.overrides` entry for the transitive package after
   checking the fixed version is compatible. Remember pnpm's one-day `minimumReleaseAge`: a fix
   released today installs tomorrow.
3. **Otherwise judge exposure.** Ask whether the vulnerable code runs where it matters: in a Worker
   bundle, the district app, the mobile app binary, or only on developer machines and in builds.
   A build-time-only path is lower risk, but it is still a production dependency to `pnpm audit`.
4. **Record the decision.** If the advisory stays for now, file a Kanbanger issue (team GMA,
   project EducateOS) for the upgrade and add a baseline entry. If it is a critical advisory in
   code that ships to a district, fix it before merging; don't baseline it.

Targets: critical advisories in shipped code are fixed before the next release. High advisories
get an issue and a baseline entry with an expiry of at most 90 days.

## Adding a baseline entry

Add an object to `advisories` in `scripts/security/dependency-audit-baseline.json`:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "lockfile": "pnpm-lock.yaml",
  "package": "extract-zip",
  "severity": "high",
  "title": "The advisory's title, for readers",
  "reason": "Why it is acceptable for now: where the code runs, why it is not reachable, what blocks the upgrade.",
  "issue": "SCHO-387",
  "expires": "2027-02-13"
}
```

- `id` is the GHSA ID from the scan's message. An advisory with several affected versions needs
  one entry per lockfile, not per version.
- `lockfile` is the lockfile the advisory was reported for. An entry covers only that lockfile.
- `reason` must say why the risk is accepted. "False positive" alone is not a reason.
- At least one of `issue` (the Kanbanger key that tracks the upgrade) and `expires` (YYYY-MM-DD)
  is required. Use both. After `expires`, the entry stops suppressing the advisory and the run
  warns again, which forces a second look.
- When the upgrade lands, the run prints a notice for each entry the audit no longer reports.
  Delete those entries in the same pull request.

`node --test scripts/security/dependency-audit-lib.test.ts` validates the checked-in file, and
the CI step rejects an invalid one. Run the scan locally with
`node scripts/security/dependency-audit.ts` (report only), or
`node scripts/security/dependency-audit.ts --base-ref main --base-remote <remote>` to gate as a
pull request would.

## Who reviews

A baseline entry is a risk acceptance, so it is reviewed in the pull request that adds it like any
other change, by the repository owner (Gmacko Ventures LLC, the EducateOS maintainer), who also
decides on expiries and re-triage. Reviewers check that the reason is specific, that the issue
exists, and that the expiry is no more than 90 days out. Unbaselined warnings on `main` are the
owner's to triage within a week.

## Baseline at introduction (2026-11-13)

| Lockfile | Critical | High | Moderate | Low | Issues |
| --- | --- | --- | --- | --- | --- |
| `pnpm-lock.yaml` (production deps; dev-only adds none) | 0 | 4 | 10 | 1 | SCHO-386 (vite 7.3.6), SCHO-387 (extract-zip and basic-ftp via `@cloudflare/puppeteer`) |
| `apps/mobile/pnpm-lock.yaml` (all production) | 0 | 9 | 9 | 7 | SCHO-388 (node-forge and zod via `@expo/cli`) |
| `tools/launch-factory/pnpm-lock.yaml` | 0 | 0 | 0 | 0 | |

The 13 high advisories are in the baseline. None of the vulnerable code runs in a Worker or the
app binary: vite is a build tool, extract-zip and basic-ftp sit on `@puppeteer/browsers`' Node-only
download and proxy paths, and node-forge and zod come with the Expo CLI.

Since then, SCHO-386 and SCHO-387 cleared `pnpm-lock.yaml`: the vite catalog pin moved to 7.3.7,
and `@cloudflare/puppeteer` 2.0 no longer depends on `@puppeteer/browsers`, so extract-zip,
basic-ftp and ip-address left the lockfile. Their four baseline entries were removed, leaving the
nine node-forge and zod entries for `apps/mobile/pnpm-lock.yaml` (SCHO-388).
