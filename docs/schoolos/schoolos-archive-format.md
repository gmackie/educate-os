# The `.schoolos` student archive, format version 1

A `.schoolos` file is what a learner takes with them when they leave a district or a course
closes (roadmap P01, §0.6, §6.1). It holds their own work and what was shared with them. It never
holds anything secret, nobody else's content, or anything that identifies records inside the
district. `@schoolos/portability` writes it (`StudentArchiveExporter`) and checks it
(`validateArchive`). Moving an archive into another district (P02) is described under
"Transfer to another district" below.

Media type: `application/vnd.schoolos.student-archive+zip`.

## Container

The file is a ZIP archive restricted to a small subset of the format, so that a reader can reject
anything unusual instead of trying to interpret it:

- one disk, no ZIP64, no encryption, no data descriptors, and no extra fields or comments, either
  per entry or for the archive;
- each entry is stored, or compressed with raw deflate (method 8), and is deflated only when that
  makes it smaller;
- entry names are UTF-8 (flag bit 11, the only flag allowed). Each is made of lowercase ASCII
  segments matching `[a-z0-9][a-z0-9._-]*`, joined by single slashes. A segment may not contain
  `..`, and a name is at most 200 characters;
- entries are laid out back to back in central-directory order, so no two entries can share
  bytes;
- every entry carries the MS-DOS epoch, 1980-01-01 00:00, as its timestamp. `manifest.json` comes
  first and the other entries follow in byte-wise path order.

The output depends only on the archive's contents. An export of the same records, with the same
export time and export ID, produces identical bytes.

### Reading limits

`validateArchive` reads under `ARCHIVE_LIMITS` and rejects the whole archive if any limit is
exceeded:

| Limit | Value |
| --- | --- |
| Entries | 10,000 |
| One entry, inflated | 64 MiB |
| All entries, inflated | 512 MiB |
| Inflated-to-compressed ratio, for entries over 1 MiB | 100 |

Inflation is streamed and stops as soon as an entry produces more bytes than it declared. A header
that understates an entry's size is therefore caught without the entry ever being fully expanded.
CRC-32, the local headers and the central directory must all agree.

## Layout

```
manifest.json
provenance.json
artifacts/a1/artifact.json        an artifact and its revision lineage
artifacts/a1/r1.md                each held revision's content, by revision number
artifacts/a1/r2.md
submissions/s1/submission.json
submissions/s1/part1.md           only when the submitted revision is not exported with its artifact
feedback/f1.json
resources/res1/resource.json
resources/res1/content.md         only for redistributable resources
```

Content files are named `<number or part>.<extension>`, with the extension taken from the media
type (`md`, `txt`, `csv`, `png`, and so on). An unknown media type gets `bin`.

Every JSON entry is canonical: object keys are sorted and there is no whitespace. Every schema is
strict, so an unknown field anywhere rejects the archive.

## Identifiers

Every identifier in an archive is local to that export:

| What | Form | Example |
| --- | --- | --- |
| Export | 32 lowercase hex | `0f3c…` |
| The learner (subject) | `learner-` + 16 hex | `learner-9a1b2c3d4e5f6071` |
| Staff authors | `staff-N` | `staff-1` |
| Artifacts | `aN` | `a2` |
| Revisions | `aN-rM`, where M is the revision number | `a2-r3` |
| Submissions | `sN` | `s1` |
| Feedback | `fN` | `f1` |
| Resources | `resN` | `res1` |

District principal, artifact, revision, submission, workspace and offering IDs, and storage keys,
never appear in an archive, and the schemas reject their shapes wherever an identifier is
expected. The exporting district records the mapping from local to internal IDs server-side
(`ExportMappingStore`), keyed by export ID. The mapping is not part of the archive, so someone
holding only the archive cannot learn a district ID from it.

Courses and terms appear by display name only (`"Biology I"`, `"Period 2"`, `"Fall 2026"`), and so
does the district.

## `manifest.json`

