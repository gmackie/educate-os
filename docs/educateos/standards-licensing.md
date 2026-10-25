# Standards content licensing

This repository is public. Anything in it is published, so a framework's item text ships here only
where the publisher's terms clearly allow redistribution, and only with the attribution the terms
require (ADR-0006, rule 4). Where they do not, the catalog ships metadata and pointers, and a
district imports the text into its own account at install time through the CASE client.

The decisions below were made on 2026-10-20 by reading each publisher's terms at the URL given.
`packages/educateos-catalog/src/catalog.ts` encodes them, and the catalog's schema refuses an entry
that declares shipped text under terms marked `not-permitted`. Change the two together.

This is an engineering reading of published terms, not legal advice. Anything marked for review
below should go to counsel before EducateOS distributes more than it does today. The questions for
counsel are in [legal/standards-licensing-counsel-brief.md](legal/standards-licensing-counsel-brief.md) (SCHO-62).

## Summary

| Catalog key | Framework | Text in this repository | Status | CASE source |
| --- | --- | --- | --- | --- |
| `ccss-math` | CCSS Mathematics | Yes, where verified verbatim | available (K-12) | CASE Network record, via OpenSALT (mirror) |
| `ccss-ela` | CCSS ELA/Literacy | Yes, where verified verbatim | available (K-12, with 6-12 literacy) | None verified |
| `ngss` | Next Generation Science Standards | No | pointer-only | OpenSALT (mirror) |
| `c3` | C3 Framework for Social Studies | Yes, transcribed and verified | available (K-12) | None found |
| `casel-5` | CASEL 5 | No | available (codes and grade bands only) | None |
| `head-start-elof` | Head Start ELOF (pre-K) | Yes (PlayTrek paraphrase) | available (pre-K) | None |
| `teks` | Texas Essential Knowledge and Skills | No | pointer-only | TEA (publisher) |
| `michigan` | Michigan K-12 Standards | No | pointer-only | None verified |

"Status" and the coverage report by grade band are in the catalog entry. Every entry declares all
five bands (PK, K-2, 3-5, 6-8, 9-12) for each of its subjects, so a missing high-school band is a
declared gap rather than an omission.

## Approving standards in a district (SCHO-220)

A district uses a framework only once it approves a release of it. The `available` entries above
ship a built-in release, and a district administrator (or a curriculum admin assigned at district
scope; policy rule `curriculum.standards.manage`) approves or withdraws it on the admin console's
**Learning standards** page (`/admin/#/learning-standards`), or through the API:

| Route | What it does |
| --- | --- |
| `GET /api/admin/standards` | Lists every built-in framework, its subjects and grade bands, and whether the district approved it. |
| `POST /api/admin/standards/:frameworkKey/approve` | Selects the framework, installs the release EducateOS ships (the mirror accepts only those exact bytes) and approves it. Approving it again changes nothing. |
| `POST /api/admin/standards/:frameworkKey/withdraw` | Retires the approved release. Approving it again reinstates the same release. |
| `GET /api/teacher/offerings/:offeringId/learning-goals` | The goals offered on Create activity: items of every approved release whose framework covers the course's subject, at a grade the course spans, leaving out broad groupings (strands, domains) and items with no text. |

Learning goals are optional: an activity may have none. When it names some, the curriculum service
accepts only items of a release the district has approved, so a withdrawn release's goals are
refused for new and revised activities while existing ones keep what they recorded. A
`pointer-only` framework such as NGSS has no built-in release and cannot be approved this way;
until a district import path exists, science activities are created without learning goals.

## Provenance rules

- Catalog metadata (each `FrameworkDefinition`) is written by EducateOS reviewers and is `derived`.
- PlayTrek's seeds (`packages/db/src/seed/standards/` at commit 7258e4347) are a transcription by
  PlayTrek, so every record built from them is `derived`, with PlayTrek named as transcriber on the
  record. None is `official`.
- Content a district imports from the publisher's own CASE server is `official`. Content imported
  from a mirror, such as OpenSALT serving a copy, is `derived`, because EducateOS cannot check that the
  copy is unchanged.
