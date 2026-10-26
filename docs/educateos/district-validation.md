# EducateOS district validation suite

- Status: Living document. The report below comes from CI; regenerate it with the suite.
- Issue: SCHO-205 (umbrella SCHO-198)
- Package: `packages/educateos-pilot-gate` (`@educateos/pilot-gate`, test-only)

The district validation suite runs every integration scenario in each of the six demo districts
(`@educateos/fixtures`) whose integration profile calls for it. Each scenario runs in process,
against the wire-faithful provider fakes (`@educateos/provider-fakes`). The pilot gate
([pilot-gate.md](pilot-gate.md)) checks the roadmap's rows against Northfield and Riverbend. This
suite checks the integration profiles, district by district.

A pass against a fake is not evidence of interoperating with the vendor; see
[maturity.md](maturity.md#provider-fakes). Real vendor sandbox runs are SCHO-211.

## How it runs

```sh
node scripts/vp/run.ts --filter=@educateos/pilot-gate test          # the suite, as CI runs it with the package tests
pnpm --filter @educateos/pilot-gate district-report --out report    # run it and write the gate report (CI's artifact)
pnpm --filter @educateos/pilot-gate district-report --target https://northfield.educateos.io   # the live stub
```

- **`src/districts.ts`** is the registry. It holds every scenario and, for each district, whether
  the scenario runs, is blocked by an unmerged issue, or is not part of the district's profile. It
  decides from the district's integration profile (and, for guardians, its data), never from the
  district's name.
- **`__tests__/district-scenarios.ts`** holds the scenario bodies. Each body is written once and
  acts through the district's own people and classes (`castOf`).
- **`__tests__/districts.<slug>.test.ts`** registers one district each, so the districts run in
  parallel. A cell that runs needs a body. A blocked cell is an `it.todo` that names its issues.
- **`districtSeed(demo)`** (`@educateos/fixtures`, from SCHO-203) adapts a district to the fakes'
  seed. Seed IDs are fixture IDs, so a scenario compares a synced directory with the fixture by
  `sourcedId` (`fixtureShape`), whatever IDs the import mints.
- **`src/validate.ts`** joins the registry with a run. It prints the report, writes
  `district-report.md` and `district-report.json` with `--out`, and exits non-zero when a cell
  that runs is NOT MET.

## Reading the report

- **MET**: the scenario passed in this run.
- **NOT MET**: the scenario applies and runs, and failed or did not run. CI fails on it.
- **NOT YET APPLICABLE**: the scenario applies, but needs an unmerged issue. The cell names the issue
  and says what is missing. It never passes on a fake.
- **Not in profile** (—): the district has no such integration, for example LTI in a district on
  LMS-lite.

A scenario marked *direct* calls a domain package where the district app routes nothing for it.
Examples: the OneRoster REST sync, the LTI Tool handler (which the district Worker serves), the
student exporter and the fleet's entitlement cache. The report lists why for each one.

## What waits on what

| Issue | What it turns on |
| --- | --- |
| SCHO-203 Clever connector (merged) | On. Cedar Valley's vendor SSO, first and delta sync, hold and outage run against the Clever Data API and OIDC fakes. Its drop and term rollover wait on SCHO-242. |
| SCHO-204 ClassLink connector (merged) | On. Lakeshore's roster syncs through `classLinkRosterSource` from the ClassLink Roster Server fake, and its vendor SSO signs each role in through `classLinkSignIn` against the ClassLink OIDC fake, keyed on `preferred_username` (the OneRoster `username`). Wiring ClassLink sign-in into the district Worker is SCHO-248. |
| SCHO-77 Classroom district sync (merged) | On. Harbor's first sync, hold and outage run through `classroomRosterSource` against the Google Classroom fake; Classroom has no delta, so `roster-delta` is not in Harbor's profile. Classroom coursework and LMS outage run through `GoogleClassroomProvider` and `GradePassback` in Harbor (over its Classroom-synced directory) and Cedar Valley (over its directory linked to Classroom: every account link there is a name match, accepted in bulk, where production needs an administrator to confirm each). Harbor's drop and term rollover wait on SCHO-242. |
| SCHO-215 Google Workspace sign-in | Harbor's vendor SSO |
| SCHO-180 provider health and hold | The large-removal hold for Northfield's CSV upload. The sync runner holds a large removal since SCHO-203, and the REST districts check it, but `admin.applyRoster` does not use the runner. |
| SCHO-242 apply provider syncs to the district app | Drop and term rollover over HTTP in Riverbend and Lakeshore (OneRoster REST), Cedar Valley (Clever) and Harbor (Google Classroom) |
| SCHO-210 deploy the demo districts | Every scenario against a live district |

## The live target

`--target https://<slug>.educateos.io` probes a deployed district, read-only. It sends GET
requests only and follows no redirect. Today it checks four things:

- the liveness probe (`/healthz`);
- that Cloudflare Access guards the API;
- that the LTI Tool's JWKS (`/lti/jwks`) is served without Access, as an LMS needs;
- with an Access service token, that Access admits the suite.

Every integration scenario is NOT YET APPLICABLE there until SCHO-210 deploys the provider fakes
beside each district and gives the suite a way to act as a person.

The service token is not configured yet. It needs:

1. an Access service token;
2. a Service Auth policy on the district's Access application;
3. the token's ID and secret, given to the suite as `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET`, never on the command line.

## Findings

What the first runs found, beyond the scenarios that wait on connectors:

- **The CSV upload has no large-removal hold.** `runRosterSync` holds a feed that would
  deactivate most of the roster (SCHO-203), but `admin.applyRoster` imports the upload directly,
  so a botched CSV export still applies in full (SCHO-180).
- **Provider syncs never reach a running district.** The district app applies only uploaded CSV
  rosters, so a OneRoster REST, Clever or Classroom district's drops and term ends never reach the
  running app (SCHO-242).
- **`districtSeed`'s usernames are not the directory's subjects.** The adapter derives each
  username from the fixture ID, while Lakeshore's directory subjects are ClassLink login IDs. The
  suite's ClassLink roster seeds each username with the person's directory subject, as SCHO-204's
  own tests do, so the roster sync and ClassLink's `preferred_username` key the same person.
- **Harbor's fixture subjects are not the Classroom fake's user IDs.** The Classroom fake (and the
  Google OIDC preset) derive each Google user ID from the seed, so a Classroom-synced Harbor
  directory keys people on IDs other than the fixture's `1040…` subjects. The scenarios compare by
  fixture ID, so they are unaffected; Google sign-in (SCHO-215) will need the two to agree.
- **The harness boots every district as OneRoster-owned.** That includes Prairie, which has no
  roster source, so its administrator could not edit its own directory. The harness also leaves
  out each district's guardian relationships, which the directory snapshot does not carry. The
  suite boots Prairie with `local` authority and records the guardians itself (`bootDemo`). The
  harness CLI still has both gaps.
- **northfield.educateos.io keeps `/lti/*` behind Access.** `district.schoolos.gmac.io` serves the
  LTI Tool, but its alias at northfield.educateos.io keeps `/lti/*` behind Access, so a Canvas
  launch cannot reach it there. The live probe `live-lti-public` reports it.
