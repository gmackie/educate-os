# RFC 0001: Open Course Specification (OCS) 1.0

- Status: Draft (implemented by `@schoolos/ocs`)
- Date: 2026-10-20
- Issue: SCHO-18 (roadmap PR C06; roadmap §5.3 "OCS/course repository fast-follow" and §15 item 10).
  Decisions in §13 and the adapter, library and signatures: SCHO-96
- Format version: `specVersion: "1.0"`

## 1. Summary

OCS is the SchoolOS format for courses that teachers build from reusable parts. A course package
holds a manifest, units, references to activities and resources, Codex notes and standards, and it
can include other course packages as **modules**. A lockfile records exactly which version and
content of every module a course was published with, so the same course always composes to the
same outline.

OCS is an authoring and export contract. It is not the classroom runtime (activities run through
`@schoolos/curriculum`, C05), and it is not Thin Common Cartridge.

## 2. Goals and non-goals

### Goals

1. **Modular composition.** A course can include other courses' units without copying them, and
   can hide, reorder and rename what it includes.
2. **Determinism.** The same manifest, the same published packages and the same lockfile always
   give byte-identical lockfiles and identical composed outlines.
3. **Integrity.** Every included package is identified by its ID, version and content digest.
   Content that changes after publication is refused.
4. **Rights that only narrow.** Including a module can restrict how its resources are used, never
   widen it.
5. **Data only.** A package contains no executable code, so composing or importing one can never
   run anything.
6. **No Git for teachers.** Version control is an implementation choice of a package store. The
   format, the composition API and every message it produces use course words: module, version,
   publish, update.
7. **Its own contract.** OCS maps to Thin CC, Common Cartridge and CASE through adapters, and says
   where those formats cannot carry its meaning.

### Non-goals

- Activity content. An activity reference names a published `ActivityDefinition` version; the
  definition (steps, Codex context, rubric slots, evidence plan) stays in the curriculum service.
- Student data. A course package never holds rosters, submissions, grades or student work.
- Rights certification. OCS records the use a package makes of a release. Whether a release permits
  that use is decided by the Content Studio review (C03), and is checked again at installation.
- A public registry. Packages are found through a package source the district chooses. `schoolos.dev`
  may distribute public packages but is never required, and never in the student data path.
- Backtracking dependency solving. See §6.4.

## 3. Package layout

A package is a set of UTF-8 JSON files at fixed paths. There are no other files.

```
ocs.json                 manifest (required)
ocs.lock                 lockfile (written at publication)
units/<id>.json          one unit per file
activities/<id>.json     one activity reference per file
resources/<id>.json      one resource reference per file
codex/<id>.json          one Codex note per file
```

`<id>` is a kebab-case local ID (`[a-z][a-z0-9-]{0,62}`), and the file's `id` field must equal it.
A reader refuses any other path (`scripts/`, `*.js`, `package.json`, `.github/`, anything), any file
that is not JSON, and any file over 256 KiB, and reads at most 2,000 files. Every object is strict:
an unknown field is an error, so nothing rides along unvalidated.

### 3.1 Manifest (`ocs.json`)

| Field | Meaning |
| --- | --- |
| `specVersion` | `"1.0"`. |
| `id` | The package ID: the publisher's domain, `/`, a kebab-case name, such as `northfield.example/biology-9`. The domain keeps publishers' names apart without a central registry. |
| `version` | The package version (§4). |
| `title`, `summary` | Plain text (§9). |
| `subject`, `gradeBand` | Optional, in the `@schoolos/contracts` vocabulary. |
| `language` | A BCP 47 tag. |
| `standards` | Course-level alignments, `{ frameworkKey, competencyUri }`, resolved against the district catalog when activities are authored. |
| `modules` | The packages this one includes (§5). |
| `outline` | The course order: `{ kind: "unit", unit }` for one of the package's own units, `{ kind: "module", module }` for all of a module's units, in the module's own order. Every module appears exactly once; a unit ID and a module name may not collide. |
| `overrides` | Changes to included content (§7.2). |

