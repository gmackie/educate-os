# Blueprint publication review SDK

`BlueprintEducationMetadata` and `BlueprintReviewCatalog` are available from
`@educateos/registry`. This is a pure domain SDK with an in-memory catalog, not a
Worker, installer, authentication endpoint, or persistent repository. The host must
resolve the actor and role assignments from its trusted directory; caller-supplied
roles must never be forwarded to the SDK. Review commands must be serialized by
the host. Returned records and marketplace entries are detached copies.

Create a version with `catalog.create(metadata, author)`, then call
`catalog.transition(id, version, action, requestId, actor, now)`. The lifecycle is:

- draft → submitted (author only)
- submitted → reviewed or rejected (scoped staff reviewer)
- reviewed → approved or rejected (scoped staff reviewer)
- approved → revoked (scoped staff reviewer)

Rejected and revoked versions are terminal. Changes require a new version and a
new review; an approval never transfers to a different version or artifact digest.
Reviewers must be active staff with an in-force teacher, curriculum-admin, or
district-admin assignment containing the Blueprint's scope. Authors cannot review
their own work. This applies to student and staff authors. Evaluation must pass
before approval. Identical request IDs are idempotent within a version; conflicting
reuse fails. Retrying an approval after revocation does not republish it.

Metadata records district scope, author kind, instructional intent, grade band,
version-pinned standards, required capability identifiers, an open license,
provenance digest, accessibility features/hazards and evaluation evidence digests.
Evidence bytes remain private and must be reviewed by the named human; a digest
is a reference, not proof that an automated safety evaluation happened. The SDK
does not fetch or inspect Gadget source or the referenced evidence.

`exportEntries()` exports only currently approved versions. Its explicit projection
contains no author/district identifiers, standard URLs, source files, bindings,
configuration, credential fields, free-form text or learner/evaluation payloads.
Standards and district scope remain available in the returned internal review
snapshots for administrative review. Strict nested schemas reject extra fields.
Artifacts must be served separately by a host that enforces current review status;
this SDK cannot recall a manifest already copied by a third party. Capability IDs
are declarations only: this SDK neither grants capabilities nor changes policy.

## Persistent district adapter (stacked follow-up)

`PersistentBlueprintCatalog(storage, districtId)` wraps the unchanged in-memory SDK in a
SQLite `transactionSync` journal. Pass a district DO's `ctx.storage` directly. The storage
is pinned to one district. Every write checks the catalog revision and atomically records the
command, server time, trusted actor/role snapshot and new revision. The journal is append-only;
reconstruction revalidates every command and runs the SDK again. Failed commands and revision
conflicts roll back. Exact retries do not add events, including approval retries after revocation.
An exact retry returns the current revision; a different write with a stale revision gets 409.
This initial adapter replays the full journal: suitable for a bounded district review catalog,
with compaction/pagination needed before high-volume deployment. Audit storage is district-private
and contains identities; never copy the SQLite journal into marketplace exports.

The create command additionally requires all four explicit human attestations: license rights,
no credentials, no learner data, and no source chat. They apply to the immutable artifact digest.
A missing license or missing/false attestation fails closed. These are human attestations, not
an automated scan of artifact bytes. The API accepts no artifact bytes or source code.

`blueprintCatalogApi(catalog, resolveActor, now)` is a fetch adapter with these exact routes:

- `GET /api/blueprints`: `{revision, entries}` for currently approved public manifests.
- `POST /api/blueprints/commands`: `{expectedRevision, command}`; commands are strict
  `{operation:"create", metadata, attestation}` or
  `{operation:"transition", id, version, action, requestId}`.
- `GET /api/blueprints/download?id=...&version=...`: current approved manifest only;
  revoked/unapproved versions fail. Responses carry `Cache-Control: no-store`.
- `GET /api/blueprints/review?id=...&version=...`: private snapshot and current revision,
  restricted to the author or a current scoped staff reviewer.
- `GET /api/blueprints/audit`: private journal for current district-wide curriculum/district admins.
- `POST /api/blueprints/imports`: array of strict public manifests, admins only. The import
  table preserves first importer/time and immutable manifest identity; retries do not replace it.
  Imports are quarantined references, **never local approvals or downloadable local versions**.
  The public manifest carries no cryptographic assertion of remote approval. Obtain it from a
  trusted source's live export; copied manifests cannot prove ongoing remote approval/revocation.
  To publish locally, author a new local draft with local metadata/attestations and complete review.

Integration captain seam: construct this adapter inside the district Durable Object with its
existing SQLite storage. Mount the six routes above in the district Worker before its generic
route dispatcher. `resolveActor(request)` must call the existing Access JWT verifier (signature,
issuer, audience, expiry), then the current district directory principal resolver and current
role assignments, returning `{principal, assignments}`; it must never read identity/roles from
JSON, query parameters, or unverified headers. Forward verified identity through a private service
binding only if the Worker and DO are separated. Use bearer credentials, with no cookie fallback;
a cookie-based UI needs its existing CSRF protection before mounting writes. No new public Worker,
service binding, route registration, UI, or deploy config is installed by this library PR.

Any future artifact byte service must perform the same live `download` eligibility check against
the requested exact id/version/digest before serving bytes and must not mint long-lived download
URLs. This PR deliberately exposes only closed metadata manifests, so source chat, credentials,
learner payloads and private evidence cannot enter its import/export format. Revocation cannot
recall manifests already copied by another district.

Focused checks: `pnpm exec vp run -F @educateos/registry test` runs both Node and real workerd
SQLite tests, including DO eviction/reconstruction, optimistic concurrency, rollback, retry,
revocation, self-review denial, district isolation, strict input and quarantined imports.
