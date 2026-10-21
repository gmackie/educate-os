# The `.schoolos` student archive, format version 1

A `.schoolos` file is what a learner takes with them when they leave a district or a course
closes (roadmap P01, §0.6, §6.1). It holds their own work and what was shared with them. It never
holds anything secret, nobody else's content, or anything that identifies records inside the
district. `@schoolos/portability` writes it (`StudentArchiveExporter`) and checks it
(`validateArchive`). Importing an archive into another district is P02, and is out of scope here.

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
`uploaded`, `external-reference` or `baseline`), and its content. The content is either
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
submission is in the archive, its author's pseudonym, its time and its text.

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
- the learner's own submissions. A submitted revision whose artifact is not in the archive is
  exported, through the artifact service, as the submission's own file;
- feedback marked as shared with the learner;
- resources the learner's work cites. A resource is carried as content only when policy allows
  exporting it and its rights permit redistribution. Otherwise it is carried as a reference to its
  canonical `https` URL, if the learner may read the resource. A link-only resource is therefore
  always a reference. The v1 rule table has no `export` grant for learning resources, so until a
  district adds one, every cited resource is a reference.

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
archive's contents on its own.

## Versioning

`formatVersion` changes whenever a reader of the old version could misread an archive written in
the new one. Readers reject any version they do not know.