```json
{
  "format": "schoolos.student-archive",
  "formatVersion": 1,
  "exportId": "…",
  "district": { "displayName": "Northfield Public Schools (synthetic)" },
  "exportedAt": "2026-10-20T12:00:00.000Z",
  "subject": "learner-…",
  "items": [
    {
      "path": "artifacts/a1/r1.md",
      "kind": "artifact-revision",
      "digest": "sha256:…",
      "sizeBytes": 16,
      "mediaType": "text/markdown",
      "rights": { "mode": "learner-work" }
    }
  ]
}
```

`items` lists every entry except the manifest itself, exactly once and in archive order. `digest`
is SHA-256 over the entry's bytes. For a revision's content this equals the revision's digest in
the district, so a submission receipt can be checked against the archive.

### Item kinds and source rights

| Kind | Entry | Rights it may carry |
| --- | --- | --- |
| `artifact` | `artifact.json` | `learner-work`, or `link` for an external reference |
| `artifact-revision` | revision content | `learner-work` |
| `submission` | `submission.json` | `learner-work` |
| `submission-file` | submitted content | `learner-work` |
| `feedback` | `fN.json` | `shared-feedback` |
| `resource` | `resource.json` | `link`, `embed`, `permitted-excerpt`, `licensed-copy` |
| `resource-content` | resource content | `permitted-excerpt` or `licensed-copy` with `redistribution: "permitted"` |
| `provenance` | `provenance.json` | `export-metadata` |

These are the rights modes from roadmap §5.3. `link` and `embed` material may be pointed at but
never copied, so it is never carried as content. A copy or an excerpt is carried only when its
license permits redistribution. Every content item must be redistributable (`mayRedistribute`).

## Records

`artifact.json` holds the artifact's type, title and work context (`personal`, or `course` with
course, section and term names), its creation time, and its whole stored lineage, oldest first.
Each revision records its number, its parent, its time, its author (the subject or a staff
pseudonym), its media type, digest and size, the AI-assistance declaration, its origin (`authored`,
`uploaded`, `external-reference`, `baseline`, or `imported` for work brought in from another
district's archive), and its content. The content is either
`{ "kind": "file", "path": … }` or, for an `external-ref` artifact,
`{ "kind": "reference", "url": … }`. The history must be one linear chain: each revision's parent
is the one before it.

`submission.json` holds the activity title, the work context, the submission time and its parts.
Each part has the submitted digest and one of three forms of content:
- `revision`: the revision is in the archive with its artifact;
- `file`: the submitted content is carried as the submission's own file;
- `not-included`: the district no longer holds it or may not export it. The digest still
  identifies it.

`fN.json` holds feedback a teacher shared with the learner: the submission it is about, when that
submission is in the archive, its author's pseudonym, its time and its text. Feedback anchored to a
place in the submitted work also has an `anchor`: the part, numbered from 1 in the submission's
order, and the region in it (`text-range`, `[start, end)` in UTF-16 code units of the part's text,
or `area`, a rectangle in fractions of the page or image), as the assessment service records it.
Validation refuses an anchor to a part the submission does not have.

`resource.json` holds a cited learning resource's title and a reference (`{ "url": … }`), its
content (`{ "path", "mediaType", "digest", "sizeBytes" }`), or both.

`provenance.json` holds the export ID, the generator (`@schoolos/portability`), and one policy
decision per record (`artifact`, `submission`, `feedback` and `resource` items). Each decision
names the record's local ID, the action that was asked (`export`, or `read` for a resource cited
only as a reference), and the ID of the district rule that allowed it.

## What an export includes

The exporter asks the district's policy engine for `export` on every item, as the learner, and
builds every request from stored records. It collects:

- every artifact in the learner's personal workspace;
- every artifact in a course workspace whose term is over (`completed`, `retained` or
  `eligible-for-deletion`). While a course is running, the learner's work in it travels only
  through their submissions;
- the learner's own live submissions (a withdrawn one is left out). A submitted revision whose
  artifact is not in the archive is exported, through the artifact service, as the submission's
  own file;
- feedback shared with the learner: the teacher's own comments once the assignment's feedback
  visibility releases them, exactly what the assessment service shows the learner. A suggested
  score or comment is never shown, so it is never exported;
- resources the learner's work cites. The Content Studio keeps no per-work citations yet, so a
  resource counts as cited when one of its releases was bound to a class the learner was enrolled
  in. A resource is carried as content only when policy allows exporting it and its rights permit
  redistribution. Otherwise it is carried as a reference to its canonical `https` URL, if the
  learner may read the resource. A link-only resource is therefore always a reference.