- Text EducateOS reads from a publisher's own pages or publication (CCSS high school, the replaced
  K-8 statements, C3) is `derived` too: it is a transcription, not the publisher's record. Each
  statement ships only after a second publisher source matched it word for word, and otherwise ships
  empty. The scripts in `packages/educateos-catalog/scripts/` regenerate every row from the sources.
- EducateOS never writes standards text that could pass for the publisher's.

## CCSS Mathematics and ELA/Literacy

- Terms: Common Core State Standards Public License,
  <https://www.thecorestandards.org/public-license/>.
- The license grants "a limited, non-exclusive, royalty-free license to copy, publish, distribute,
  and display the Common Core State Standards for purposes that support the Common Core State
  Standards Initiative", in whole or in excerpts. It requires that NGA Center/CCSSO be acknowledged
  as sole owners and developers, and that any publication include the notice: "© Copyright 2010.
  National Governors Association Center for Best Practices and Council of Chief State School
  Officers. All rights reserved." It covers the standards, not the examples (such as the Appendix B
  text exemplars).
- The grant covers copying and distribution. It does not mention modification.

**Decision: text permitted, verbatim only.** PlayTrek's K-8 rows were compared word for word with
the publisher's pages on thecorestandards.org, by `packages/educateos-catalog/scripts/generate-playtrek-seeds.ts`:

| Framework | Verbatim | Differs only in presentation | Differs in wording (withheld) |
| --- | --- | --- | --- |
| Mathematics | 166 | 13 | 50 |
| ELA/Literacy | 255 | 73 | 45 |

"Presentation" means list labels written `(a)` rather than `a.`, dash and quote glyphs, whitespace,
or a full stop before a list label or at the end. The words match the publisher's. Rows that differ
in wording never ship PlayTrek's text, because shipping a changed text would be a modification the
license does not grant. Typical differences: a dropped cross-reference such as "(See grade 1
Language standards 1 and 3 here for specific expectations.)", or "as used in a text" for the
published "as they are used in a text". Domain and cluster headings were spot-checked the same way;
apart from footnote markers and dash spacing, they match.

**SCHO-63 (2026-10-21): withheld rows replaced, high school and 6-12 literacy added.** A row that
differed now carries the publisher's own statement, read from its page, wherever that statement
also appears word for word in the publisher's PDF edition
(<https://corestandards.org/wp-content/uploads/2023/09/Math_Standards1.pdf> and
`ELA_Standards1.pdf`). The high-school standards and the grade 6-12 literacy standards are read the
same way. `scripts/ccss-publisher-text.ts` lists the rules that turn the pages' markup into text:
superscripts are written `x^2` and stacked fractions `a/b`, footnote markers are dropped, and the
modeling star (★) is recorded beside the statement rather than in it. Those are changes of
presentation, the same class as "formatting-only" above.

| Rows | Shipped with the publisher's text | Withheld (page and PDF disagree) |
| --- | --- | --- |
| K-8 Mathematics rows PlayTrek got wrong | 46 of 50 | 4 |
| K-8 ELA/Literacy rows PlayTrek got wrong | 30 of 45 | 15 |
| High-school Mathematics (standards and lettered parts) | 189 | 3 |
| Grade 9-12 ELA (RL, RI, W, SL, L) | 144 | 5 |
| Grade 6-12 literacy (RH, RST, WHST) | 121 | 1 |

Most withheld rows are cross-references where the page says "here" and the PDF gives a page number
(W.x.5 and SL.x.6). The official text fills them in when a district imports from CASE. The
publisher's "(RL.9-10.8 not applicable to literature)" placeholders are not standards and are
not shipped.

The CCSS Mathematics CASE record is `c6496676-d7cb-11e8-824f-0242ac160002`, URI
`https://casenetwork.imsglobal.org/uri/c6496676-d7cb-11e8-824f-0242ac160002`, creator CCSSO,
adoption status Draft. CASE Network itself requires an account. OpenSALT serves the same record
publicly at `https://opensalt.net/ims/case/v1p0`. It has 746 items, including 274 high-school
items at education levels `09`-`12`, and it parses as CASE 1.1. No public CASE record for CCSS
ELA/Literacy was found.

