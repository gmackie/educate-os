# District offboarding

- Status: Runbook. Not yet run end to end against a live district.
- Issues: SCHO-364 (district export and this runbook), SCHO-143 (offboarding runbook). Follow-ups:
  SCHO-367 (streamed export), SCHO-368 (installer uninstall and registry deregistration), SCHO-371
  (student archive route).

How a district takes its data out of EducateOS and removes it. EducateOS runs in the district's own
Cloudflare account, so leaving is mostly deleting things the district already owns. Gmacko Ventures
holds no student data; what it can hold is listed in step 7.

Do the steps in order. Steps 1 and 2 need the district still running; everything after step 3 takes
it down.

## Before you start

- A district administrator in EducateOS (a principal with the `district-admin` role).
- A Cloudflare account administrator for the district's account, or an API token with the
  permissions in [installer-permissions.md](../installer-permissions.md).
- The install's instance ID (`ins_<name>`). Every resource the installer made carries its prefix
  `educateos-<name>`, and every DNS record it wrote carries the comment `educateos:<instanceId>`.
- The district's retention obligations. Deleting the Workers and storage in step 5 cannot be undone.
  Decide first what the district must keep, for how long, and where.

## 1. Export the district's records

A district administrator exports the whole district in one ZIP of JSON records and content files.
The format, and what is and is not in it, is in
[educateos-archive-format.md, "District export"](../educateos-archive-format.md#district-export).

With the API client, signed in as the administrator:

```ts
const exported = await client.call("admin.exportDistrict");
await writeFile(exported.fileName, Buffer.from(exported.base64, "base64"));
```

Or `GET /api/admin/district/export` with the administrator's credential, and decode `base64` from
the JSON body. Then check it:

1. Unzip it and read `manifest.json`. `counts` should match the admin console's district health
   (schools, terms, classes, students, staff, submissions).
2. Check each `content/<hex>` file's SHA-256 is its name.
3. Read the `notCopied` list. Those are links and provider references whose bytes were never held by
   the district; copy them from their sources if the district needs them.
4. Read the `excluded` list and decide whether the district needs any of it (step 2).

The export holds students' personal information. Store it under the district's data-governance
rules. Only district administrators can take it; each export is in the policy audit trail and the
district Worker's logs (`district.export`, counts only).

**Limits today.** The export is one response, so a district holding more than 32 MiB of work content
is refused with `unavailable` (SCHO-367 streams it). Some district-authored records are not in it
yet: Content Studio items and releases, activity definitions, rubric releases, Assessment CI runs,
the course library and marketplace packs (SCHO-367). Until then, export each class's content as a
Common Cartridge (`teacher.exportCartridge`, a teacher of the class) and each gradebook as CSV
(`teacher.exportGradebookCsv`).

## 2. Give students and staff their own work

Personal workspaces belong to their owners alone and are deliberately not in the district export.
Each person takes their own work as a `.educateos` archive
([educateos-archive-format.md](../educateos-archive-format.md)). **The district app does not serve
that archive yet** (SCHO-371): until it does, announce the shutdown date early and ask students to
download anything personal they want to keep from their workspaces, artifact by artifact.

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

1. In Zero Trust, Access, Applications: delete the EducateOS application for the public hostname,
   its bypass application if present, and the admin application and its bypass if
   the OSS admin was installed. Delete their policies.
2. Revoke all sessions for those applications.
3. If an identity provider (Google Workspace, Microsoft Entra, Okta, ClassLink) was added to Access
   only for EducateOS, remove it from Zero Trust, Settings, Authentication, and delete the matching
   OAuth or SAML application in the IdP.
4. Delete the Access users that only existed for EducateOS. Access subjects may be keyed by email
   ([access-sub-stability.md](access-sub-stability.md)), so a later reuse of an address could
   otherwise inherit a departed person's subject in another Access application.
5. Delete the installer's API token (district-run mode), or check that the guided install's OAuth
   grant is revoked (Cloudflare dashboard, My Profile, authorized applications).

## 5. Delete the Workers and storage

There is no single uninstall command yet (SCHO-368). The installer can remove one optional service
(`services.<pkg>.enabled: false`, which removes the backend binding and then deletes the service
Worker and its Durable Object data) and release a managed hostname (an apply without
`managedHostname`), but not the whole instance. Delete the rest by hand, in the district's
Cloudflare account, filtering by the `educateos-<name>` prefix:

1. **Managed hostname first** (if `<slug>.educateos.io` was used): run the installer once with
   `managedHostname` removed from the config. Its release phase detaches the Workers custom domain
   (`detachWorkerDomain`, `DELETE /accounts/{id}/workers/domains/{domain}`), or on the Cloudflare
   for SaaS path deletes the custom hostname and the Worker route on the district's zone. Then
   tell Gmacko Ventures to release the slug (step 7).
2. **Custom domains and routes.** Workers, Domains: remove the public hostname (and the admin
   hostname) from the router and admin Workers. Remove any Worker routes the installer made.
3. **Workers.** Delete every Worker with the prefix: the router, the Workshop backend, the district
   Worker, the AI call guard and the gatekeepers. Deleting a Worker deletes its Durable Objects (the
   district's records, held in the district Worker's Durable Object SQLite), its secrets and its
   Cron Triggers. It is not recoverable.
4. **D1 databases, KV namespaces and R2 buckets** with the prefix. Empty each R2 bucket first
   (Cloudflare refuses to delete a non-empty bucket); a lifecycle rule that expires every object
   does this for large buckets.
5. **AI Gateway** with the prefix, if one was made, and its logs.
6. **DNS records** with the comment `educateos:<instanceId>` on the district's zones (the SaaS
   fallback origin, if any).
7. **Workers Observability and Logpush.** Logs age out under the account's retention. Delete any
   Logpush job created for EducateOS.

## 6. Confirm deletion

1. With the installer's planner, against the same config: a plan that finds none of the instance's
   resources means they are gone. Or list Workers, D1, KV, R2, AI Gateway and Access applications in
   the dashboard and API and check that nothing carries the prefix or the marker.
2. Request the public hostname: it should not resolve to an EducateOS Worker (Cloudflare's
   no-route page or NXDOMAIN).
3. `<slug>.educateos.io`, if used, should not resolve once step 7 is done.
4. Record in the district's offboarding record: the export's `manifest.json` (counts, `exportedAt`,
   `exportedBy`), the date of each step, who did it, and anything kept and where.

## 7. What Gmacko Ventures holds, and how it is released

EducateOS keeps the district's records only in the district's own account. Gmacko Ventures holds no
student records, work, grades or directory.

What it can hold, only if the district used it:

- **A managed hostname** (`<slug>.educateos.io`). On the same-account path the hostname is a Workers
  custom domain in the district's account, released in step 5.1. On the Cloudflare for SaaS path,
  educateos.io's zone also publishes the hostname's validation records; Gmacko Ventures deletes those
  and frees the slug when asked.
- **A registry registration** (only for a guided install whose operator opted in to the
  educateos.io registry): the installation, its commercial account, release version, health-probe
  heartbeats and, for Clever launches, the Clever district ID it serves. No student data. Heartbeats
  stop when the Workers are deleted. There is no deregistration action yet (SCHO-368); ask Gmacko
  Ventures to delete the record.
- **Billing records** for a paid plan, kept as its billing provider and the law require.

To release any of these, email Gmacko Ventures with the instance ID and slug, and keep the reply
with the offboarding record.
