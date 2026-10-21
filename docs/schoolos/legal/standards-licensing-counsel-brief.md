# Counsel brief: CASEL-organized indicators and Michigan standards reuse

> **This is not legal advice.** Engineers wrote this brief to put precise questions to counsel. It
> summarizes publicly posted terms as they read on 2026-10-20 and 2026-10-21, and offers no view on
> how they apply. Nothing here should be relied on as a legal conclusion until counsel answers.

- Issue: SCHO-62 (follow-up of SCHO-14).
- Engineering record: [standards-licensing.md](../standards-licensing.md). The catalog that applies
  its decisions is `packages/schoolos-catalog/src/catalog.ts`.
- Requested from: counsel for the SchoolOS project.
- Answer needed by: before SchoolOS ships CASEL-organized indicator text, or any Michigan standards
  text, in its public repository or in a district install.

## Background, in brief

- SchoolOS is open-source software. Each school district installs it in its own cloud account.
- The repository is **public**, so anything committed to it is published.
- SchoolOS ships a catalog of curriculum frameworks. For each framework it ships either the
  standards' text or only metadata (codes, hierarchy, grade bands, and a link to the publisher). The
  choice depends on the publisher's terms.
- Where text can't ship, a district imports it at install time from the publisher, or from a
  standards registry, into its own account.
- PlayTrek is a related product. Its code and seed data may be reused under ADR-0006. PlayTrek's
  standards seeds are at `packages/db/src/seed/standards/` in the PlayTrek repository, at commit
  `7258e4347`.
- **Is SchoolOS commercial?** It may be offered commercially: a hosted root service, support, or
  paid capability packs. Counsel should assume commercial use is possible unless told otherwise.

## Question 1: PlayTrek's 72 CASEL-organized indicators

### The facts

- PlayTrek's file `casel-sel.ts` holds **72 indicators**. That is 24 sub-competency labels, times
  three grade bands (K-2, 3-5, 6-8), with one indicator each.
- The labels sit under **CASEL's five competency names**: Self-Awareness, Self-Management, Social
  Awareness, Relationship Skills and Responsible Decision-Making.
- The file's header comment says the content is "Based on CASEL's Interactive SEL Framework (2024
  revision)".
- **The 24 sub-competency labels** are:
  - Identifying Emotions, Accurate Self-Perception, Recognizing Strengths, Self-Confidence,
    Self-Efficacy
  - Impulse Control, Stress Management, Self-Discipline, Goal-Setting, Organizational Skills
  - Perspective-Taking, Empathy, Appreciating Diversity, Respect for Others
  - Communication, Social Engagement, Relationship-Building, Teamwork
  - Identifying Problems, Analyzing Situations, Solving Problems, Reflecting, Ethical Responsibility

  *Engineering observation, to be confirmed:* these appear to match the sub-skill lists CASEL
  published with its framework around 2015-2017. CASEL's list also has "Self-Motivation" and
  "Evaluating", and PlayTrek has neither. This comparison was made from memory of CASEL's
  older publications, not against a copy; a reviewer should confirm it.
- **The indicator sentences** are PlayTrek's own writing, as far as engineering can tell. CASEL
  does not publish grade-band indicators, and no indicator sentence was found in CASEL's materials.
  This has not been checked exhaustively. An example of the style is "Recognize and label basic
  emotions (happy, sad, angry, scared, surprised) in oneself; begin to notice physical cues
  associated with different feelings."
- CASEL's own competency definitions, the one-sentence "The abilities to…" statements, are **not**
  in PlayTrek's seeds.

### What SchoolOS does today

The catalog ships:

- the codes, such as `CASEL.SEL.SA.K2.1`;
- the five competency names;
- the K-2, 3-5 and 6-8 bands, and the hierarchy;
- an attribution: "The CASEL 5 framework is the work of the Collaborative for Academic, Social, and
  Emotional Learning (CASEL). The indicators listed with it here were written by PlayTrek, not CASEL,
  and are not endorsed by CASEL."

The catalog **withholds** the 72 indicator sentences **and** the 24 sub-competency labels.

### CASEL's published terms

