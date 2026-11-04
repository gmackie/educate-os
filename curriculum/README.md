# EducateOS curriculum

The sample courses EducateOS publishes for every district (SCHO-329), authored here as
[Open Course Specification](../docs/educateos/rfc/0001-open-course-specification.md) (OCS) 1.1
packages. Each course is one OCS package, its activities are portable activity exports (RFC 0001
§13.1, §14), and `scripts/curriculum/` validates, packs and signs them into the bundle a district
installs. `pnpm lint` runs `pnpm curriculum:check`, so CI fails on an invalid, stale or unsigned
course.

The reference course is [`educateos.io/grade-1-reading-foundations`](educateos.io/grade-1-reading-foundations).
Start a new course by reading it.

## Layout

```
curriculum/
  README.md
  educateos.io/                                  one directory per publisher domain
    publisher.json                               the publisher's public keys
    activities/                                  the publisher's portable activity exports
      grade-1-reading-foundations-word-builders.json
      …
    grade-1-reading-foundations/                 one OCS package, exactly RFC 0001 §3
      ocs.json                                   manifest
      ocs.lock                                   lockfile (written by pack)
      units/<id>.json                            one unit per file
      activities/<id>.json                       one activity reference per file
      codex/<id>.json                            one Codex note per file
      resources/<id>.json                        optional; Content Studio releases (district-local, so not used here)
  bundles/
    educateos.io/grade-1-reading-foundations/1.0.0.json   the signed bundle of each course version (written by pack and sign)
```

**Why exports live beside the courses, not inside them.** A course directory is an OCS package and
nothing else: an OCS reader refuses any path outside §3's layout (`exports/` included), and the
package digest covers every file in it. Keeping exports in the publisher's `activities/` directory
keeps that rule intact, and matches what an export is: a document with its own ID, version, digest
and signature, published to a library beside packages, which more than one course (or a later
version of the same course) may name. A course pins each export it uses by version and digest, so
changing an export is visible in every course that uses it. `activities` is therefore never a course
name.

Everything in this directory is data and is committed, bundles and signatures included. Private keys
never are.

## IDs

| Thing | ID | File |
| --- | --- | --- |
| Course package | `educateos.io/<course>` | `educateos.io/<course>/ocs.json` (`id` must match the directory) |
| Activity export | `educateos.io/<course>-<activity>` | `educateos.io/activities/<course>-<activity>.json` (`id` must match the file name) |
| Unit, activity reference, Codex note | kebab-case local ID, `[a-z][a-z0-9-]{0,62}` | `units/<id>.json` and so on; the file's `id` must match |

Use the same `<activity>` for the package's activity reference and the export, for example
`activities/word-builders.json` pointing at `educateos.io/grade-1-reading-foundations-word-builders`.
Prefix Codex notes with their unit (`u3-overview`, `u3-teacher-guide`, `u3-answer-key`).

Versions are `MAJOR.MINOR.PATCH`. Start at `1.0.0`. Once a version has shipped (merged to `main`),
it never changes: publish changed content as a new version of the export, and a new version of the
course. `check` refuses two bundles holding the same version with different content.

## File shapes

Every file is strict JSON: an unknown field is an error. All text is plain text, never HTML, and may
not contain script or active markup (`<script`, `<iframe`, `javascript:` and the rest of RFC 0001
§9). Emoji are fine.

### `ocs.json`

```json
{
  "specVersion": "1.1",
  "id": "educateos.io/grade-1-reading-foundations",
  "version": "1.0.0",
  "title": "Grade 1 Reading Foundations",
  "summary": "A semester of Grade 1 reading: …",
  "subject": "english-language-arts",
  "gradeBand": "1",
  "language": "en",
  "standards": [
    { "frameworkKey": "ccss-ela", "competencyUri": "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.2" }
  ],
  "modules": [],
  "outline": [{ "kind": "unit", "unit": "short-vowel-sounds" }, { "kind": "unit", "unit": "stories-we-love" }],
  "overrides": []
}
```