## NGSS

- Terms: NGSS Copyright, Permissions, and Disclaimer,
  <https://www.nextgenscience.org/ngss-trademarks-and-copyright/ngss-trademarks-and-copyright>.
- "The copyright to the standards are held by the National Academies Press." The page grants that
  "states, districts, schools, teachers and non-profit education entities may copy, reproduce,
  alter, adapt, edit, delete and rearrange any and all parts of the NGSS as they see fit and without
  permission." The NGSS trademarks were transferred from Achieve to WestEd in May 2020, and uses of
  the mark carry the disclaimer: "__________ is a registered trademark of WestEd. Neither WestEd nor
  the lead states and partners that developed the Next Generation Science Standards were involved in
  the production of this product, and do not endorse it."

**Decision: metadata and pointer only.** A district may copy the NGSS. This public repository is
not one of the permitted parties, so it ships no text, and the district imports it. The catalog
entry carries the trademark disclaimer as its attribution. The OpenSALT record
`c608881b-d7cb-11e8-824f-0242ac160002` (creator "Achieve, Inc. (NGSS)", adoption status Draft,
last changed 2018-10-24) has 1,037 items covering K-12 and parses as CASE 1.1. It is a mirror, so an
import from it is `derived`.

## C3 Framework

- Terms: the title page of the NCSS publication,
  <https://www.socialstudies.org/sites/default/files/c3/C3-Framework-for-Social-Studies.pdf>:
  "The text of the document, and/or excerpts from it, may be freely reproduced. There is no need to
  apply to National Council for the Social Studies for permission to reproduce the text or
  excerpts." Required citation: "National Council for the Social Studies (NCSS), The College, Career,
  and Civic Life (C3) Framework for Social Studies State Standards: Guidance for Enhancing the Rigor of
  K-12 Civics, Economics, Geography, and History (Silver Spring, MD: NCSS, 2013)."
- The free-reproduction notice covers the 2013 framework document only. NCSS's book edition
  (Bulletin 113) adds chapters it does not cover.

**Decision: text permitted, transcribed (status `available`, SCHO-63).** No machine-readable source
was found, so `scripts/generate-c3-rows.ts` transcribes the Dimension 1-4 grade-band indicators from
the NCSS PDF. It reads each word's position on the page (`pdftotext -bbox`), assigns words to the
column of the indicator codes they sit under, and joins a word broken across lines only where the
document itself uses the joined form elsewhere, or the dictionary has it; a break neither settles
stops the run until a reviewed decision is recorded in the script. Each indicator is then checked
against a second reading of the PDF in its own reading order, and must match there whole. All 283
indicators did (the "Begins in grades ..." placeholder cells are not indicators). The entry's
attribution is the citation NCSS asks for. The companion documents for psychology, sociology and
anthropology in the appendices are not included.

## CASEL 5

- Terms: CASEL Materials License Agreement, <https://casel.org/terms/>, and the website Terms of
  Use, <https://casel.org/terms-of-use/>.
- The license is "limited, non-exclusive, non-transferable, non-sublicensable", for a stated
  territory and purpose. It bars exploitation "with the intent of earning a profit or for commercial
  purposes", requires notice of CASEL as the source, and makes CASEL the owner of licensee
  derivative materials. The Terms of Use say service contents "may not be copied, reproduced,
  modified, published ... or distributed" without prior written permission unless otherwise stated.

**Decision: no text.** CASEL publishes no grade-band indicators. PlayTrek's 72 K-8 indicators are
PlayTrek's own writing, organized under CASEL's five competencies and labelled with sub-competency
names close to CASEL's. Because CASEL's terms claim ownership of derivative materials and bar
commercial use, the indicator text and sub-competency labels are withheld. The catalog ships their
codes, the five competency names, the K-2/3-5/6-8 grade bands and the hierarchy, marked `derived`,
with a note that they are PlayTrek-authored and not CASEL text. **For review:** whether PlayTrek's
indicator text is a derivative of CASEL materials. If counsel says it is not, the text can ship as
PlayTrek-authored content.