### 3.2 Units, activities, resources and Codex notes

- **Unit:** `{ id, title, summary?, standards, items }`, where each item is `{ kind: "activity" |
  "resource" | "codex", ref }` naming a file of this package. An item appears in a unit once.
- **Activity:** `{ id, title, role, definition: { definitionId, version } }`. `role` is `lesson`,
  `assignment` or `assessment`, which is how the roadmap's "assignments and assessments" appear: an
  assessment is an activity whose definition carries its evidence contract and rubric slots.
- **Resource:** `{ kind: "release", id, title, release: { resourceId, version }, use }`, a Content
  Studio release and the rights mode the package uses it under. A Gadget Blueprint is
  `{ kind: "gadget-blueprint", id, title, release, releaseCommit, use }` (§9).
- **Codex note:** `{ id, title, body, purpose: "context" | "answer-key", visibility: "students" |
  "teacher-only" }`. An answer key is always teacher-only, the same rule as the curriculum Codex.

## 4. Versioning

- **Packages** use semantic versions, `MAJOR.MINOR.PATCH`, with no pre-release or build suffix in
  1.0. A published version is immutable: a store accepts the same version again only with identical
  content. The composition API turns a teacher's description of a change into the next version:
  `fix` bumps the patch, `addition` the minor, `major-change` the major.
- **The format** uses `specVersion`. 1.0 readers refuse any other value. A later minor format
  version may add optional fields; because objects are strict, a 1.0 reader refuses a package that
  uses them rather than silently ignoring them. A major format version may change meaning and needs
  a migration.
- **The lockfile** has its own `lockVersion` (1), so the lock layout can change independently.

## 5. Dependency model

A module reference is:

```json
{ "name": "lab-safety", "package": "labsafe.example/lab-safety", "range": "^1.2.0",
  "digest": "sha256:…", "rights": "embed" }
```

- `name` is how this package refers to the module in its outline and overrides.
- `package` and `range` say which versions are acceptable. A range is one or more space-separated
  terms that must all hold: an exact version (`1.2.0`), a caret range (`^1.2.0`, npm semantics: the
  leftmost non-zero component stays fixed), a tilde range (`~1.2.0`: patch updates only), or a
  comparison (`>=1.2.0`, `<2.0.0`). There is no `||` and no wildcard, so every range is one interval.
- `digest` optionally pins content. It is allowed only with an exact version.
- `rights` optionally caps the use of the module's resources (§8).

A package is included at most once by any one manifest. The whole course resolves each package ID
to exactly one version (a flat graph), so a module shared by two others is one version, not two.

### 5.1 Package digest

The digest is `sha256:<hex>` of the canonical JSON of the sorted list of
`[path, canonicalJson(parse(file))]` pairs over every file except `ocs.lock`. Canonical JSON sorts
object keys (`@schoolos/catalog` `canonicalJson`). So reformatting or reordering keys does not
change a digest, and any change of content does. The lockfile is excluded because it is derived
from the manifest and the sources; only the course's own lockfile is ever used.

## 6. Resolution and the lockfile

### 6.1 Package sources

A resolver reads from a **package source** with two operations: list a package's published
versions, and get one version's files with the digest recorded at publication. A source is not
trusted. For every package it returns, the resolver recomputes the digest and checks it against
the published digest, against any pin in the requiring module, and against the locked digest if the
lockfile has that version. It checks that the manifest's ID and version are the ones requested.

The district's own library is a Durable Object SQLite store (`DurableObjectPackageLibrary`). A
published version is immutable: publishing it again succeeds only with identical content, and the
table refuses any update or delete. Every publication passes the district's publication policy,
which checks publisher signatures (§13.2).

### 6.2 Algorithm

