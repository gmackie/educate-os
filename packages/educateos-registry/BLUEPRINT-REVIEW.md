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