The only CASE record seen with CASEL in its title (OpenSALT `0b749bac-115c-11ec-91ba-0242ac140003`,
"CASEL Standards", creator "Florida Genome Higher Order Thinking Standards") is a third party's
and is not declared.

## Head Start Early Learning Outcomes Framework (pre-K)

- The ELOF is a U.S. federal publication. GovInfo's record,
  <https://www.govinfo.gov/app/details/GOVPUB-HE23_1100-PURL-gpo65456>, lists its author as the
  Health and Human Services Department, Head Start Bureau, with genre "government publication".
  Works of the U.S. Government are not subject to copyright (17 U.S.C. § 105). The headstart.gov site
  policy pages refused automated requests (HTTP 403), so no site-specific reuse statement was read.
- PlayTrek's 23 pre-K goals (Literacy, Language and Communication, Mathematics Development) are
  paraphrases, not quotations, by PlayTrek's own account in the seed file.

**Decision: text permitted.** The paraphrases ship as written, `derived`, attributed to the ELOF.

## TEKS

- Terms: TEA's notice on its documents restricts reproduction to Texas districts, schools and
  residents, unedited and free of charge, and requires a license from everyone else. TEA's
  Proclamation 2024 Q&A,
  <https://tea.texas.gov/curriculum-and-instruction/instructional-materials/review-and-adoption-process/p2024-qa.pdf>,
  answers: "Since the TEKS are in the public domain, publishers do not need permission to print them
  in products."
- The two statements point different ways for a non-Texas public repository.

**Decision: metadata and pointer only.** TEA runs its own CASE service at
`https://teks-api.texasgateway.org/ims/case/v1p0` (CASE 1.0). The catalog declares the chapters for
ELA and reading (110), mathematics (111), science (112), social studies (113) and the 2022
Prekindergarten Guidelines. Imports from it are `official`. TEA's packages give
`CFDocument.subject` as a string instead of a list, and their items carry no `educationLevel`, so
the catalog's TEKS sources name the registry's `tea-teks-api` adapter (ADR-0011, SCHO-61). It
fixes the subject, derives education levels from each item's grade or course, and records both on
the provenance of every record it changed. The registry's tests use fixtures hand-authored to the
shape of TEA's responses with synthetic text, because TEA's terms do not let this repository ship
TEKS text, even as test data.

## Michigan

- The Michigan Department of Education's academic standards page,
  <https://www.michigan.gov/mde/services/academic-standards/michigan-academic-standards>, refused
  automated requests (HTTP 403). A search result shows its footer reads "Michigan Academic Standards
  Copyright State of Michigan". No reuse terms were found.

**Decision: metadata and pointer only (status `pointer-only`, every band a gap).** No CASE service
run by MDE was found. The only CASE copy seen, "UI - Michigan K-12 Standards for Social Studies" on
OpenSALT, is a third party's. **For review:** the actual reuse terms, and whether MDE publishes CASE.

## What CASE imports from real publishers showed (SCHO-45)

Decoding real packages with `decodeCasePackage`:

- OpenSALT's CCSS Mathematics (746 items) and NGSS (1,037 items) packages decode cleanly. Neither
  has fields outside CASE 1.1.
- TEA's TEKS packages fail on a type deviation (`CFDocument.subject` as a string), not on an unknown
  field. TEA's `CFDocuments` listing is also a bare array rather than `{ "CFDocuments": [...] }`.

So the fail-closed rule for unknown fields has not been the obstacle. The obstacle is named,
publisher-specific deviations in known fields. Handling them belongs in an explicit adapter that
records what it changed, not in a looser decoder. ADR-0011 records the decision: the decoder stays
strict, and publisher deviations go through named adapters whose changes are kept in provenance.