```
selected := {}
repeat (at most 64 rounds):
  requirements := walk the root manifest, then the manifest of every selected package reachable
                  from it, collecting (package, range, digest?, requiredBy)
  for each required package, in ID order:
    candidates := published versions satisfying every range for it
    choose the locked version if it is a candidate, otherwise the highest candidate
    no candidate -> version conflict (every requirement, every available version)
    load the chosen version, verify identity and digests
  if the choices equal the previous round's: stop
reject cycles (a depth-first walk in module-name order from the root)
write the lockfile
```

A module that includes the course itself, or any loop between modules, is rejected with the loop's
path. Packages that become unreachable when a selection changes drop out in the next round. The
round bound only stops requirements that chase one another forever, which is reported as a conflict.

### 6.3 Lockfile (`ocs.lock`)

```json
{
  "lockVersion": 1,
  "specVersion": "1.0",
  "root": { "id": "…", "version": "…", "digest": "sha256:…", "modules": [{ "name": "…", "package": "…", "version": "…" }] },
  "packages": [{ "id": "…", "version": "…", "digest": "sha256:…", "modules": [] }]
}
```

`packages` is sorted by ID and each `modules` list by name; the file is written as canonical,
two-space-indented JSON with a final newline. It contains no timestamps, hostnames or source
locations, so the same inputs produce the same bytes on any machine.

### 6.4 Why highest-compatible without backtracking

Choosing the highest acceptable version per package, re-evaluated to a fixed point, is predictable
and explainable: a teacher can be told exactly which two modules disagree and which versions exist.
A backtracking solver can find solutions this one misses, but the solution it finds depends on
search order and is much harder to explain. Course graphs are small and shallow, so OCS prefers a
clear conflict ("lab safety: the course needs ~1.0, cells-core 2.0.0 needs ^2.0") to a clever answer.

A lockfile is a preference, not a freeze. A locked version is kept while it still satisfies every
range, so adding one module never updates the others. A teacher asks for updates explicitly
(`updateModules`), and the preview lists every version that moves.

## 7. Composition

### 7.1 Flattening

Composition reads only a resolution (the lockfile plus the verified packages), so composing from
the same lockfile always gives the same outline. Each package's outline is built recursively: its
own units in place, each module's composed outline where the module is placed, then the package's
own overrides. A module's overrides therefore apply before those of the package that includes it,
and the course always has the last word.

