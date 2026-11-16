# District offboarding

- Status: Runbook. Not yet run end to end against a live district. The uninstall command (step 5)
  and deregistration (step 7) are tested against the installer's Cloudflare fake and the control
  plane's workerd tests only; neither has run against a live account yet (SCHO-378).
- Issues: SCHO-364 (district export and this runbook), SCHO-143 (offboarding runbook), SCHO-368
  (installer uninstall and registry deregistration). SCHO-371 added the student archive route;
  SCHO-367 streamed the district export and added the remaining district-authored records.

How a district takes its data out of EducateOS and removes it. EducateOS runs in the district's own
Cloudflare account, so leaving is mostly deleting things the district already owns. Gmacko Ventures
holds no student data; what it can hold is listed in step 7.

Do the steps in order. Steps 1 and 2 need the district still running; everything after step 3 takes
it down.

## Before you start

- A district administrator in EducateOS (a principal with the `district-admin` role).
- A Cloudflare account administrator for the district's account, or an API token with the
  permissions in [installer-permissions.md](../installer-permissions.md).
- The install's instance ID (`ins_<name>`), and its install config: `educateos-install.json` from
  `npx launch-educate-os` (or the installer CLI's `--config` file). For a guided install made at
  educateos.io, the instance ID and settings are on the operator's dashboard; write an answers file
  with them (the format is in [launch-installer.md](../launch-installer.md)). Every resource the
  installer made carries the prefix `educateos-<name>`, every Worker it deployed carries the instance
  marker var `EDUCATEOS_INSTANCE_ID`, and every DNS record it wrote carries the comment
  `educateos:<instanceId>`.
- The district's retention obligations. Deleting the Workers and storage in step 5 cannot be undone.
  Decide first what the district must keep, for how long, and where.

## 1. Export the district's records

A district administrator exports the whole district in one ZIP of JSON records and content files.
The format, and what is and is not in it, is in
[educateos-archive-format.md, "District export"](../educateos-archive-format.md#district-export).

In the admin console, the dashboard's **Export the district** card → **Export** saves it. For a
large district, download it straight to disk instead: `GET /api/admin/district/export.zip` with
the administrator's credential answers the ZIP itself, streamed, under the file name in its
`Content-Disposition`. With the API client, signed in as the administrator:

```ts
const response = await client.download("admin.exportDistrict");
await pipeline(Readable.fromWeb(response.body!), createWriteStream("district-export.zip"));
```

If the download stops part-way (a content file could not be read, or the connection dropped), the
ZIP is unreadable: export again. Then check it:

1. Unzip it and read `manifest.json`. `counts` should match the admin console's district health
   (schools, terms, classes, students, staff, submissions).
2. Check each `content/<hex>` file's SHA-256 is its name.
3. Read the `notCopied` list. Those are links and provider references whose bytes were never held by
   the district; copy them from their sources if the district needs them.
4. Read the `excluded` list and decide whether the district needs any of it (step 2).

The export holds students' personal information. Store it under the district's data-governance
rules. Only district administrators can take it; each export is in the policy audit trail and the
district Worker's logs (`district.export`, counts only).

**Limits today.** There is no size limit: the export is streamed, one content file at a time
(SCHO-367). An archive past 65,534 files or 4 GiB uses ZIP64, which every general-purpose unzip tool
reads. It has not been timed against a large district, and it cannot resume: a failure means
exporting again. Assessment CI runs are not in it (their store cannot list them yet), nor are the
course library's signed course packages themselves. For a copy other learning platforms can open,
also export each class's content as a Common Cartridge (`teacher.exportCartridge`, a teacher of the
class) and each gradebook as CSV (`teacher.exportGradebookCsv`).

## 2. Give students and staff their own work

Personal workspaces belong to their owners alone and are deliberately not in the district export.
Each student takes their own work as a `.educateos` archive
([educateos-archive-format.md](../educateos-archive-format.md)): **Settings → Take your work with
you → Download my work** in the Student app, or `GET /api/student/archive`
(`student.exportArchive`) with the student's own credential. The archive holds their personal
workspaces, the work of classes whose term is over, their submissions, the feedback their teachers
shared with them, and the class resources whose license lets them be copied (the rest as links). The
policy engine decides every item, and every decision is in the audit trail; the district Worker
logs only counts (`student.archive.export`). Anything that holds text shaped like a password, key or
token is left out and listed back to the student, who can remove it and export again.

So that every student can take one:

1. Close the terms that are ending first (`admin.closeTerm`), so their class work is in the archive.
   Work in a class still running is in it only as the student's submissions.
2. Announce the shutdown date early, and ask every student to download their work before it. **A
   student can export only while they can still sign in**: once their account is inactive or
   graduated, the route refuses them, and there is no route yet for an administrator to export on a
   student's behalf (see SCHO-371).
3. Keep the district running until that date.

Staff have personal workspaces too, but the route answers students only: ask staff to download
anything personal they want to keep, artifact by artifact.

If the district runs the Workshop at `/ai`, people's Workshop gadgets and agents live in the
Workshop's own storage (the backend Worker's Durable Objects) and are not in either export.

