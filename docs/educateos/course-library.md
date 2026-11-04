# The district course library

- Status: in development (SCHO-331)
- Code: `packages/educateos-district-app/src/course-library.ts` (import, library, index),
  `packages/educateos-district-app/src/course-install.ts` (installing into a class), the district
  Worker's `COURSE_LIBRARY_TRUST` (`packages/educateos-district-worker/src/district.ts`), Teacher
  Studio's "Add a course" (`packages/educateos-teacher-ui/src/modules/CoursePanel.tsx`) and the
  admin console's Course library screen (`packages/educateos-admin-ui/src/courses/`)
- Format: [RFC 0001](rfc/0001-open-course-specification.md), OCS 1.1 (§13.1 portable activities,
  §13.2 signatures, §14 bundles); the courses themselves are authored in [`curriculum/`](../../curriculum/README.md)

A district keeps a library of [Open Course Specification](rfc/0001-open-course-specification.md)
courses. An administrator imports a course from a signed bundle, and a teacher adds it to a class.
Adding it creates draft modules with the course's pages, teacher notes and activities. Nothing the
class already has changes, and students see nothing until the teacher publishes a module.

## Trust

A district accepts courses only from the publishers its deployment pins in the district Worker's
`COURSE_LIBRARY_TRUST` var, a `PublisherTrust` from `@educateos/ocs`:

```json
{
  "localDomains": [],
  "publishers": [
    { "domain": "educateos.io", "keys": [{ "keyId": "ed25519-71yD_H7OvXca1DCaK5pp8PV-vIbDw9K2H3ZARqsNiWo", "publicKey": "7TQKh8xhmsc6yI2MUmIiuntUli4NyGU4Sr2v10P-dPk" }] }
  ]
}
```

Each publisher's keys are pinned to its domain, so an educateos.io key can never sign another
publisher's course. `localDomains` lists the district's own publishing domains, whose courses it
writes itself and imports unsigned. The pin holds public keys only, never a private key. A
request can never add to it.

The demo districts and the schoolos.gmac.io district (Northfield) pin educateos.io's key, read
from [`curriculum/educateos.io/publisher.json`](../../curriculum/educateos.io/publisher.json) by
`EDUCATEOS_COURSE_LIBRARY_TRUST` in `scripts/production/demo-districts.ts`. If that file's key
rotates, `pnpm production:configs` regenerates every config that pins it, and
`pnpm production:check` fails until they are regenerated. Without the var, every import answers
503 `unavailable`. A malformed value stops the district from starting, so a broken pin is never
mistaken for no pin.

## Importing a course

A district administrator or district curriculum administrator (policy rule
`curriculum.course-library.import`, people only, over `http`) posts a bundle to
`POST /api/admin/course-library`, or uses **Course library** in the admin console. A bundle is
`educateos.ocs-bundle.v1`, for example
`curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json`. The district:

1. Opens the bundle against its pin (`openBundle`). It checks every package and export digest and
   every signature, and trusts nothing the bundle says about itself. A tampered part answers 400
   `validation-failed`. A part that is unsigned, or signed by a key that isn't pinned, answers 401
   `unauthenticated`.
2. Plans the install from the bundle alone (`planBundleInstall`), so a course that wouldn't
   install is refused here rather than in a class.
3. Publishes every package and export into the district's library, an OCS
   `DurableObjectPackageLibrary` in the district's own Durable Object. Each part is stored with the
   signature it arrived with, and the library checks each signature again as it stores it.
4. Adds the course version to the library's index, with the outline teachers browse.

Importing a version that is already there changes nothing and returns the indexed entry. The same
version with other content is refused (409 `conflict`): a published version never changes. A newer
version is added beside the old one. `GET /api/admin/course-library` lists every version.

## Adding a course to a class

`GET /api/teacher/offerings/:offeringId/course-library` gives a class's teachers the latest version
of each course. Each entry says whether the course's subject and grade band match the class, and
what the class already has from it. A teacher previews an install with
`POST .../course-install/preview` and then installs with `POST .../course-install`, both taking
`{ packageId, version }`. All three need permission to create activities in the class.

The install acts as that teacher, through the district's own services, so every step is authorized
and validated exactly as if they had done it by hand. For each unit of the course, in order:

| The course has | The class gets |
| --- | --- |
| A unit | One unpublished module of the unit's title, recording the course, version, digest and unit it came from |
| A student Codex note | A page in that module |
| A teacher guide or answer key (teacher-only Codex note) | A teacher-only note in that module: a page students never see, even once the module is published |
| An activity (a portable export) | Each of its readings imported through the Content Studio and approved; its rubric signed as the district's own rubric release (no checks); a draft definition, published, installed, assigned with that rubric, and placed in the module |
| A district-local resource | Nothing. Another district's Content Studio releases mean nothing here (RFC 0001 §13.1) |

The teacher's explicit install is the review that publishes the imported drafts for the class. The
class's install record says who installed the course and when.

**Only adds.** If the class already has a module with a unit's title (compared ignoring case), the
unit is marked `exists` and skipped, and that module is left untouched. This is how the Grade 1
Reading showcase class, whose two modules are the reference course's units 1 and 2, receives only
units 3 to 6. An install never edits or removes anything.

**Standards first.** Before anything is written, the activities of the units still to install are
checked against the district's approved learning standards. If any alignment is to a standard the
district hasn't approved, the install is refused (400 `validation-failed`) and the preview's
`problems` names the codes. An administrator approves standards under **Learning standards**.

**Resumable.** Every step is saved to the class's install record as soon as it is done. A request
that stops part way is resumed by the next one, which does only what is missing. `maxUnits` (1 to
50) limits a request to that many units: Teacher Studio installs one unit per request so the
teacher sees progress. Each response is the plan with every unit's status (`new`, `exists`,
`installing`, `installed`) and `done`. The record also keeps the mapping from each export version
to the class's local definition, so a later course naming the same export version reuses it
(`reusedDefinitions` in the plan).

## Teacher-only notes

`teacher-note` is a course-module item kind (`@educateos/curriculum`), holding a page and a purpose
of `context` or `answer-key`. The student view of an outline drops these items, and their pages,
whatever the module's status. Removing the item or its module removes the page too. A Common
Cartridge export leaves them out and lists them as losses, because a cartridge has no
teacher-only page and an importing system would show them to students.

## Not yet

- Removing a course from the library, or a revocation list for a publisher key short of changing
  the pin.
- Upgrading a class from one course version to the next. A newer version installs as a separate
  course, and units whose titles the class already has are skipped.
- `COURSE_LIBRARY_TRUST` is not an installer deploy input yet. Only the generated demo and
  schoolos.gmac.io configs set it.
- No live import into a deployed district is recorded yet.