1. **The Terms of Use** (<https://casel.org/terms-of-use/>):
   > "You may access the Service Contents on the Websites only for your own personal, non-commercial
   > use. Unless otherwise stated, the Service Contents may not be copied, reproduced, modified,
   > published, uploaded, downloaded, posted, transmitted, or distributed in anyway without our
   > prior written permission."
2. **The License Agreement for Accessing Materials and Downloading Materials from the CASEL.org
   Network** (<https://casel.org/terms/>). The same text appears at
   <https://schoolguide.casel.org/license-agreement-for-online-access/> and
   <https://drc.casel.org/license-agreement-for-online-access/>.
   - **What it grants:** "a limited, non-exclusive, non-transferable, non-sublicensable and
     royalty-free, right and license… to use, reproduce, publish… and to modify, alter, edit, and
     create derivative works of the CASEL Materials… solely in the Territory and in connection with
     the Purpose."
   - **Commercial use:** "Licensee may not use, reproduce, publish, broadcast, distribute,
     disseminate, publicly display, or otherwise exploit any CASEL Materials with the intent of
     earning a profit or for commercial purposes."
   - **Derivative works:** "Licensee hereby irrevocably assigns to CASEL… all right, title and
     interest in and to the Licensee Derivative Materials… subject to a license back to Licensee."
   - **Attribution:** licensees must "place or retain notice of CASEL as the source", and must give
     CASEL a copy of derivative materials.
   - **Definitions:** "Purpose" is "to incorporate evidence-based social and emotional learning
     ("SEL") programming into student education from preschool through high school". "Territory" is
     left **blank** on casel.org/terms. It is "the United States of America" in the School Guide
     version.
   - **Governing law:** Illinois.
3. **The framework page** (<https://casel.org/fundamentals-of-sel/what-is-the-casel-framework/>)
   names the five competencies and calls the framework "the CASEL wheel". It has no separate licence
   statement.
4. **No permissions page was found.** <https://casel.org/permissions/> answered 404 on 2026-10-21,
   and no reprint form was found.

### The precise questions

1. **The indicator sentences.** Are PlayTrek's indicator sentences "Licensee Derivative Materials",
   or otherwise derivative works, of CASEL Materials? Assume they were written by PlayTrek, organized
   under CASEL's five competency names and 24 sub-skill labels, and quote none of CASEL's text.
   - Does the answer depend on whether PlayTrek ever accepted the CASEL license, for example by
     downloading materials from casel.org? Engineering cannot determine whether it did. **PlayTrek's
     authors must say.**
2. **The 24 sub-skill labels.** Assuming the indicator sentences are not derivative, can SchoolOS
   publish the labels, which are short phrases matching CASEL's published sub-skill names, in a
   public repository and a possibly commercial product?
3. **The five competency names.** Can SchoolOS keep using them, and the "CASEL 5" framework name,
   with the attribution above, in a possibly commercial product? Does it matter whether the use is
   nominative?
4. **Endorsement.** Does any of this need CASEL's written permission? If counsel recommends
   permission, whom at CASEL should we write to? Engineering found no permissions contact.
5. **The assignment clause.** Does the clause assigning derivatives to CASEL have any effect on
   SchoolOS or on districts, given that neither has accepted CASEL's license? Could a district that
   *has* accepted it, through CASEL's School Guide, be affected by importing CASEL-organized
   content?

### The options, and what each changes in the catalog

| Option | When it applies | Catalog change |
| --- | --- | --- |
| A. Keep withholding | Counsel advises the text is, or may be, derivative, or we can't establish how PlayTrek wrote it. | None. The current state stands, and the CASEL-5 K-8 bands stay "codes and grade bands only". |
| B. Ship the indicators as PlayTrek-authored | Counsel advises the sentences are not derivative and the labels may be used. | The seed generator stops withholding CASEL text. The 72 sentences and 24 labels ship, marked `derived`, attributed to PlayTrek, with the existing disclaimer of CASEL authorship and endorsement. The coverage report changes the K-8 bands to "available". |
| C. Ship the sentences, rename the labels | The sentences are fine, but the labels are a concern. | SchoolOS reviewers write neutral sub-skill labels, and the 72 sentences ship under them. CASEL's five competency names stay as grouping. This needs a reviewer pass. |
| D. Seek CASEL's permission | Counsel advises permission. | Depending on CASEL's answer: B, or a CASEL-licensed entry with CASEL's exact required notice. Until then, A. |
| E. Drop CASEL organization | Even the five competency names are a concern. | The indicators ship as a PlayTrek SEL framework with its own competency names. The `casel-5` catalog entry becomes a pointer to casel.org with no items. |

## Question 2: Michigan's reuse terms

### The facts

- The catalog's `michigan` entry is **pointer-only**: metadata and a link, with every grade band a
  declared gap. No Michigan standards text is in the repository, and PlayTrek has no Michigan
  seeds.
- **The site-wide policy.** The State of Michigan's website policy,
  <https://www.michigan.gov/som/footer/policies> (reached from <https://www.michigan.gov/policies>;
  the page says "Updated: December 2021"), reads:
  > "All content on Michigan.gov is the property of the State or its content suppliers and may be
  > protected by intellectual property or other laws. You may not modify, copy, distribute, display,
  > reproduce, publish, license, create derivative works from, sell, or transfer information,
  > products, services, images, designs, or logos obtained from Michigan.gov unless the law
  > otherwise provides or the State gives you prior written permission."

  It also restricts commercial use of data derived from the site. That sentence was not captured
  in full.
- **The MDE standards page** (<https://www.michigan.gov/mde/services/academic-standards>) says the
  standards "are intended to guide local curriculum development". It states no reuse terms. A search
  result shows a footer reading "Michigan Academic Standards Copyright State of Michigan".
- **The mathematics standards PDF**
  (<https://www.michigan.gov/mde/-/media/Project/Websites/mde/Literacy/Content-Standards/Math_Standards.pdf>)
  credits the National Governors Association and CCSSO in its references. It appears to be Michigan's
  adoption of the Common Core, whose own public license
  (<https://www.thecorestandards.org/public-license/>) SchoolOS already follows for the CCSS text.
- **The SEL competencies.** Michigan's "SEL Competencies and Indicators" (2017),
  <https://www.michigan.gov/-/media/Project/Websites/mde/2018/04/12/SEL_Competencies-_ADA_Compliant_FINAL.pdf>,
  carries no copyright notice. It says it was developed "in collaboration with national experts
  from… the Collaborative for Academic, Social, and Emotional Learning (CASEL)", and its competency
  definitions cite CASEL (2015). So Question 1's CASEL issues may apply to it as well.
- **CASE publication.** No CASE service run by MDE was found.
  - 1EdTech states that it "verified and published the K-12 English Language Arts and Mathematics
    standards for the 50 U.S. states" in its CASE registry, now Satchel Rosetta at
    <https://casenetwork.1edtech.org/>. That registry's API needs an account, so the Michigan records
    there were not inspected.
  - The only public CASE copy seen is a third party's "UI Copy" of the Michigan K-12 Social Studies
    Standards on OpenSALT (<https://opensalt.net/ims/case/v1p0/CFDocuments>).

### The precise questions

1. Do the michigan.gov site terms quoted above govern the Michigan K-12 Academic Standards as
   published by MDE? Or do the standards, as state educational standards, have different status?
   For comparison, Texas's agency states the TEKS are public domain for printing.
2. If the site terms govern, which of these needs MDE's written permission?
   - (a) A public open-source repository holding Michigan standards text.
   - (b) A district in Michigan importing the text into its own installation, for its own
     instruction.
   - (c) A district outside Michigan doing the same.
3. For subjects where Michigan adopted the Common Core verbatim (mathematics, ELA), does the CCSS
   public license govern the text, so that the Michigan copy adds no restriction? Or does the
   Michigan publication carry its own terms?
4. Does the CASEL analysis in Question 1 extend to Michigan's SEL competencies and indicators?
5. Whom at MDE should SchoolOS ask for written reuse terms, and for any official CASE endpoint?
   Engineering found no contact for either.

### The options, and what each changes in the catalog

| Option | When it applies | Catalog change |
| --- | --- | --- |
| A. Stay pointer-only | No reuse terms are obtained, or counsel advises against shipping text. | None. A district may still import Michigan standards from a CASE source it chooses, recorded as `derived` unless it is MDE's own. |
| B. Ship CCSS-identical subjects under the CCSS license | Counsel advises the CCSS license governs Michigan's verbatim adoption. | Michigan mathematics and ELA reuse the existing verbatim-checked CCSS rows, cross-walked to Michigan codes. Bands K-8 become "available". Other subjects stay gaps. |
| C. Ship with MDE's permission | MDE grants written terms. | The `MICHIGAN_LICENSE` entry records the grant's exact terms and notice. Text ships as `derived`, or as `official` if MDE provides a CASE endpoint. |
| D. A district-imported CASE source | MDE, or 1EdTech's registry, provides a CASE endpoint. | The catalog declares the endpoint. Districts import from it at install. Nothing ships in the repository. |

## What engineering needs back

For each question, a short answer that maps to one option row above, plus any notice text that must
accompany shipped content. Engineering then changes `catalog.ts`, the seed generator and
standards-licensing.md together in one PR. Their schema refuses shipped text under terms marked
`not-permitted`. The PR will link counsel's answer, recorded as a comment on SCHO-62.

## Sources

Every URL below was read on 2026-10-20 or 2026-10-21. Archive copies were not made.

- CASEL Terms of Use: <https://casel.org/terms-of-use/>
- The CASEL Materials License Agreement: <https://casel.org/terms/>,
  <https://schoolguide.casel.org/license-agreement-for-online-access/>,
  <https://drc.casel.org/license-agreement-for-online-access/>
- The CASEL framework: <https://casel.org/fundamentals-of-sel/what-is-the-casel-framework/>
- The State of Michigan website policies: <https://www.michigan.gov/som/footer/policies>
- MDE academic standards: <https://www.michigan.gov/mde/services/academic-standards>
- MDE SEL Competencies and Indicators (2017):
  <https://www.michigan.gov/-/media/Project/Websites/mde/2018/04/12/SEL_Competencies-_ADA_Compliant_FINAL.pdf>
- The CCSS Public License: <https://www.thecorestandards.org/public-license/>
- The 1EdTech CASE registry (Satchel Rosetta): <https://casenetwork.1edtech.org/>, and its status
  definitions at <https://www.imsglobal.org/casenetwork/resources>
- OpenSALT's public CASE API: <https://opensalt.net/ims/case/v1p0/CFDocuments>