## 3. Disconnect rostering, the LMS and other integrations

Stop anything that pushes data into EducateOS or that EducateOS can reach, at the other end, so the
credentials stop working even before the Workers are gone:

- **Clever.** Disconnect the EducateOS application in the Clever district dashboard. That revokes
  the district-owned token the Clever connector uses.
- **ClassLink / OneRoster REST.** Delete the OneRoster application's client credentials in
  ClassLink (or the roster provider), and the ClassLink sign-in application.
- **OneRoster CSV.** Nothing to revoke; stop uploading.
- **Google Classroom.** In the Google Admin console, remove the `classroom-sync` service account's
  domain-wide delegation (Security, API controls, Domain-wide delegation), then delete the service
  account's keys in Google Cloud.
- **LMS (Canvas, Moodle) as an LTI platform.** Delete or disable the EducateOS developer key or tool
  registration and its deployments in the LMS, so no launch reaches EducateOS.
- **Tools EducateOS hosts as an LTI platform** (if `LTI_PLATFORM=on`). Tell each tool's vendor the
  platform is going away; their tool registrations die with the district Worker.
- **Workshop gatekeepers** (Microsoft 365, GitLab, Cloudflare and the others, if used). Revoke each
  OAuth application's consent in the provider's admin center (Microsoft Entra enterprise
  applications, GitLab applications, and so on).
- **Email.** Remove the district Worker's Email Service sender and its DNS records if they were added
  only for EducateOS.

## 4. Revoke identity-provider and Access applications

Sign-in reaches EducateOS through Cloudflare Access applications in the district's Zero Trust
organization. The installer made them (`access_application`, `access_policy`; the OSS admin has its
own), named with the instance prefix.

1. Revoke all sessions for the EducateOS Access applications (Zero Trust, Access, Applications).
   Step 5's uninstall deletes the applications and their policies themselves (the one for the public
   hostname, its bypass, and the OSS admin's two, if installed); to cut sign-in off before then,
   delete them here by hand, and the uninstall reports them `gone`.
2. Keep the API token below until step 5 is done: the uninstall needs it.
3. If an identity provider (Google Workspace, Microsoft Entra, Okta, ClassLink) was added to Access
   only for EducateOS, remove it from Zero Trust, Settings, Authentication, and delete the matching
   OAuth or SAML application in the IdP.
4. Delete the Access users that only existed for EducateOS. Access subjects may be keyed by email
   ([access-sub-stability.md](access-sub-stability.md)), so a later reuse of an address could
   otherwise inherit a departed person's subject in another Access application.
5. After step 5, delete the installer's API token (district-run mode), or check that the guided
   install's OAuth grant is revoked (Cloudflare dashboard, My Profile, authorized applications).

## 5. Delete the Workers and storage

Run the uninstall with the install's answers file and a token with the permissions in
[installer-permissions.md](../installer-permissions.md) (the install token's; uninstall needs no
other). It needs `launch-educate-os` 0.2.0 or later (`npx launch-educate-os@latest uninstall`); you can also
run it from a checkout (`node packages/launch-educate-os/src/bin.ts`) or with the installer CLI
(`pnpm --filter @educateos/installer start uninstall --config install.json --manifest <release>/manifest.json`).

```sh
export CLOUDFLARE_API_TOKEN=...                               # never printed
npx launch-educate-os uninstall                               # the plan; changes nothing
npx launch-educate-os uninstall --confirm ins_<name>          # deletes
```

**The plan is the default.** It lists every resource it would delete and why, and changes nothing.
Read it before confirming. It deletes nothing until the operator types the instance ID, at the
prompt on a terminal or with `--confirm <instanceId>`; `--yes` never deletes. A wrong ID is refused
before any change.

**What it deletes, and only that.** Ownership is the installer's own record, never a name prefix:

| Resource | Deleted when |
| --- | --- |
| Workers (router, Workshop backend, district, AI call guard, OSS admin, gatekeepers), with their Durable Objects, secrets and Cron Triggers | it carries the instance marker `EDUCATEOS_INSTANCE_ID=<instanceId>` |
| Workers custom domains (public hostname, admin hostname) | it routes to one of those Workers |
| The managed hostname `<slug>.educateos.io`: the custom domain (same account), or the Cloudflare for SaaS custom hostname and Worker route (cross account) | it routes to the instance's router |
| Access applications | it has the install's exact name and still fronts the install's hostname |
| Access policies | it has the install's exact name and no remaining application uses it |
| AI Gateway, KV namespaces, R2 buckets, D1 databases | it has the exact name the install config and release give it |

A Worker named like one of the install's but without its marker (or with another instance's) is
`keep`, and anything else named `educateos-<name>-*` is listed as `unclaimed`: neither is ever
deleted. Check each by hand. So is the zone's Cloudflare for SaaS fallback origin record
(`educateos-origin.<zone>`, cross-account managed hostnames only): other custom hostnames on the
zone may use it, so it is reported, not deleted.

