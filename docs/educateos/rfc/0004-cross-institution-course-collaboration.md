# RFC 0004: Cross-institutional course collaboration over Open Course Standard

- **Status:** Proposed design, not implemented in EducateOS
- **Date:** 2026-11-14
- **Scope:** Shared curriculum, local adaptations, educator contributions, rich media, teacher-controlled upgrades
- **Separate:** Student evidence and records portability (draft EducateOS RFC 0003)
- **Independent standard:** https://github.com/gmackie/open-course-standard
- **Experimental profile changes:** https://github.com/gmackie/open-course-standard/pull/7

## 1. Decision

The course commons is a federation of **published instructional materials**, not a central curriculum
authority or mandatory EducateOS account service. Educators can adopt, adapt, and contribute
changes back to independent publishers. Each district owns its installation, data, curriculum,
rosters, student work, classroom releases, identity, and policy.

OCS 1.1 stays the strict data-only content and composition contract. Collaboration events and
rich-media artifacts are detached proposals, not new allowed OCS 1.1 package paths or fields.
The Foundation may operate optional discovery and mirrors, but no runtime control plane.

## 2. Repository grounding

The current EducateOS integration is more mature than an abstract design:

- packages/educateos-ocs: original OCS implementation.
- packages/educateos-district-app/src/course-library.ts: imports signed bundles only with
  district-pinned publisher keys, stores immutable packages and indexed course releases.
- packages/educateos-district-app/src/course-install.ts: installs via existing curriculum,
  Content Studio and assessment authorization, adds unpublished local modules, resumes interrupted
  installs and records course package versions and portable activity mappings.
- packages/educateos-teacher-ui/src/modules/CoursePanel.tsx: teacher preview and explicit install.
- docs/educateos/course-library.md: implementation evidence and outstanding gaps.

InstalledCourse already pins package ID, version and digest; InstalledUnit records unitKey,
moduleId and some item mappings; InstalledDefinition records portable activity import keys and
local definitions. This is a valuable starting point, not a blank slate. However, initial
installation may still mark an unrelated preexisting module as present by matching its title.
**Title cannot become the identity used for upgrades.** The current library cannot upgrade a class from one course version to the next;
a new version installs as another course and preexisting titles are skipped. No live deployed
course-library import acceptance is recorded by the existing document.

SCHO-348 should also bring the now-independent OCS 1.1 conformance suite into EducateOS CI
before new profile features are integrated. Do not claim that experimental OCS PR #7 is a
stable published package or a production-ready protocol.

## 3. Three explicit layers

1. **Immutable content:** OCS package ID, version, digest, signed publisher, unit and activity
   references, CASE alignments, module dependencies, lockfile and resource rights ceilings.
2. **Collaboration:** proposals referencing exact source and candidate, derivation and creative
   attribution, reviewer decisions, optional discovery, separately authenticated restricted sources.
3. **Local runtime:** teacher classroom installation, institution authorization, identity,
   student and assessment records, grades, approved standards, AI budgets, retention and policies.

A package signature proves which bytes a publisher signed, not instructional quality, author
identity, copyright title or permission to publish. Content derived from a signed publisher
must retain source attribution without claiming the origin is a human author.

## 4. Teacher workflow

### 4.1 Publish authorized material

Teacher selects classroom material and requests sharing. Verify institution authorization,
copyright and third-party media rights, absence of student data and answer-key leaks,
safe data-only content, accessible alternatives and approved publisher signature.
Private and consortium materials need real authenticated distribution. An openly downloadable
bundle containing OCS teacher-only notes is NOT a secure channel for exam secrets.

### 4.2 Adopt and adapt locally

Destination verifies the bundle using its own pinned publisher keys, resolves OCS dependencies,
then imports into its own course library. Create immutable local source mappings for each unit,
activity, resource and note: source package ID/version/digest/item path; local ID/revision,
installation principal/time, course offering and content digest. A teacher makes a new
local edition; the original publisher's immutable version never changes.

### 4.3 Propose a contribution

Contributor submits a proposed correction or pedagogical adaptation referring to an exact
signed source release and immutable candidate. A detached contribution profile captures changed
files and rationale; it never grants a capability, carries student records, embeds executable
patches or authenticates an educator by itself. The target publisher independently decides
whether to accept it and publish a new signed version.

### 4.4 Preview upstream changes

When a new upstream version appears, the local class remains pinned to its published material.
Read-only three-way comparison: original base, teacher's local edition and new source version.
At minimum classify: no changes; upstream only; local only; identical edits; competing edits.
Conflicting edits are displayed for human review, never silently combined. Review Codex notes,
rubrics, standards alignment and resource-use changes especially carefully.

### 4.5 Explicit adoption

A teacher chooses the new material and checks a local installation plan. Re-run trust,
OCS composition, standards approval, licensing, accessibility, policy, security flags and
assignment/assessment constraints. New local publications are staged; past submissions,
feedback and grades remain pinned to the exact content students originally saw.
Teacher refusal is always permissible. Rollback selects a previous approved local revision
without rewriting immutable packages or erasing student activity.

## 5. Proposed data records (conceptual, NOT existing APIs)

- InstalledSourceItem: offering, source {packageId, version, digest, path}, local {kind, id,
  revision}, installedAt, installedBy and contentDigest. Persist per item; do not match only titles.
- LocalCourseEdition: immutable local published content with parent source ref, school authorization
  and optional adaptation rationale. Private by default.
- ContributionProposal: detached experimental OCS change proposal plus publisher/rights review
  and authenticated contributor identity asserted by the service, not by untrusted input.