`specVersion` is `"1.1"` because the course uses portable activities. `subject` is one of
`english-language-arts`, `science`, `history-social-studies`, `mathematics`, `arts`,
`world-languages`, `computer-science`, `health-physical-education`, `social-emotional-learning`,
`other`. `gradeBand` is a grade or a range: `K`, `1`, `3-5`, `9-12`. `outline` lists the units in
teaching order. Leave `modules` and `overrides` empty unless the course includes another package.

### `units/<id>.json`

```json
{
  "id": "short-vowel-sounds",
  "title": "Short Vowel Sounds",
  "summary": "Hear, blend and change the short vowel sounds in three-sound words.",
  "standards": [
    { "frameworkKey": "ccss-ela", "competencyUri": "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.2" },
    { "frameworkKey": "ccss-ela", "competencyUri": "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.3" }
  ],
  "items": [
    { "kind": "codex", "ref": "u1-overview" },
    { "kind": "codex", "ref": "u1-teacher-guide" },
    { "kind": "activity", "ref": "tap-and-blend" },
    { "kind": "activity", "ref": "word-builders" },
    { "kind": "activity", "ref": "short-vowel-check" },
    { "kind": "codex", "ref": "u1-answer-key" }
  ]
}
```

Items appear in the order a district places them in the unit's module: student overview first, then
the teacher guide, the lesson, the assignments, the assessment, and the answer key last.

### `activities/<id>.json` (in the course)

```json
{
  "id": "word-builders",
  "title": "Word Builders",
  "role": "assignment",
  "definition": {
    "portable": {
      "id": "educateos.io/grade-1-reading-foundations-word-builders",
      "version": "1.0.0",
      "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
}
```

`role` is `lesson`, `assignment` or `assessment`. Write any digest (zeros are fine): `pack` fills in
the export's real digest. Only the portable form is allowed here; a `definitionId` means something
only inside one district.

### Codex notes, `codex/<id>.json`

```json
{ "id": "u1-overview", "title": "Sounds We Know", "body": "Every word has a vowel: a, e, i, o, u. …", "purpose": "context", "visibility": "students" }
```

| Note | `purpose` | `visibility` | A district installs it as |
| --- | --- | --- | --- |
| Student overview, and any reading students see | `context` | `students` | a page in the unit's module |
| Teacher guide | `context` | `teacher-only` | a teacher-only note |
| Answer key | `answer-key` | `teacher-only` (always) | a teacher-only note |

A teacher guide has five headed parts, in plain text: `OBJECTIVES` (each naming its standard code),
`MATERIALS`, `FIVE-DAY PLAN` (`Day 1:` to `Day 5:`), `DIFFERENTIATION` (support, stretch, and
multilingual learners) and `FAMILY NOTE` (a few sentences a teacher can send home as they are). An
answer key covers every activity in the unit, numbered as the questions are, plus a scoring tip.

### Activity exports, `educateos.io/activities/<course>-<activity>.json`

```json
{
  "specVersion": "1.1",
  "id": "educateos.io/grade-1-reading-foundations-word-builders",
  "version": "1.0.0",
  "language": "en",
  "activity": {
    "template": "read-and-respond",
    "title": "Word Builders",
    "subject": "english-language-arts",
    "gradeBand": "1",
    "overview": "Change one sound to make a new word.",
    "aiHelp": "hints-only",
    "due": { "kind": "after-install", "days": 5 },
    "passage": "Let's build words! Say a word. Change one sound. Now you have a new word!",
    "questions": [
      { "prompt": "Say cat 🐱. Change the first sound to /h/. Write your new word." },
      { "prompt": "Say pig 🐷. Change the first sound to /b/. Write your new word." },
      { "prompt": "Say hop. Change the last sound to /t/. Write your new word." }
    ],
    "answerBy": "writing",
    "sentenceFrames": []
  },
  "rubric": {
    "title": "Word builders",
    "criteria": [
      {
        "id": "sounds",
        "title": "I changed the sound",
        "levels": [
          { "id": "not-yet", "label": "Not yet", "points": 1 },
          { "id": "getting-there", "label": "Getting there", "points": 2 },
          { "id": "got-it", "label": "Got it!", "points": 3 }
        ]
      }
    ]
  },
  "alignments": [
    { "frameworkKey": "ccss-ela", "competencyUri": "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.3" }
  ],
  "readings": []
}
```