Every unit and item records its **provenance**: the package ID, the locked version and digest, and
the module path from the course. Keys are written `modules/joined:unit#item` (`bio/safety:rules#goggles`;
a course's own unit is just `intro`).

When two modules include the same unit of the same package, it appears once, at its first position;
later positions are reported as repeated.

### 7.2 Overrides

Overrides only reach into modules: a package edits its own units directly. A target names the
module path from the declaring package, a unit, and optionally an item.

| Override | Effect |
| --- | --- |
| `hide` | Leaves a unit or item out of the composed course. It is reported as hidden. |
| `rename` | Gives a unit or item another title in this course. The item records that it was renamed. |
| `reorder` | With a module path only, reorders that module's own units; with a unit, reorders the unit's items. Listed IDs come first in the given order, the rest keep their order after them. Units a nested module contributes keep their positions. |

An override that matches nothing, which happens when a module's new version drops or renames what
it named, is an error. It is never silently ignored, because a hidden answer key that reappears is
worse than a failed update.

## 8. Rights propagation

Each resource reference declares the use its package makes of a release (`link` < `embed` <
`excerpt` < `licensed-copy`, the registry `RightsMode` order). Each module reference may declare a
`rights` cap. The use a composed course may make of a resource is the narrowest of its declared use
and every cap on the path from the course to the package that declares it. Nothing in the format
can widen a use: there is no override for rights, and a cap wider than the declared use has no
effect.

This is a ceiling, not a grant. Installation still validates every release against the Content
Studio's permitted uses and the target class (C03, C05).

## 9. Security model

- **No executable code.** The layout admits only JSON files at fixed paths, every object is strict,
  and text fields are plain text. Text containing script or active markup (`<script`, `<iframe`,
  `<object`, `<embed`, `<svg`, `<style`, `<form`, `<meta`, `<link`, `<base`, `javascript:`,
  `vbscript:`, `data:text/html`) is refused as defense in depth; renderers must still render package
  text as text.
- **Gadget Blueprints by release, never inlined.** A blueprint appears only as a registry release
  of a `gadget-blueprint` resource and the release commit that release names. Its files never
  appear in a package. Neither does its blueprint ID, which in the Workshop is a bearer share link to
  the blueprint's code (`docs/blueprints.md`); a package that is exported or shared must not carry
  capabilities. The code runs only inside a Gadget sandbox, after the district has approved the
  release (ADR-0002 rule 5).
- **Untrusted sources.** Every package is verified by digest, ID and version (§6.1). A tampered
  mirror, a source that substitutes another package, or a version republished with different
  content is refused.
- **Imported text is data.** Package text reaching an AI helper is subject to the same threat T7
  handling as Codex content: delimited, never instructions.
- **No authority.** A package grants nothing. Installing a composed course goes through the
  curriculum service, which authorizes the teacher for the offering and validates each activity
  against it.

## 10. Relation to other formats

| Format | Relation | What does not carry over |
| --- | --- | --- |
| Thin Common Cartridge (C04) | Import and export adapter (`ocsFromCartridge`, `cartridgeFromOcs`). Each top-level Thin CC module becomes a unit holding the web links beneath it that the Content Studio released. A unit becomes a Thin CC module of web links to its releases' locators. | Thin CC to OCS: LTI tools (no release), unreleased or refused links, nesting below the top level, standards claims (not reviewed alignments), descriptive metadata, and titles that are not plain text. OCS to Thin CC: modules, overrides, activities, Codex notes (answer keys never leave), Gadget Blueprints, releases without a public locator, rights uses and standards. Each direction returns the list of what it lost. Thin CC carries links and hierarchy, never Gadget code. OCS is not "Thin CC with extras" and must not be described as Thin CC. |
| Common Cartridge 1.3 | Export adapter for LMS hand-off (later). | Module structure is flattened; activity semantics reduce to links or LTI placements. |
| CASE 1.1 | Standards interchange. `standards` and unit alignments name competencies in the district catalog, which is mirrored from CASE packages (C01, C02). | OCS does not carry framework content, only references. |
| LTI | External publishers' tools are resources (`lti-tool` releases) launched through an approved registration (I01). | Launch configuration and keys never appear in a package. |
| Git | A package store may keep packages in Git (for example Cloudflare Artifacts, W03), and a package directory is a natural repository. | Nothing in the format depends on Git, and teachers never see it. |

## 11. Implementation (`@schoolos/ocs`)

- Schemas: `OcsManifest`, `OcsUnit`, `OcsActivity`, `OcsResource`, `OcsCodexNote`, `OcsOverride`,
  `OcsLock`; `readPackage`, `packageDigest`, `formatJson`.
- Resolution: `PackageSource`, `resolveCourse`, `serializeLock`; `InMemoryPackageLibrary` as the
  reference store.
- Composition: `composeCourse`.
- Teacher composition: `startCourse`, `editCourse`, `addModule`, `removeModule`, `updateModules`,
  `reorder`, `hide`, `rename`, `preview`, `publish`.
- Export: `planInstallations` and `installCourse`, over `CurriculumService.install`.
- Failures are `OcsError`, a `SchoolOsError` carrying a structured `OcsProblem`.
- Thin CC adapter: `ocsFromCartridge`, `cartridgeFromOcs`, both returning `AdapterLoss` lists.
- Publisher signatures: `PackagePublication`, `signPackagePublication`, `PublisherTrust`,
  `checkPublication`, `publisherPolicy`.
- Durable library: `DurableObjectPackageLibrary` (`@schoolos/ocs/durable-object-library`).

## 12. Open questions

1. **Portable activity references.** Decided; see §13.1.
2. **Duplicate units across modules.** 1.0 shows a shared unit once, at its first position. Should a
   course be able to choose the position, or show both?
3. **Pre-release versions.** Should publishers be able to offer `2.0.0-beta.1` to teachers who opt
   in, and how is that explained without developer vocabulary?
4. **Signatures.** Decided and implemented; see §13.2.
5. **Stable item identity.** Overrides currently name items by local ID. If a
   module renames an internal ID between versions, overrides break loudly (§7.2). Is a stable item
   identity across versions worth its cost?
6. **Rights caps per resource.** 1.0 caps per module. Is a per-resource cap needed, and can it stay
   narrow-only?
7. **Naming.** "Open Course Specification" is a working name (roadmap §15 item 10). Confirm the name
   and whether to publish the format outside SchoolOS.

## 13. Decisions

### 13.1 Portable activity references (Q1, for OCS 1.1)

**Decision.** An activity stays a pointer. OCS 1.1 adds a second, portable form of pointer. It
names a published **activity definition export** by publisher-scoped ID, version and digest:
`{ portable: { id: "<domain>/<name>", version, digest } }`. The district-local form
`{ definitionId, version }` stays valid within its own district.

- **The export is data only.** It holds the template, the evidence contract (alignments by CASE
  URI, not by district catalog revision) and the rubric. It carries no scope, no principals, no
  answer keys and no code. It is published to the same libraries as packages, under the same rules:
  an immutable version, a digest, and a publisher signature (§13.2).
- **Installing in another district never uses a foreign definition ID.** The destination's
  curriculum service imports the export as a draft definition in its own district. Its teachers and
  curriculum admins review and publish it like any definition they author, and its alignments
  resolve only against the destination's approved catalog. The installation records the mapping
  from the portable reference to the local `definitionId@version`. A package naming a district-local
  ID that the destination does not hold fails to install, loudly.

**Why not the alternatives.**

- *Definitions inside the package* would make every course package carry rubrics and evidence
  contracts that are not the package's own. It would also break "activities are pointers" (§3.2).
  A package could no longer be shared without its activities' teacher-only material.
- *A central definition registry* would be a service every district depends on, which ADR-0001
  rules out. The district library already provides what a registry would: immutable versions,
  digests and verified publishers.

**What it does not change.** OCS 1.0 packages and lockfiles are unaffected. The portable form is
additive, and `specVersion` becomes `"1.1"` only for packages that use it.

### 13.2 Publisher signatures (Q4, implemented)

**Decision.** A package from outside the district enters its library only with a publisher
signature by a key the district approved for that publisher's domain. The domain is the part of the
package ID before the slash. The district's own domains (`PublisherTrust.localDomains`) publish
unsigned.

- **Keys are pinned per publisher domain.** Each publisher has its own list of approved keys, in
  `@schoolos/releases`' `TrustedReleaseKey` shape with retirement times (R03). Only the district
  changes the list; no root key set rotates it. A key approved for one publisher cannot sign
  another publisher's packages. Nothing carried with a signature is trusted as a key.
- **What is signed.** `PackagePublication { packageId, version, digest, publishedAt }`, as canonical
  JSON in OCS's own signing context (`schoolos-ocs/v1`). A signature made for a release, an offer or
  any fleet message never verifies as a package publication, and the reverse.
- **Who holds the keys.** Each publisher holds its own private keys. A district approves a
  publisher's public keys as a curriculum decision. The root holds none of them.
- **Where it is enforced.** At publication, by the library's policy (`publisherPolicy`). The library
  keeps the accepted signature with the version. The resolver still checks every package's digest,
  so a signed version that changes in storage is refused as well.