- CourseUpdatePreview: pinned base/local/upstream with per-item differences, warnings,
  dependency conflicts and rights/standards gates. Read-only.
- CourseUpdateDecision: local teacher approval and selected changes, subject to district
  authorization and audited installation transition.
- PortableResourceCandidate: separately transported digest-bound asset, publisher attestation,
  rights information, media-scanning outcome and approved local resource mapping.

Do NOT alter OCS 1.1 package semantics to include these records. The experimental source code
lives under packages/ocs/src/experiments in the independent standard repo; it is deliberately
not exported as a stable library API.

## 6. Access-control boundaries (proposed capabilities, not routes)

| Capability | Required principal and decision |
| --- | --- |
| Preview available course and update | Offering teacher; read-only local course permission |
| Start a local edition | Authorized teacher; district curriculum/content edit policy |
| Apply a reviewed update | Teacher, possibly curriculum admin, after content/security/rights gates |
| Open-publication request | Publisher-approved delegate plus school IP/privacy review |
| Submit external proposal | Authorized contributor and separately opted-in outbound sharing |
| Review and accept contribution | Maintainer authorized by target publisher, not by submitter |
| Fetch restricted content | Destination-controlled authenticated and bounded egress |

Existing API contract routes such as teacher.libraryCourses, teacher.previewCourseInstall and
teacher.installCourse remain unchanged until dedicated implementation and tests are reviewed.
No proposal may supply the authoritative principal or bypass existing authorization decisions.

## 7. Portable slides and documents

OCS 1.1 resource entries reference district-local content releases. A PowerPoint, PDF or image
cannot be safely made portable by embedding arbitrary bytes in ocs.json. A detached artifact
profile can declare ID/version/digest/length/media type/license/attribution and optional
accessibility alternatives. The external experimental verifier only checks claimed format
constraints and exact bytes; it does NOT authenticate ownership, inspect malware, or prove
the media type is safe.

Before a real import, the destination needs publisher-key validation, rights/use checking,
SSRF-resistant explicit fetching, bounded size and decompression, actual media scanning,
accessibility review and a local Content Studio release. Publisher links must never be
dereferenced on classroom render or as a side effect of LLM processing.

Portable media references in the core format would require a later OCS version with schemas,
conformance fixtures, signature context and bundle/installer requirements.

## 8. Security and legal invariants

- No student identifiers, rosters, grades, student work, private chats, credentials or test secrets
  in public proposal logs, bundles, resource manifests, review comments, discovery or mirrors.
- A CC license claim is not a rights grant; school policy and third-party ownership matter.
  Existing valid open licensing cannot be retroactively revoked by taking down a catalog entry.
- OCS teacher-only visibility is a UI/policy separation, not encryption of the bundle bytes.
- An AI-generated curriculum edit or standards mapping is a suggestion, never automatic proof
  of subject correctness, learning impact, publisher identity or CASE equivalence.
- District-local publishing and consumption must remain usable without the Foundation service.
- Keep untrusted package/media text as data, never executable instructions.
- A resource preview may be made available only under independent local permissions.
- Do not force an upstream update while a class or grade-assessment run is active.

## 9. Implementation stages and test gates

### A. Stable identity and read-only updates

Complete SCHO-348, then store exact source-to-local item mappings during new installs.
Migrate older installs conservatively; ambiguous title matches must be surfaced, not guessed.
Expose a read-only teacher update preview. Tests: same title/different ID, multiple sources,
publisher key revocation, missing item, wrong digest and replay.

### B. Approved classroom updates

Provide staged update plan and explicit teacher approval flow, with durable atomic application
and rollback. Tests: no unreviewed official-grade change, active submissions pinned, role
revoked mid-review, conflicting edits, term closure, standards/copyright restrictions,
failure halfway through and recovery.

### C. Cross-institution contributions

Institution-controlled local editions, proposal inbox, reviewer events, verified new release,
attribution and optional discovery. Tests: two truly independent accounts; one correction
returned to upstream, one rejected; no publisher impersonation, learner data sharing,
unauthorized rights expansion or dependency on the Foundation control plane.

### D. Rich-media interoperability

After OCS RFC acceptance, deliver PDF/PPTX local-release mapping through Content Studio.
Tests: file tampering, dangerous documents, media-type confusion, SSRF/redirect handling,
download size, licensed source, restricted source, accessible alternative, offline mirror.

## 10. Pilot and measurement

Start with six to ten teachers across two independent schools, ideally including a university
instructor. Run one complete Share -> Adapt -> Propose -> Review -> Explicit Upgrade loop using
fictional classroom records and institution-authorized content. Include one structured activity
and one presentation/document when the media profile is ready. Track teacher preparation time,
successful reuse, time to review a proposed change, conflict burden, rights-review failures,
accessibility, and whether collaboration is easier than emailing files.

External university partners may use Canvas or Moodle: participating should not require
installing EducateOS or registering with the Foundation. The OCS publisher/consumer contract
must remain implementable by non-EducateOS software.

## 11. Open questions

1. How should a stable item identity survive renaming across immutable course versions?
2. Should a rubric change create a new assignment ID, even when instructional title is unchanged?
3. How do schools delegate copyright/publishing authority to teachers?
4. Which provenance and review events need independent signatures?
5. Which media rights are distributable as a mirror versus access-controlled link only?
6. How do we federate discovery without a single authoritative curriculum catalog?
7. What should the smallest non-EducateOS reference consumer implement?

## 12. Status caveat

This RFC does NOT add live routes, approve new media types in OCS 1.1, ship an update UI,
create a cross-district account or move student evidence. The three independent OCS experimental
modules and tests are reviewable, but the EducateOS runtime remains unchanged.
