# Objections and honest answers

- Status: Living document. Update an answer in the PR that changes its evidence.
- Date: 2026-11-14
- Issue: SCHO-405 (related: SCHO-366, the founding pilot)

These are the questions district and school staff are most likely to ask, with answers you can
say out loud. Every claim follows [maturity.md](../maturity.md) and the statuses on educateos.io.
Two rules apply to all of them:

- **Say what is built, what is tested and what is planned, in those words.** If you don't know,
  say so and follow up in writing.
- **Never say "compliant" or "certified".** EducateOS is designed to support a district's FERPA,
  COPPA and state student-privacy obligations. No certification or third-party audit is claimed,
  including 1EdTech certification.

Each answer starts with the short version, then the detail and where to point them.

## "We already have Canvas" (or Schoology, Moodle, Google Classroom)

**Short:** Keep it. The pilot doesn't replace your LMS. It gives a few teachers governed AI tools
beside it.

- EducateOS is an LTI 1.3 tool with Deep Linking, grade passback and roster services. It passed
  live runs against current Canvas and Moodle 4.5 (Supported on educateos.io; no 1EdTech
  certification is claimed). Grades go back to the LMS only after a teacher approves them.
- Google Classroom: coursework and a teacher-approved grade ran live on one course, with one teacher
  and one student. The rest of the sync is tested against a fake of the Classroom API. Say "tested,
  and proven live on a single course", not "supported".
- Schoology: there is no live run against Schoology. Don't claim it.
- A teachers-first pilot doesn't need an LMS integration at all. Teachers use the AI workspace in
  their own planning.
