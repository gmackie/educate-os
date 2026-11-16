# Backup and restore for a district installation

- Status: Draft. The district object's restore routes are tested in workerd; no restore has run
  against Cloudflare's own storage yet (see [Rehearsal log](#rehearsal-log)).
- Date: 2026-11-14
- Issue: SCHO-373 (parent SCHO-358). Follow-ups: SCHO-395 (live restore rehearsal), SCHO-396
  (scheduled locked export and an importer), SCHO-397 (Workshop, AI guard, gatekeepers, KV, R2).
- Code: `packages/educateos-district-worker/src/recovery.ts`

A district installation runs in the district's own Cloudflare account ([ADR-0001](../adr/0001-district-data-ownership.md)),
so its backups are the district's, and so is running this runbook. Gmacko Ventures LLC holds no
copy. This page lists what an installation stores, what Cloudflare can recover for each store, what
EducateOS adds, the recovery targets those mechanisms support, and the steps.

## What an installation stores

From the Worker configs (`packages/*/cloudflare.config.ts` and the generated `wrangler.jsonc`), the
installer's desired state (`packages/educateos-installer/src/desired.ts`) and
[installer-permissions.md](../installer-permissions.md):

| Store | What it holds | Where |
| --- | --- | --- |
| District Durable Object (SQLite), `DistrictObject` in `educateos-district-worker`, one per district | Every record of the district application: directory, enrollments, roles, workspaces, artifacts and their content (in 1 MiB SQLite parts), submissions, grades, feedback, class content, discussions, quizzes, configuration revisions, Content Studio, guardians, devices, the district app's AI ledger, the policy audit trail | [district-worker README](../../../packages/educateos-district-worker/README.md), "Storage" |
| Workshop backend Durable Objects (SQLite): `UserDurableObject` (one per user), `OverseerDurableObject`, `AdminSettings`, `UserDirectoryDurableObject`, `AdminAuditDurableObject`, `PendingLogin` | The AI Workshop: each user's gadgets, agents, chats and capabilities; site settings; the Workshop admin audit | `packages/workshop-backend/cloudflare.config.ts` |
| AI call guard, `DistrictAiLedger` (SQLite), optional | The guard's spend ledger | `packages/educateos-ai-guard` |
| Gatekeeper Durable Objects (SQLite) | Connected accounts' OAuth credentials and per-resource state; the scheduler's schedules; the Context Library's collections | `packages/gatekeeper-*` |
| Workers KV: `BLUEPRINTS`, `AVATARS` (Workshop backend), `CONTEXT_COLLECTIONS` (Context gatekeeper) | Workshop admin configuration, featured and published blueprint records, avatars, public collection index | `packages/workshop-backend/src/admin-settings.ts`, `overseer.ts`; `packages/gatekeeper-context` |
| R2: `BLUEPRINT_CONTENT` (Workshop backend) | Blueprint code snapshots, blueprint screenshots, the site logo | `packages/workshop-backend/src/blueprint-archive.ts` |
| D1: the OSS admin's database, only when `admin.enabled` | The operations console's enrollment and audit records (no student records) | `packages/educateos-admin` |
| Worker secrets and vars | Access settings, `DISTRICT_CONFIG`, integration credentials (Clever, Google Classroom, LTI), Hall Monitor key, `DEVICE_TOKEN_SECRET` | Each Worker; [installer-permissions.md](../installer-permissions.md) |
| Worker code and settings | The signed release | The release manifest and the installer |

Every Durable Object class in an installation is SQLite-backed (each config's migrations use
`new_sqlite_classes` only), which is what point-in-time recovery needs. The district Worker has no
D1 database or R2 bucket: every district record, file content included, is in its one object.

## What Cloudflare can recover, and what EducateOS adds

Checked against Cloudflare's documentation on 2026-11-14.

| Store | Platform mechanism | What EducateOS adds |
| --- | --- | --- |
| SQLite Durable Objects | **Point-in-time recovery, 30 days.** `ctx.storage.getBookmarkForTime(time)` gives a bookmark for a moment in the last 30 days; `onNextSessionRestoreBookmark(bookmark)` restores the object's whole SQLite database (SQL and key-value data) to it on the object's next start, and returns a bookmark that undoes the restore; `ctx.abort()` restarts the object. It can only be called from code running inside the object, and is not available in local development. ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) | **District object:** the `/api/recovery/*` routes (SCHO-373, below). **Other objects:** nothing yet (SCHO-397). |
| D1 | **Time Travel**: restore to any minute in the last 30 days on Workers Paid (7 days on Free) with `wrangler d1 time-travel restore <db> --timestamp=<time>`; destructive and in place, and it returns a bookmark that undoes it; no extra cost. ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)) | Nothing needed: the command is enough. Only the optional OSS admin uses D1. |
| R2 | **No point-in-time recovery and no object versioning** (`PutBucketVersioning` is listed as unimplemented in the [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) page). [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) can stop deletes and overwrites for a retention period. | Nothing yet. Proposed: a scheduled copy to a second, Bucket-Locked bucket (SCHO-397). |
| Workers KV | No backup, versioning or recovery of deleted keys documented. | Nothing yet (SCHO-397). Most of it is re-creatable: admin settings are re-entered, avatars re-uploaded. |
| Worker secrets | Write-only: Cloudflare never shows a secret's value after it is set ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). | None to add. The district keeps its own record of each secret it supplied (its install config and secret source). Generated ones (`DEVICE_TOKEN_SECRET`) are regenerated, which signs phones out. |
| Worker code | Worker versions, and redeploying a version. | The installer reinstalls a signed release, and rolls back to the previous release's versions ([release-signing.md](../release-signing.md)). |

