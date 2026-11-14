# ADR-0015: New installs keep district storage in Cloudflare's US jurisdiction

- Status: Accepted
- Date: 2026-11-14
- Issues: SCHO-374 (parent SCHO-358). Found by the security questionnaire (SCHO-360,
  [security-questionnaire.md](../security-questionnaire.md), "Data location and residency").
  Builds on [ADR-0001](0001-district-data-ownership.md) rule 1 (the district's data lives in its own
  Cloudflare account).

## Context

District reviews ask whether student data stays in the United States. Before this ADR the answer
was "not guaranteed": no EducateOS code set a Cloudflare jurisdiction. Cloudflare placed each
Durable Object near the first request that created it, and created KV, R2 and D1 storage with no
jurisdiction. For a US district that normally meant US data centers, but nothing restricted it.

Cloudflare's controls, as documented on 2026-11-14:

| Product | Control | Values | When it can be set | What it restricts |
|---|---|---|---|---|
| Durable Objects | Jurisdiction: `env.NS.jurisdiction("us")`, then `idFromName` / `getByName` / `newUniqueId` on that subnamespace ([docs](https://developers.cloudflare.com/durable-objects/reference/data-location/)) | `eu`, `us`, `fedramp` | Part of each object's ID, fixed when the ID is made. The same name gives a different ID, so a different object, in each jurisdiction. Objects don't move after they're created. | Where the object runs and stores data. Workers can still call it from anywhere. Cloudflare logs the object's ID outside the jurisdiction for billing and debugging. |
| R2 | Bucket jurisdiction: the `cf-r2-jurisdiction` header on create and list, and `jurisdiction` on the Worker's `r2_bucket` binding ([docs](https://developers.cloudflare.com/r2/reference/data-location/), [API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)) | `eu`, `us`, `fedramp` (`fedramp-high` in the API); `fedramp` is Enterprise-only | At bucket creation only; "the jurisdiction cannot be changed" afterwards | Where the bucket's objects are stored. R2 lists and names buckets per jurisdiction. |
| D1 | Database jurisdiction: `jurisdiction` in the create body; the list returns it ([docs](https://developers.cloudflare.com/d1/configuration/data-location/), [API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)) | `eu`, `us`, `fedramp` | At creation only; "cannot be added or updated after the database exists" | Where the database runs and stores data. A location hint is ignored when a jurisdiction is set. |
| Workers KV | Namespace jurisdiction: `jurisdiction` in the create body; the list returns it (generally available 2026-10-02, [docs](https://developers.cloudflare.com/kv/reference/data-location/)) | `eu`, `us`, `fedramp` | At creation only; it can't be added or changed | Where the namespace's data is durably stored only. KV still caches values outside the jurisdiction across Cloudflare's network. |

Location hints (`wnam`, `enam`, ...) exist for Durable Objects, R2 and D1, but Cloudflare calls them
"a best effort and not a guarantee". EducateOS uses jurisdictions, not hints.

None of these controls covers where requests are answered: Cloudflare's network serves a Worker
from the data center nearest the caller, and that Worker reads the pinned storage from wherever it
runs. Cloudflare's Regional Services product controls that; EducateOS does not configure it.

## Decision

1. **New installs pin to `us`.** The installer's `DistrictInstallConfig` has an optional
   `dataJurisdiction`, whose only accepted value is `us`. `npx launch-educate-os` writes
   `"dataJurisdiction": "us"` into the answers of every new install. With it, the installer:
   - creates the install's KV namespaces, R2 buckets and D1 databases in the `us` jurisdiction
     (`createKvNamespace`, `createR2Bucket`, `createD1Database` in
     `packages/educateos-installer/src/cloudflare-http.ts`);
   - binds each such R2 bucket with `jurisdiction: "us"`, since R2 names buckets per jurisdiction;
   - sets `DATA_JURISDICTION=us` on the district Worker.

2. **The district's Durable Object is named in its jurisdiction.** The district Worker reaches its
   one `DistrictObject` through `inJurisdiction(exports.DistrictObject, readDataJurisdiction(env.DATA_JURISDICTION))`
   (`packages/educateos-district-worker/src/jurisdiction.ts`, used by `src/worker.ts`). Unset or
   empty, the namespace is used as before. Any value but `us` fails the request rather than guess.

3. **Absent means unpinned, and existing districts stay unpinned.** Northfield (schoolos.gmac.io),
   Riverbend, Prairie, Cedar Valley, Lakeshore and Harbor were created without a jurisdiction. They
   are not migrated. Their ForgeGraph configs (`wrangler.production.jsonc`, `wrangler.demo-*.jsonc`)
   don't set `DATA_JURISDICTION`, and saved launcher answers without `dataJurisdiction` stay
   unpinned. Setting the var on one of them would point it at a new, empty object with the same name
   in `us`, and leave its data behind.

4. **The installer never pins, unpins or re-pins existing storage.** Planning refuses, and changes
   nothing, when:
   - a KV namespace, R2 bucket or D1 database of the install's name exists in a different
     jurisdiction than the config asks for, where "none" counts as one (planning lists R2 buckets in
     each jurisdiction, since R2 lists them apart);
   - a deployed Worker's `DATA_JURISDICTION` differs from the desired one, including when adopting a
     ForgeGraph-deployed district (SCHO-243).

   Moving an existing district into `us` means creating new storage and copying the data into it.
   EducateOS has no tool for that.

5. **A release declares that its district can be pinned.** The district Worker's config sets
   `DATA_JURISDICTIONS_SUPPORTED=us`, which reaches the release manifest's `vars`. A district from an
   older release ignores `DATA_JURISDICTION`, so it would keep its data unpinned while the install
   claimed otherwise. The installer refuses `dataJurisdiction` with a release whose district lacks
   the declaration. That refusal also covers rolling back to such a release.

## What is not pinned

These hold data and are not in the `us` jurisdiction, even on a pinned install:

- **The Workshop's Durable Objects** (`workshop-backend`: users' chats, agents and settings), the
  gatekeepers' Durable Objects (OAuth credentials, Context Library collections), the AI call guard's
  `DistrictAiLedger` (model spend), and the external MCP Worker's `McpDistrict`. Each names its
  objects with `getByName`, `idFromName` or `newUniqueId` on an unrestricted namespace. Pinning them
  needs the same change in each Worker and the same "new installs only" rule. That is follow-up work.
- **The guided install** (educateos.io, `packages/educateos-control-plane/src/guided-install.ts`)
  doesn't set `dataJurisdiction` yet. It installs the Workshop alone, and it re-runs an earlier
  install as the same instance. Pinning it needs a way to tell a new install from an upgrade.
- **Cached KV values**, which Cloudflare may cache outside the jurisdiction, as above.
- **Logs and analytics** (Workers Logs, Analytics Engine, Access logs), and Cloudflare's
  out-of-jurisdiction record of Durable Object IDs. EducateOS sets no jurisdiction for them.

## Verification

- Unit tests: `packages/educateos-installer/__tests__/data-jurisdiction.test.ts` (desired state,
  apply against the fake account, every refusal, rollback) and `__tests__/http.test.ts` (the header
  and body each API call sends, and the jurisdiction read back from the KV and D1 lists).
  `packages/launch-educate-os/__tests__/wizard.test.ts` checks that a new install is pinned.
  `packages/educateos-district-worker/__tests__/jurisdiction.test.ts` checks how the var is read.
- **Local workerd doesn't implement jurisdictions.** `jurisdiction("us")` throws "Jurisdiction
  restrictions are not implemented in workerd", so the restricted namespace can't run in Miniflare,
  the vitest pool or `pnpm dev-server`. The test asserts that it throws. Local configs never set
  `DATA_JURISDICTION`.
- **Not yet verified on Cloudflare.** No pinned install has run against a real account. The first
  one should check that `ctx.id.jurisdiction` is `us` in the district's object, and that the KV, R2
  and D1 resources list `jurisdiction: "us"`. The R2 binding's `jurisdiction` field and the KV and D1
  list fields are taken from Cloudflare's API reference, not yet seen live.

## Consequences

- A security review gets a precise answer: on an install made with `dataJurisdiction: "us"`, the
  district's records (its Durable Object) and the install's KV, R2 and D1 storage are created in
  Cloudflare's US jurisdiction. That describes Cloudflare's control. It is not a certification, and
  it doesn't cover the items above.
- Existing districts answer "not pinned" until they are rebuilt as new installs.
- A district that loses its answers file and re-runs the launcher gets `dataJurisdiction: "us"` in
  the new answers. If the account already holds an unpinned install, planning refuses it. The
  operator removes `dataJurisdiction` from the answers to keep that install as it is.
