# EducateOS founding pilot

- Status: Program defined; no district enrolled yet.
- Issue: SCHO-366 (parent SCHO-358).
- Public page: <https://educateos.io/pilot/> (`sites/educateos-io/public/pilot/index.html`).

The founding pilot is how the first three to five public districts in Texas and Michigan run
EducateOS: one school, a few champion teachers, about ten weeks, teacher-facing AI first. This
directory holds the editable sources for the public page and the operator playbook the EducateOS
pilot lead runs it with.

| File | What it is | Audience |
| --- | --- | --- |
| [program.md](program.md) | The program summary: who it's for, what each side gets and gives, the timeline, roles, readiness, the data rule, support and the end of the pilot. The public page mirrors it. | Districts, and us when we change the terms |
| [playbook.md](playbook.md) | How we run a pilot: the kickoff agenda, the weekly 20-minute check-in, the issue log, and the mid-point and end-of-pilot reviews. | The EducateOS pilot lead |
| [success-criteria.md](success-criteria.md) | A worksheet for the criteria agreed at kickoff, with example measurable criteria for teacher-facing AI and where each number comes from. | District sponsor, school lead, pilot lead |
| [surveys.md](surveys.md) | The champion teachers' baseline and exit surveys. | Champion teachers |
| [teacher-quickstart.md](teacher-quickstart.md) | The teacher quickstart, published at <https://educateos.io/pilot/teachers/>. | Champion teachers |
| [teacher-training.md](teacher-training.md) | The 60-minute kickoff training, published at <https://educateos.io/pilot/teachers/training/>. | The trainer |
| [family-letter.md](family-letter.md), [family-letter.es.md](family-letter.es.md) | The family letter in English and Spanish (Spanish pending native-speaker review), published at <https://educateos.io/pilot/families/>. | School lead |
| [student-ai-guidelines.md](student-ai-guidelines.md) | Student AI guidelines by grade band, published at <https://educateos.io/pilot/students/>. | Teachers, students |
| [staff-ai-guidance.md](staff-ai-guidance.md) | Staff AI use guidance, published at <https://educateos.io/pilot/staff-ai-guidance/>. | All staff |

## Keeping things consistent

- **program.md and the public page say the same thing.** Change both in the same pull request.
  The page is a summary, not a contract: the signed pilot agreement and the DPA govern.
- **Status claims come from [maturity.md](../maturity.md).** Never write "compliant" or
  "certified", and say "built", "harness-tested" or "planned" as the maturity record does.
- **Install prerequisites come from [the district install runbook](../runbooks/district-install.md)**
  and [installer-permissions.md](../installer-permissions.md). If the installer's preflight
  changes, update the readiness checklist.
- **The end of a pilot follows [the offboarding runbook](../runbooks/district-offboarding.md).**
- **Costs come from [cost-to-run.md](../cost-to-run.md)** and the public
  [/pricing/](https://educateos.io/pricing/) page; do not quote other figures.
- **The advisory council seat** is described on [/advisory/](https://educateos.io/advisory/): the
  councils are being explored, not yet formed. Keep the wording consistent with that page.

## Not done yet (owner actions, outside the repo)

- Someone assigned to answer hello@educateos.io during pilots.
- A booking link for the 20-minute IT walkthrough. Until it exists, the page says "email us to book".
- Counsel review of the DPA template and the Privacy Policy (SCHO-229), then the SDPC National DPA
  and the Texas and Michigan state DPAs.
- The pilot agreement itself. This directory is not one.