An export holds student-facing material only. It has no answers (they go in the unit's answer key),
no teacher notes (the teacher guide), no rubric IDs, no Content Studio release IDs, no fixed dates,
and no links or code.

- `aiHelp`: `full`, `hints-only` or `none`. Use `none` for assessments.
- `due`: `{ "kind": "none" }` or `{ "kind": "after-install", "days": 1-365 }`. Lessons usually have
  none.
- `collaboration` (`individual`, the default, or `group`) and `additionalArtifactTypes` (default
  `[]`) are optional.
- `rubric`: every assignment and assessment has one; an assessment must. Each criterion has at least
  two levels, lowest first, each worth more points than the one before. K-2 rubrics use the three
  levels above, with criteria written as "I can" statements a family can read. Grades 3 and up use
  four: `beginning` 1, `developing` 2, `proficient` 3, `advanced` 4.
- `alignments`: at least one, by CASE competency URI (see below).
- `readings`: `[{ "id", "title", "body", "attribution"? }]`, original texts students read or hear
  beyond the activity's own prompt. The activity names those it uses in `activity.resources` (and a
  primary-source analysis in `activity.sources`), by reading ID; a district imports each as its own
  Content Studio release. Mark original EducateOS texts `"attribution": "Written for EducateOS."`.

### Templates and their inputs

Every template takes `title`, `subject`, `gradeBand`, `overview`, `aiHelp`, `due`, and optionally
`resources` (reading IDs), `collaboration` and `additionalArtifactTypes`. Then:

| `template` | For | Its own inputs |
| --- | --- | --- |
| `writing-task` | essays and other writing, 3-12 | `prompt`; `genre`: `argument`, `informative`, `narrative` or `literary-analysis`; `minWords` (optional); `minimumCitations` (0 for none; citations come from the readings if there are any) |
| `science-investigation` | labs | `question`, `methodPrompt`, `dataColumns` (`[{ "name", "unit"? }]`, at least one), `analysisPrompt` |
| `primary-source-analysis` | history and source work | `sources` (reading IDs, at least one), `sourcingQuestions` and `contextualizationQuestions` (lists of strings), `claimPrompt`, `minimumEvidence` |
| `problem-set` | mathematics | `problems` (`[{ "prompt" }]`, no answers), `showWork` (also permits a photo of working) |
| `picture-response` | K-2 and 3-5: look, draw, tell | `lookPrompt` (read aloud: one or two short sentences), `drawPrompt`, `tellAboutIt` (default true: a last step records the student telling about it), `sentenceFrames` (starters such as `"I drew a ___."`) |
| `read-and-respond` | K-2 and 3-5: listen, then answer | `passage` (a few sentences for K-2), `questions` (`[{ "prompt", "answerBy"? }]`, up to 10), `answerBy` (`speaking`, the default, `drawing` or `writing`; a question's own `answerBy` overrides it), `sentenceFrames` |

K-2 activities use `picture-response` and `read-and-respond`, which a five-year-old can do with
someone reading the screen aloud.

## Standards: finding real competency URIs

Alignments name competencies in the catalog's built-in releases (`ccss-ela`, `ccss-math`, `c3`,
`casel-5`, `head-start-elof`), never a district's catalog revisions. List real codes and URIs with:

```sh
node scripts/curriculum/curriculum.ts standards ccss-ela RF.1     # Grade 1 Reading: Foundational Skills
node scripts/curriculum/curriculum.ts standards ccss-ela RL.3     # Grade 3 Reading: Literature
node scripts/curriculum/curriculum.ts standards ccss-math 4.NF    # Grade 4 fractions
node scripts/curriculum/curriculum.ts standards c3 D2.His         # C3 history indicators (all bands)
```