Three limits apply to all of the platform mechanisms: they recover within the same account, so they
do not cover deleting the Worker (which deletes its Durable Objects' data), deleting the account,
or anything older than 30 days. The **district export** (`admin.exportDistrict`,
[educateos-archive-format.md](../educateos-archive-format.md#district-export)) is a copy of the
district's records the district can keep anywhere, but EducateOS has no importer for it yet, so it
is a record of the data, not a backup EducateOS can restore from (SCHO-396).

## Recovery targets

These are **targets** the mechanisms above support, for a district operator following this runbook.
They are not a service commitment by Gmacko Ventures LLC, which does not operate the installation.

| Scenario | RPO target | RTO target | Why |
| --- | --- | --- | --- |
| District records damaged or deleted (a bad import, a bad roster sync, an operator mistake, a bug), found within 30 days | **5 minutes** before the damaging event | **4 business hours** from the decision to restore | Point-in-time recovery restores to any moment in 30 days, so the restore point can be chosen just before the damage; 5 minutes leaves room for placing the event from logs. A restore takes the whole district back: every write after the restore point is lost, good ones included, so the true loss is the RPO plus the time from the event to the restore. The restore itself is one request and a restart; the 4 hours is for finding the event in the logs, a district export of the damaged state, the decision, and checking the result. |
| OSS admin database damaged (only when enabled) | 1 minute | 4 business hours | D1 Time Travel restores to any minute in 30 days, with one command. |
| Workshop, AI guard or gatekeeper data damaged | Not committed | Not committed | The platform keeps 30 days of history for each object, but EducateOS has no way to restore them yet (SCHO-397). Gatekeeper credentials can be reconnected. |
| KV or R2 content lost | Not committed | Not committed | No platform backup (SCHO-397). |
| A Worker's code or settings broken | None lost | 1 business hour | Reinstall the release, or the installer's rollback. No data is involved. |
| District Worker deleted, Cloudflare account lost, or damage found after 30 days | Not covered | Not covered | Platform recovery does not reach these, and there is no importer for the district export yet (SCHO-396). Until then, a district that keeps regular district exports keeps a copy of its records, not a way to restore them into EducateOS. |

## Restore the district object to a point in time

The routes are `GET /api/recovery/bookmark[?at=<time>]` and `POST /api/recovery/restore`
(`packages/educateos-district-worker/src/recovery.ts`). They are 404 unless the district Worker has
a `RECOVERY_TOKEN` secret of at least 32 characters, and each request needs both that token and a
Cloudflare Access sign-in to the district (Access is not bypassed on these paths). They run before
the district application starts, so a district that no longer starts can still be restored, and
they use none of the district's records to decide who may call them.

What a restore does: the district object's whole SQLite database (every record and file of the
district) returns to the bookmark. Everything written after it is gone, including the policy audit
trail's records, devices paired since (their phones pair again), and the district app's AI ledger
entries. The AI call guard's own ledger, the Workshop and the gatekeepers are not restored, and may
refer to records the district no longer has. The next hourly roster sync reapplies the provider's
roster.

1. **Find the moment.** From the district Worker's logs (Workers Logs in the district's account),
   find when the damage began. Pick a restore time before it, in UTC.
2. **Keep the damaged state.** A district administrator takes a district export
   (`GET /api/admin/district/export.zip`, [offboarding runbook](district-offboarding.md), step 1),
   so writes after the restore point can be re-entered by hand.
3. **Turn the routes on.** As someone who can edit the district Worker:

   ```sh
   openssl rand -hex 32 | npx wrangler secret put RECOVERY_TOKEN --name <district worker>
   ```

   Keep the value for the next steps (the token never appears in logs). Setting a secret deploys a
   new version of the Worker, which restarts the object; nothing else changes.
4. **Read the bookmarks.** Through Access (for example `cloudflared access curl`, which adds the
   Access sign-in), with the token:

   ```sh
   cloudflared access curl "https://<district host>/api/recovery/bookmark?at=2026-11-14T13:55:00Z" \
     -H "authorization: Bearer $RECOVERY_TOKEN"
   ```

   The answer gives `current` (now) and `at.bookmark` (the restore point). Save both. `at` is an
   ISO 8601 time or epoch milliseconds, within the last 30 days and not in the future.
5. **Restore.**

   ```sh
   cloudflared access curl -X POST "https://<district host>/api/recovery/restore" \
     -H "authorization: Bearer $RECOVERY_TOKEN" -H "content-type: application/json" \
     -d '{"districtId":"<district ID from DISTRICT_CONFIG>","bookmark":"<at.bookmark>"}'
   ```

   It answers `202` with `undoBookmark`: **save it**. The object restarts a quarter of a second
   later and comes back at the bookmark. A wrong district ID is `409`; nothing is scheduled.
6. **Check.** Sign in as a district administrator: the admin console's health counts, and the
   records the damage touched, are as they were at the restore point. If nothing changed, the
   object did not restart: deploy the Worker again (`npx wrangler secret put` of the same token
   does it) and check again.
7. **Undo, if needed.** `POST /api/recovery/restore` with `undoBookmark` returns the district to
   the moment before the restore. It can be undone in turn, the same way.
8. **Turn the routes off.** `npx wrangler secret delete RECOVERY_TOKEN --name <district worker>`.
   The district Worker logs each step (`district.recovery.bookmark`, `district.recovery.restore`,
   `district.recovery.refused`, `district.recovery.failed`, component
   `educateos.district.recovery`) with the bookmarks and the operator's Access issuer and subject,
   so the record of the restore survives the restore.

## Restore the OSS admin database

```sh
npx wrangler d1 time-travel info <database> --timestamp=2026-11-14T13:55:00Z   # the bookmark for a time
npx wrangler d1 time-travel restore <database> --timestamp=2026-11-14T13:55:00Z
```

The restore returns the bookmark that undoes it; save it. Queries running at the time fail.

## Other stores

- **Secrets.** Put each one back from the district's own records with `wrangler secret put` or a
  rerun of the installer with the same secret source. A lost `DEVICE_TOKEN_SECRET` is generated
  again by the installer; every phone signs in again.
- **Worker code.** Run the installer with the release the district approved, or its rollback
  ([launch-installer.md](../launch-installer.md), [release-signing.md](../release-signing.md)).
- **Workshop, AI guard, gatekeepers, KV, R2.** No procedure yet (SCHO-397). Gatekeeper connections
  are reconnected by their owners.

## Rehearsal log

### 2026-11-14 (SCHO-373), local only

What could be rehearsed: everything but the platform restore itself, which local workerd does not
have. No production or demo district was touched.

| Step | How | Time | Result |
| --- | --- | --- | --- |
| Probe local point-in-time recovery | A scratch SQLite Durable Object under `wrangler dev` (Wrangler 4.154.0): write a row, read the current bookmark, write a second row, restore to the bookmark | about 1 s | `getCurrentBookmark()` answers (a local counter such as `00000000-00000001-…`). `onNextSessionRestoreBookmark()` throws "This Durable Object's storage back-end does not implement point-in-time recovery." Both rows remained. |
| Recovery routes over the real district object | `packages/educateos-district-worker/__tests__/recovery.test.ts` in workerd, through the Worker's fetch handler, with a signed Access assertion and the token | 3.5 s for the file | The current bookmark is read, and moves forward after the district starts and writes. `getBookmarkForTime` and a restore answer `501 recovery-unavailable`, the local refusal; nothing is scheduled and the district keeps serving. A missing Access sign-in is `401`. |
| Restore order and refusals | The same file, over a recording storage | included above | No token, a short token or none set: `404`. Missing or wrong token, or no Access sign-in: `401`, and the token is never in an event. Wrong district `409`, bad body or bookmark `400`, a time outside 30 days or in the future `400`. A restore is scheduled, its `undoBookmark` answered, and only then the object restarted; a platform refusal restarts nothing. |
| Whole-district snapshot and restore of the stores | `packages/educateos-pilot-gate/__tests__/restore.test.ts` (in memory) | 4.3 s for the file | Directory, artifacts, submissions, the AI ledger, configuration revisions and every API view equal after restore into fresh stores; the gaps it already records still stand ([pilot-gate.md](../pilot-gate.md), "Restore rehearsal"). |
| District export of a seeded district | `packages/educateos-harness/__tests__/district-export.test.ts` (Northfield showcase plus more than 32 MiB of uploads) | 7.5 s for the file | Every record and upload comes back whole, checked against the API's views. There is no importer, so this is a record copy, not a restore. |

Not rehearsed: a restore against Cloudflare's storage, the deferred restart (`ctx.abort()` 250 ms
after the answer) taking effect, the undo, D1 Time Travel, and the end-to-end timing behind the RTO.
SCHO-395 rehearses them on a scratch district in a Workers Paid account.
