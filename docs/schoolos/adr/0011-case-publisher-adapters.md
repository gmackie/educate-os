# ADR-0011: CASE imports stay strict; publisher deviations go through named adapters

- Status: Accepted
- Date: 2026-10-21
- Issues: SCHO-45 (decision), SCHO-61 (the TEKS adapter)

## Context

`@schoolos/registry` decodes CASE 1.1 with strict schemas: a field CASE does not define fails the
import instead of being dropped or moved into `extensions`. SCHO-45 asked whether real publisher
packages need that relaxed.

C02 decoded real packages (`docs/schoolos/standards-licensing.md`), and on 2026-10-21 TEA's
packages were fetched again:

- OpenSALT's CCSS Mathematics (746 items) and NGSS (1,037 items) packages decode cleanly. Neither
  has a field outside CASE 1.1.
- TEA's `teks-api.texasgateway.org` packages (chapters 110-113, 115 and the 2022 Prekindergarten
  Guidelines) fail on one thing only: `CFDocument.subject` is a string, not a list. No package has
  an unknown field. TEA's `CFDocuments` listing is a bare array rather than
  `{ "CFDocuments": [...] }`, and its documents send `null` for absent optional fields. TEA's items
  carry no `educationLevel`; grades and courses are `Grade/Course` items under elementary, middle
  and high school `Subchapter` items.

So unknown fields have not been the obstacle. The obstacle is a few named deviations, in fields
CASE already defines, from one publisher.

## Decision

1. The CASE 1.1 decoder and client stay fail-closed. An unknown field is still an error, from
   every publisher, with or without an adapter.
2. A publisher's known deviations are normalized by a **named adapter** (`CaseAdapter`, in
   `packages/schoolos-registry/src/case/adapter.ts`), which runs over the raw JSON before the strict
   schemas validate it. An adapter handles only the deviations it names, and reports each change
   it makes, with its own `<name>@<version>`.
3. The decoder records every reported change on the provenance of the record it changed
   (`Provenance.adaptations`). An `official` record with adaptations still has the publisher's
   text and identity; the adapted fields are SchoolOS's reading of them. An adaptation that names a
   record the package does not contain fails the import.
4. Adapters ship in the registry, by name (`CaseAdapterName`). A catalog `CaseSource` names the one
   its publisher needs; a source that names none is read strictly.
5. The first adapter is `tea-teks-api@1` (`src/case/tea-teks.ts`): a string `subject` becomes a
   one-element list, `null` optional document fields are omitted, the bare-array listing is
   wrapped, and items without `educationLevel` are given one derived from course structure. A
   `Grade/Course` item takes the grade its statement names ("Kindergarten", "Grade 3",
   "Grades 7-8", prekindergarten); a high-school course, which names no grade, takes its division
   (high school is 09-12, middle school 06-08, elementary KG-05) from the nearest ancestor that names
   one. Every item takes the levels of the nearest such course or subchapter above it. An item with
   none above it keeps no levels rather than a guess.

## Rejected alternative

Moving non-spec fields into `extensions` on import would accept anything, including fields that
change meaning, and would re-export them as if the publisher had put them in `extensions`. It also
would not have helped: TEA's problem is a known field with the wrong type, which a tolerant
unknown-field rule does not cover.

## Consequences

- A new publisher deviation is a new adapter, or a new version of an existing one, with a test
  against a fixture shaped like that publisher's responses. It is never a looser decoder.
- Derived education levels make TEKS imports count in the coverage report by band. Their
  provenance says they were derived and from which course, so a reviewer can tell them from a
  publisher's own levels.
- CASE cannot carry provenance, so an exported package loses the adaptations; it exports the
  adapted (valid CASE 1.1) values.