`DistrictStudentRecordSource` reads these records from the assessment service's store (E01) and
the Content Studio's storage (C03). A release's rights are the widest use its license permits;
redistribution is `permitted` only under a license the studio recognized (a Creative Commons
license or a public-domain mark), never under a bare claim.

**The district's resource export grant.** The v1 rule table has no `export` grant for learning
resources, so by default every cited resource is a reference. A district turns copies on with the
`student-portability` pack's `redistributableResourceExport` setting (off by default).
`learnerResourceExportEnabled` reads it from the compiled configuration and
`withLearnerResourceExport` then appends the rule `portability.learner.resource-export`: an
actively enrolled student may export their class's `course` resources. Appended, it can only turn
the default deny into an allow. The exporter still copies a resource only when its rights permit
redistribution.

## What an export never includes

- **Other learners' content.** The exporter re-checks ownership on every record a source returns,
  and policy denies the rest.
- **Teacher-only notes.** Feedback that is not shared with the learner is dropped before policy is
  consulted, and policy would deny it anyway.
- **Tokens and credentials.** Reference URLs lose their userinfo, query and fragment, which is
  where share keys and signatures are kept. Every text entry is screened for secret-shaped text
  (`findSecretShapes`): private keys, JWTs, bearer tokens, cloud and API keys, credentials in URLs,
  token parameters, and `password=`-style assignments. An item that contains any is withheld, and
  the export result reports it (`withheld`) so the learner can remove the secret and export again.
  Binary content is not screened.
- **District IDs and storage keys.** These are replaced as described under Identifiers.
- **Material whose rights forbid redistribution.** See source rights above.

## Validation

`validateArchive(bytes)` returns a typed `ValidatedArchive` view, or rejects the archive with
`validation-failed`. It checks, in order:

1. that the ZIP is within the reading limits and the format subset;
2. that the manifest is the first entry and parses strictly;
3. that the manifest lists exactly the other entries, in order, with matching digests and sizes;
4. that each item's rights suit its kind, and that every content item is redistributable;
5. that no text entry, the manifest included, contains secret-shaped text;
6. that every record parses strictly and is stored at its canonical path;
7. that every content entry is named by exactly one record and agrees with it about digest, media
   type and size;
8. that histories are linear, references between records resolve, and every author is the subject
   or a staff pseudonym;
9. that the provenance file belongs to this export and accounts for exactly the archive's records.

Validation never writes anything into a district.

## Git export

`gitFastImport(archive, artifactId)` turns one artifact's history in a validated archive into a
`git fast-import` stream. It produces one commit per revision, oldest first, on `refs/heads/main`,
with the revision's file named from the artifact's title. Authors are the export's pseudonyms, at
addresses under the reserved `.invalid` domain, and AI assistance is noted in the commit message.
A learner can rebuild the history locally:

```sh
git init history && cd history && git fast-import < ../essay.fi && git checkout main
```

SchoolOS does not host the repository. Links (`external-ref` artifacts) have no content and cannot
be exported this way.

## Comprehensive Learner Record (CLR 2.0)

CLR 2.0 credentials are verifiable credentials that the district signs as issuer. Issuing one
needs issuer signing keys the district holds, publishes and can rotate or revoke. It also needs a
district decision about which records it will assert as achievements, under which achievement
definitions, and for whom. The learner identifier in the credential must also not be the district
principal ID.

`@schoolos/portability` therefore defines the `ClrIssuer` seam and nothing behind it. The default,
`UNCONFIGURED_CLR_ISSUER`, refuses with `unavailable`. SchoolOS never builds a credential out of an
archive's contents on its own. [ADR-0009](adr/0009-clr-issuer.md) (Proposed) sets out the decisions an
implementation needs.

## Transfer to another district

A learner who moves districts takes their archive with them under a consent (roadmap P02). The
root (`schoolos.dev`) is never on the path (ADR-0001): no transfer step has a client for it.