Each line is `code`, `URI`, statement. CCSS URIs read
`urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.3` and
`urn:educateos:catalog:ccss-math:CCSS.MATH.CONTENT.4.NF.A.1`; C3 indicators carry their band
(`urn:educateos:catalog:c3:C3.D2.His.1.3-5`). Align to standards, components and indicators, never
to a heading, domain or cluster: `validate` refuses those, and any URI the catalog does not hold.
NGSS is not built in, so science activities align to CCSS literacy or mathematics where they
honestly can.

## The first units are the showcase's

Each band's showcase classes (`packages/educateos-fixtures/src/showcase/`) have two modules. A
course that continues one keeps those modules as its units 1 and 2: the same titles, in the same
order, holding the same activities (the same template and inputs, and at least their standards), so
a district that already has the showcase class installs only units 3 onward. Register the course in
`SHOWCASE_ORIGINS` in `scripts/curriculum/lib.ts` (course ID to showcase offering ID) and `validate`
holds it to this. Each showcase unit still gets the full unit bar below: the showcase's activities are
its assignments, and you add the overview, teacher guide, lesson, assessment and answer key.

## The bar for a course

- **Original text.** Write every passage, prompt and note yourself. No copied texts, no real people's
  names beyond well-known historical figures, no brands.
- **Age-appropriate.** Short sentences read aloud for K-2. Vocabulary and length that fit the grade.
- **Standards-aligned.** Every unit and every activity names the standards it teaches, and the
  teacher guide's objectives say which.
- **A semester.** About six units. Each unit has:
  1. a student overview (short, read-aloud friendly for K-2),
  2. a teacher guide (objectives, materials, a five-day plan, differentiation, a family note),
  3. a lesson activity,
  4. one or two assignments, each with a rubric,
  5. an assessment with a rubric,
  6. an answer key covering every activity.

`validate` enforces the structure (every item above, standards on every unit and export, rubrics on
assessments, two levels or more per criterion) and warns on a course far from six units. Quality of
writing is the author's and the reviewer's.

## Commands

```sh
node scripts/curriculum/curriculum.ts validate    # every course and export, with a per-course report
node scripts/curriculum/curriculum.ts pack        # fill in portable digests, write ocs.lock and the bundle
node scripts/curriculum/curriculum.ts sign        # sign what is unsigned with the educateos.io publisher key
node scripts/curriculum/curriculum.ts check       # all of the above, read-only: what CI runs
pnpm curriculum:check                             # the same, as part of pnpm lint
```

The loop is: edit, `validate` until it reports no errors, `pack`, `sign`, `check`, commit everything
(including `ocs.lock` and the bundle). `pack` is deterministic and keeps every signature whose content
did not change, so after an edit only the changed export and the course are signed again.

`validate` prints, per course, the units with their activities by role, the notes by visibility and
the number of distinct standards, then every error and warning with its file. A digest error marked
"run pack" is fixed by `pack`.

`sign` reads the publisher key from `EDUCATEOS_OCS_PUBLISHER_KEY` (an Ed25519 private JWK as JSON)
or, on macOS, from the Keychain item `educateos-marketplace-publisher-key` (account `educateos`),
the same key that signs the educateos.io marketplace listings. It never prints the key. It signs
only with a key `publisher.json` lists, so nothing it signs can fail `check`.

## Bundles

A bundle (`OcsBundle` in `@educateos/ocs`, format `educateos.ocs-bundle.v1`) holds the course
package, every package it includes, and every export they name, each with its files as published,
its digest and its publisher signature. A district import route passes it to `openBundle` with the
district's approved publisher keys (which checks every digest and signature, trusting nothing in the
bundle), then `planBundleInstall`, then `applyInstallPlan` with its own `CourseInstallTarget`. The
website can serve the same file.