**Order.** Hostnames first, so nothing serves; then the Workers, each after every Worker that binds
it (Cloudflare refuses to delete a bound Worker, code 10142); then Access, so no hostname is ever
served without it; then storage. If anything in a phase fails, the next phase is not started: no
storage is deleted from under a Worker that is still running.

**R2 buckets are never emptied by the uninstall.** The installer has no object operation by design
(its token could read them, but it never does). Cloudflare refuses to delete a bucket that still
holds objects (HTTP 409, code 10008), and the uninstall reports that bucket as `FAILED` with what
to do. Copy anything the district must keep, then empty the bucket: for a large one, a lifecycle
rule that expires every object (R2, the bucket, Settings, Object lifecycle rules). A bucket with a
Bucket Lock rule keeps its objects until the rule allows, and is reported until then. Then run the
uninstall again.

**Resumable.** It keeps no state: each run observes the account, and something already deleted
reads `gone`. After any failure or interruption, fix what it reported and run it again. A token that
stops working stops the run at that call. At the end it observes again and prints every
`leftover`; `uninstalled; nothing of the instance is left` means none.

**Registered installations.** If the plan says `registered`, the instance opted in to a registry,
which keeps its record after the Workers are gone: deregister it (step 7).

What the uninstall does not cover, by hand:

- **Workers Observability and Logpush.** Logs age out under the account's retention. Delete any
  Logpush job created for EducateOS.
- **The SaaS fallback origin record** above, if nothing else on the zone uses it.

The uninstall has been tested only against the installer's Cloudflare fake
(`packages/educateos-installer/__tests__/uninstall.test.ts`), not yet against a live account. Until
it has (SCHO-378), check its result in the dashboard as in step 6. Cloudflare's not-found codes for
the new deletes, and the code for a non-empty R2 bucket, are assumed from Cloudflare's docs, not
observed.

## 6. Confirm deletion

1. Run `npx launch-educate-os uninstall` again: a plan whose every step is `gone`, with no `keep` or
   `unclaimed` line, means the instance's resources are gone. Also list Workers, D1, KV, R2, AI
   Gateway and Access applications in the dashboard and check that nothing carries the prefix or the
   marker.
2. Request the public hostname: it should not resolve to an EducateOS Worker (Cloudflare's
   no-route page or NXDOMAIN).
3. `<slug>.educateos.io`, if used, should not resolve once step 7 is done.
4. Record in the district's offboarding record: the export's `manifest.json` (counts, `exportedAt`,
   `exportedBy`), the date of each step, who did it, and anything kept and where.

## 7. What Gmacko Ventures holds, and how it is released

EducateOS keeps the district's records only in the district's own account. Gmacko Ventures holds no
student records, work, grades or directory.

What it can hold, only if the district used it:

- **A guided install's record** (an install made at educateos.io/app/install): the installation on
  the operator's dashboard (instance ID, slug, hostname, Cloudflare account ID, release version) and
  the slug's reservation. If the operator opted in to the registry, also its registry record
  (commercial account, release version, health-probe heartbeats) and, for Clever launches, the
  Clever district ID it serves. No student data. Heartbeats stop when the Workers are deleted.
- **A managed hostname** (`<slug>.educateos.io`). On the same-account path the hostname is a Workers
  custom domain in the district's account, which the uninstall detaches in step 5. On the Cloudflare
  for SaaS path, educateos.io's zone also publishes the hostname's CNAME and validation records.
- **Billing records** for a paid plan, kept as its billing provider and the law require.

**Deregister.** The operator who made the guided install signs in at
`https://educateos.io/app/deregister`, and for the installation types its instance ID to confirm.
That deletes, in the control plane, the registry record and its Clever district mapping (Clever
portal launches from that district then go nowhere), then the installation's dashboard row and the
slug's reservation, so the slug is free. The keys the installation registered with stay spent: none
is ever accepted again. It does not touch the district's Cloudflare account (that is step 5), and it
is only the installing operator's to do: anyone else's request is refused as not found.

**Release the managed zone's records.** The control plane holds no DNS token, so Gmacko Ventures
deletes the slug's records in educateos.io's zone, after the district's step 5, with educateos.io's
own DNS token (Keychain `educateos-cf-subdomains-token`):

```sh
EDUCATEOS_MANAGED_CF_API_TOKEN=... node packages/educateos-installer/scripts/release-managed-slug.ts \
  --managed-account <educateos.io's account ID> --instance ins_<name> --slug <slug>          # plan
# then the same with --apply
```

It deletes only records carrying the comment `educateos:<instanceId>` at the slug's names (the
CNAME and the `_cf-custom-hostname` and `_acme-challenge` TXT records), through the managed zone's
own planner. Not yet run against the live zone.

For anything else, or if the installing operator can no longer sign in, email Gmacko Ventures with
the instance ID and slug, and keep the reply with the offboarding record.

For a single student's optional planner and guidance records, use the separate
[student learning disposition runbook](student-learning-deletion.md). District uninstall and roster
removal do not verify subject-scoped erasure or discharge retention obligations.