- Point them to: [educateos.io/integrations](https://educateos.io/integrations/).

## "We already have Google" (Gemini, Workspace for Education)

**Short:** Google's tools are good at general writing help. EducateOS adds district rules on every
AI call, a spending cap, and course agents and classroom apps that run in your own account.

- Every model call goes through the AI call guard in the district's account: district policy,
  Hall Monitor screening and spending caps. The guard is deployed on the demo districts; budgets and
  screening are In development (built and tested, not yet run for a district).
- Google sign-in works today: the live demo district uses it through Cloudflare Access.
- An agent reaches Google Drive, Gmail or Calendar only through a gatekeeper, and anything it
  writes waits for the teacher's approval (part of Cloudflare OS today).
- Don't argue that Gemini is unsafe. Say what EducateOS does differently and let them decide.

## "Is AI safe for our students?"

**Short:** In the pilot, students don't use AI at all. Teachers do, in their own planning.

- Student-facing AI stays off for the whole founding pilot.
- The grade-band tutors (Reading Buddy, Homework Helper, Study Coach, Research and Essay Coach) are
  a pilot preview that has run with synthetic students only.
- When a district does turn on student AI later: Hall Monitor screens each message before the
  model sees it, screening is paid from a protected safety reserve, and the district can switch
  student AI off entirely. These are In development.
- Before any teacher signs in, we confirm in writing which AI controls are on in the district's
  install. Don't promise a control that isn't confirmed for that install.
- Grades and messages an agent drafts stay drafts until a teacher approves them.
- Point them to: [educateos.io/security](https://educateos.io/security/),
  [educateos.io/pilot/staff-ai-guidance](https://educateos.io/pilot/staff-ai-guidance/).

## "What happens to our student data?"

**Short:** It stays in your Cloudflare account. We don't receive it. And in the pilot there is no
student data until you sign a data processing agreement.

- EducateOS is installed in the district's own Cloudflare account, under the district's
  credentials and policies. Gmacko Ventures LLC, which develops it, does not receive, store or
  process student records unless the district asks in writing for hands-on support.
- The pilot's data rule: synthetic or staff-only data until a DPA is signed. No student names,
  records, grades or work, and no real roster.
- The [DPA template](https://educateos.io/student-privacy/dpa/) is a draft pending counsel review.
  If the state uses a standard student data privacy agreement (Texas and Michigan districts often
  do, through their state consortia), ask them to send it.
- No advertising, no sale of data, and automated profiling is prohibited.
- AI model calls go to the model provider the district chooses, on the district's own account with
  that provider. Be specific about this if asked: we don't proxy them.
- Point them to: [educateos.io/student-privacy](https://educateos.io/student-privacy/).

## "Who supports it?"

**Short:** In the pilot, we do: a named pilot lead and a named technical contact, with a reply
within one business day.

- Email hello@educateos.io with "Pilot" and the district's name in the subject. Our support target
  is a reply within one business day. It is a pilot commitment, not a service-level agreement; the
  pilot agreement says what we commit to.
- A 20-minute check-in each week, and a shared issue log.
- Safety or data concerns come first ("Safety" in the subject). The IT lead can stop all access at
  once by changing the Access policy in the district's account, without us.
- After the pilot, support from educateos.io is an optional paid service whose prices are not set.
  Say that plainly. Pilot districts hear prices before anything is charged.
- We are a small team. Don't imply a support desk we don't have.

## "What if you disappear?"

**Short:** It keeps running. It's in your account, the code is open source, and you can export
everything.

- Apache-2.0: the district has the code and the right to run, change and hire anyone to maintain it.
- educateos.io is optional. A district can install, update and run EducateOS with educateos.io
  offline. It holds no standing credentials for the district's account.
- District export: a district administrator downloads the whole district as one ZIP of open JSON
  records and files. Harness-tested against a seeded district; not yet run in a live one.
  Teachers' Workshop gadgets and agents are not in the export yet.
- Uninstall (`npx launch-educate-os uninstall`, in the installer's next release) shows exactly what
  it will delete and deletes nothing until the district types its install ID. Tested against a
  simulated Cloudflare account, not a live one.

## "What does it cost?"

**Short:** The software is free. The district pays Cloudflare directly, and for a teachers-first
pilot that is the $5 Workers Paid plan plus small usage.

- Projected running cost at Cloudflare list prices: about $8.09 a month at 500 students and $37.29
  at 2,500, the $5 base included. From measured usage on the demo districts with assumed activity;
  not a quote. Method: [educateos.io/pricing](https://educateos.io/pricing/).
- Cloudflare Access sign-in seats are a separate line. Up to 50 people fit Zero Trust Free, which
  covers a teachers-first pilot. Past that, list price is $7 per person per month, and many
  districts already have a Zero Trust plan. A sign-in that takes no seat per student is planned and
  must ship before any pilot opens EducateOS to all its students. Don't hide this.
- AI usage is billed by the model provider, up to the cap the district sets.
- No district has run EducateOS at 10,000 students or more. The large-district rows on the pricing
  page are projections of the current design, not a promise that it scales.
- Optional educateos.io services after the pilot (guided install, managed updates, a managed
  address, the marketplace) are not priced yet.

## "Is it accessible?"

**Short:** We published an accessibility conformance report against WCAG 2.1 AA. It says
"partially conforms", and lists what is open.

- 40 criteria supported, 2 partially supported, none unsupported, 8 not applicable, from an
  automated and keyboard audit of 143 demo screens in light and dark themes and at 320px wide.
- Screen-reader testing hasn't been done yet. Say so before they find it.
- The report is laid out like a VPAT. Don't call it a VPAT certification or say "ADA compliant".
- Point them to: [educateos.io/it/accessibility](https://educateos.io/it/accessibility/).

## "Our IT team doesn't have the capacity"

**Short:** A few hours before kickoff, and we run the install with you on a call.

- What IT needs: a Cloudflare account the district owns on Workers Paid, a domain as an active
  zone, Cloudflare Zero Trust with the district's identity provider, and an API token with the 13
  permissions the install guide lists. The token stays on the IT lead's machine; deleting it ends
  the installer's access.
- With the domain and identity provider already on Cloudflare, the install itself takes under an
  hour. The readiness weeks depend most on those two.
- No rostering needed for a teachers-first pilot.
- Be honest: no district has run the installer in its own account yet. The installer has installed
  EducateOS end to end into the project's own account. Pilot districts will be the first, and we
  will be on the call.
- Point them to: [educateos.io/it](https://educateos.io/it/), and the install guide at
  [educateos.io/it/install](https://educateos.io/it/install/).

## Other questions you may get

- **"Who else is using it?"** Nobody in production. No real students use EducateOS, and there are
  no district references yet. The founding pilot districts will be the first, and we never name a
  district publicly without its written approval.
- **"Are you affiliated with Cloudflare?"** No. EducateOS is an independent project built on the
  open-source Cloudflare OS, and is not affiliated with or endorsed by Cloudflare, Inc.
- **"Can we try it without committing?"** Yes: [educateos.io/demo](https://educateos.io/demo/) runs
  in the browser with fictional districts and no sign-up. It has no real AI.
- **"Why Texas and Michigan?"** This first round is small on purpose: three to five districts in two
  states. Districts elsewhere are welcome to write to us about later rounds.