**Consent.** `issueTransferConsent` records a `TransferConsent` at the source district. It names
one export (its `exportId` and learner pseudonym), the item classes consented to (`artifacts`,
`submissions`, `feedback`, `resources`), the source and destination districts by display label
and, optionally, fleet instance ID, and an expiry of at most 90 days. Who consents follows the
district's `ConsentAgePolicy`: the learner at or over its `selfConsentAge`, a guardian below it.
The learner's age is used for that check and never stored. A consent can be revoked
(`revokeTransferConsent`), which sets `revokedAt` and nothing else.

**Transfer package.** `issueTransferPackage` validates the archive and signs a detached
`TransferStatement` with the source district's fleet agent identity (`@schoolos/fleet`: Ed25519,
context `schoolos-fleet/v1`, message kind `student-transfer`). The kind is in the signed bytes, so
no other fleet message, and no revocation notice, verifies as a transfer. The statement covers the archive's SHA-256
digest, the export ID and pseudonym, the consent's ID and the digest of its grant (every field but
`revokedAt`), and both districts. The archive bytes are unchanged.

**Channels.** A package travels one of two ways:
- `learner-carried`: the learner downloads a `.schoolos-transfer` file
  (`application/vnd.schoolos.transfer+json`: the archive in base64url, the consent and the
  signature) and uploads it at the destination;
- `direct`: the source pushes the same body over HTTPS to the destination's transfer endpoint.
  Only signed packages are pushed, and the endpoint accepts them only from sources whose key its
  admin has pinned.

**Import.** `StudentArchiveImporter.importStudentArchive(bytes, signature, consent, target)` at
the destination:
1. runs `validateArchive`, then refuses the whole archive if any record or content entry holds a
   district ID shape or secret-shaped text, binary content included;
2. verifies the signature when the source is pinned (by label or instance ID). An unsigned or
   unpinned file is accepted only if it was learner-carried and the admin's policy accepts
   unverified sources; it is then marked `unverified-source`;
3. checks the consent is for this archive, from the archive's district, to this district,
   unexpired, and revoked neither in the copy that arrived nor by a revocation notice the source
   sent (see below);
4. applies the admin's `DestinationImportPolicy`: only item classes both consented and accepted
   are imported, and the rest are recorded as skipped;
5. checks the target against any admin-confirmed `PortableIdentityLink` for the archive's learner.
   A direct push needs one, because it names the learner.

Each item becomes a new artifact, with a fresh local ID, in the target's personal workspace. It is
therefore `personal-private`: never course work, and not visible to teachers. Submissions arrive as
`evidence` summaries, feedback and cited references as documents. A link to a document host the
destination has not approved is skipped. Every artifact is created in one batch
(`LearningArtifacts.importArtifacts`), a single commit, so an import that fails part-way creates
nothing and needs no cleanup; every revision it creates has the origin `imported`. Once the batch
has committed, the archive's ledger reservation is never released, even if recording the import
fails, so the same archive is never imported twice. The `ImportRecord` keeps the source district's label, the
archive digest, how the source was verified, and the map from archive-local IDs to new artifact
IDs. Import is idempotent on the archive digest.

**Portable learner identity.** A `PortableIdentityLink` is a destination admin's confirmation that
the learner an archive calls `learner-…`, from a given district, is a given local principal. It is
never a credential: nobody signs in with it and it grants nothing. SchoolOS has no global child
identity broker (roadmap §12 defers one), so the only cross-district identifier is the export's own
pseudonym, and a person at the destination makes the link.

**Revocation.** The source refuses to sign or push under a revoked consent, and the destination
refuses a consent marked revoked. A learner-carried file downloaded before revocation carries the
consent as it was then, so the source also sends a notice: `issueConsentRevocationNotice` signs a
`ConsentRevocationNotice` (the consent's ID and grant digest, the export, the pseudonym, both
districts and the time, kind `consent-revocation`) and `ConsentRevocationChannel` pushes it over
HTTPS to the destination's `ConsentRevocationEndpoint`. The destination records it in its
`ConsentRevocationList` only when it verifies against a key pinned for the notice's source and
names this district as the destination; the importer checks that list before every import. A
district the destination has not pinned cannot revoke there, just as its signatures are not
verified there. As with transfers, the root is never on the path.

## Versioning

`formatVersion` changes whenever a reader of the old version could misread an archive written in
the new one. Readers reject any version they do not know.
