# Content Studio: document text, Blueprints, durable storage and egress

Follow-ups to the Content Studio (C03): PDF and DOCX text for review (SCHO-79), a Durable Object
store and pinned egress outside Workers (SCHO-80), and native Blueprint releases as a third content
source (SCHO-121). Everything imported stays untrusted data (threat T7).

## Document text extraction (`@schoolos/doc-extract`)

The studio reads PDF and DOCX text only through an injected `extractText`. SchoolOS ships
`documentTextExtractor()`. The extracted text goes to the deterministic checks and the AI reviewer's
delimited data slot, and nowhere else: the item records only `{ status, characters, truncated }`, or
`not-extractable` with a reason, which also raises a `not-extractable` warning for the reviewer.

- **DOCX:** the cartridge importer's bounded unzip (entry, size and ratio caps, no unsafe paths) and
  its DTD-free XML parser, so no entity is defined, expanded or fetched. Only `word/document.xml` is
  read: text runs, tabs and breaks, one line per paragraph. Deleted revisions and field codes are
  left out.
- **PDF:** text from content streams that are uncompressed or Flate-compressed with no predictor,
  shown by `Tj`, `TJ`, `'` and `"` inside `BT … ET`. Strings are UTF-16BE when marked, Latin-1
  otherwise. Any other filter, an encrypted file, more pages than the cap, or text that is mostly
  unreadable (fonts with their own glyph encodings) is `not-extractable`. Nothing is guessed.

"Sandboxed" means three things, all enforced by construction:

1. **No network or storage.** The extractor is a pure function of the document's bytes. It reads no
   clock, writes no globals and imports nothing that does I/O.
2. **Bounded CPU.** Every loop over the document spends from a step budget (`maxSteps`). A
   wall-clock deadline would not work, because Workers do not advance the clock during synchronous
   work, so counting steps is the bound. Running out is `budget-exceeded`.
3. **Bounded memory and output.** The document (`maxBytes`), everything it inflates to together
   (`maxInflatedBytes`), its pages (`maxPages`) and the returned text (`maxTextChars`) are capped.
   Inflation stops as soon as it passes the cap.

## Native Blueprint releases

`ContentStudio.submitBlueprint` takes a Workshop Blueprint release: the district's name for the
blueprint, its title and version, the release commit, and the release's files. The studio
recomputes the commit from the files, as the Workshop's `buildSnapshotRelease` does for a snapshot
release (a bundled blueprint) or by hashing the given commit text for a published one. A commit that
does not match the files is refused, so the release approved is exactly the code that commit holds.

The submission has no blueprint ID field, and a strict schema refuses one. In the Workshop that ID
is a bearer link to the code (`docs/blueprints.md`). In quarantine the studio keeps only a manifest:
paths, sizes and blob IDs. The code is not kept in the studio or in any registry record. The README,
if there is one, is the text reviewed, and a `gadget-code` flag tells the reviewer to open the
release in the Workshop.

An approval releases a `ResourceDescriptor` of kind `interactive`. Its locator is
`urn:schoolos:blueprint:<name>:release:<commit>`, and its provenance's `sourceRevision` is the
commit. Releases are immutable. A new blueprint version is a new item with `updatesResourceId` and
becomes the next release version. The same commit again is a `conflict`.

## Durable Object storage

`@schoolos/content-studio/durable-object-store` exports `DurableObjectContentStudioStorage`, a
`ContentStudioStorage` over a SQLite-backed Durable Object's `ctx.storage`, which one district's
studio object holds:

- `putItem` is a compare-and-set on the item's revision inside one `transactionSync`. Of two writes
  based on the same read, one lands and the other is a `conflict`.
- Releases are unique by resource and version. Releases, class bindings, snapshots and audit events
  are append-only, enforced by SQLite triggers.
- Snapshots are stored in 1 MiB chunks, because one SQLite value holds at most 2 MB.
- Every row read back is checked against its schema and row version. A row that fails is reported
  as `StudioStorageCorruptionError` and never returned.

Its workerd suite covers restarts, racing approvals, stale writes, append-only tables, large
snapshots and tampered rows.

## Egress outside Workers

On Workers, `fetch` cannot reach private networks. Node's `fetch` can, and it resolves names after
the studio has checked the URL, so a public name that resolves or rebinds to a private address
would get through. The harness's `createPinnedEgressFetch` closes that gap and is the studio's
`fetch` in Node only:

1. The URL must pass `checkImportUrl`.
2. The name is resolved once. Every address must pass `isPublicAddress`, or the request is refused
   before any connection is made.
3. The connection goes to the checked address. SNI and `Host` carry the name, so TLS verifies the
   certificate against the name, and no agent pool is used. Redirects are returned to the studio,
   which checks every hop the same way.
