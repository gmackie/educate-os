# Family letter template (English)

- Status: Template for founding pilot schools. Edit freely for your school; keep the facts true.
- Issue: SCHO-399 (pilot: SCHO-366)
- Web copy: `sites/educateos-io/public/pilot/families/index.html` (educateos.io/pilot/families/),
  printable from the browser. Spanish: [family-letter.es.md](family-letter.es.md).
- Change this file and the web copy in the same pull request.

## Notes for the pilot lead (don't send this part)

- Replace every `[bracketed field]`. Delete the optional paragraph marked **Student AI** unless
  students will use EducateOS AI tools during the pilot. If student use starts later, send the
  letter again with that paragraph, before students start.
- Every statement about EducateOS below rests on the project's own documents:
  [ADR-0001](../adr/0001-district-data-ownership.md) (the district holds the data),
  [ADR-0015](../adr/0015-us-data-jurisdiction.md) (new installs keep stored records in Cloudflare's US
  jurisdiction), the [security questionnaire](../security-questionnaire.md) sections 2, 7 and 9,
  `packages/educateos-ai-guard/README.md` (screening), `packages/bundled-blueprints/libraries/tutor/`
  (a tutor gadget keeps one conversation, which its owner and anyone it is shared with can open, so
  the letter tells families a teacher may read class tutor chats), [ADR-0012](../adr/0012-guardians-and-dated-roles.md)
  (guardians never read conversations) and the
  [student privacy page](../../../sites/educateos-io/public/student-privacy/index.html). If you add a
  claim, check it the same way. Don't add words like "compliant" or "certified", and don't promise
  a legal outcome.
- The letter says the school, not the vendor, answers questions. Make sure the contact you name can
  answer them, and knows how to reach the district's EducateOS administrator.

---

[Date]

Dear families of [School],

This [term/semester], [School] is one of a small number of schools taking part in a pilot of
**EducateOS**, a set of classroom tools that includes artificial intelligence (AI). The pilot runs
from **[start date]** to **[end date]**, about ten weeks, with a few teachers:
[teacher names or "a few of our teachers"]. We want to tell you what that means for your child and
how to ask us anything about it.

### What the pilot is

EducateOS is open-source software. [District] installs and runs it in [District]'s own Cloudflare
account (Cloudflare is the cloud provider it runs on). It is developed by Gmacko Ventures LLC, which
does not receive student information from it. During the pilot, a few teachers will try its AI tools
for their own work, such as planning lessons, drafting materials and building small classroom
activities, and tell us whether they help.

### In this first phase, students do not use AI

In the first phase of the pilot, **only teachers and staff use the AI tools. Students do not use
EducateOS AI at all**, and student AI is switched off. Your child's classes continue as usual.

### What information is used, and where it is kept

- **Until [District] signs a data processing agreement, no real student information goes into
  EducateOS.** Teachers use it with made-up (synthetic) examples, or with their own teaching
  materials. A data processing agreement is a contract that sets out how student information may be
  used and protected. [Status of the agreement, for example "We have not signed one yet; we will
  write to you before that changes."]
- **The district holds the information, not the company.** Everything EducateOS stores is kept in
  [District]'s own Cloudflare account, which the district controls. EducateOS sets up new
  installations so that stored records stay in Cloudflare's United States jurisdiction.
- **No advertising, no selling of information, no profiling.** EducateOS contains no advertising.
  Gmacko Ventures LLC does not sell student information and has none to sell. EducateOS's settings
  prohibit automated social-emotional profiling of students, and no school setting can turn it on.
- **AI models.** [District] chooses which AI models EducateOS uses, either Cloudflare's own AI
  service in the district's account or another provider under the district's own agreement.
  [Name the model provider(s) the district has chosen.] Cloudflare states that it does not use what
  is sent to its AI service to train models.

### How AI requests are checked

Before an AI model sees a message, EducateOS sends it to a safety check called **Hall Monitor**,
which also runs in the district's own account. A message that isn't appropriate for school is
stopped before it reaches the AI. If a message suggests someone may need help, the AI does not
answer it and instead shows a short message pointing to a trusted adult. EducateOS records the
check's decision, not the words of the message. No safety check is perfect, and these checks have not
yet been used with real students, which is one reason the pilot starts with teachers.

> **Optional paragraph, Student AI.** Include only when students will use EducateOS AI.
>
> **Starting [date], some students may use AI tools.** From [date], students in
> [classes or grade levels] may use EducateOS AI tutors that give hints rather than answers, in
> [subjects]. For students, every message *and* every AI reply is checked before it is shown, and
> if the check isn't working, the AI doesn't answer. AI use has a spending limit per student, and the
> district can switch student AI off at any time. Your child's teacher may be able to read your
> child's conversations with an AI tutor used in class, and we tell students to assume so. Families
> don't see AI conversations through EducateOS. The AI can't get help for a child, so we teach
> students to tell a trusted adult if anything worries them.
> We will share the classroom guidelines your child will learn: be honest about using AI, check what
> it says, never share personal information with it, and ask a teacher when unsure.
> **You can opt your child out of student AI** (see below). Students who opt out will do the same
> work without AI, and it will not affect their grades.

### Your questions and choices

- **Ask anything.** Contact [Pilot lead name], [role], at [email] or [phone]. You can also ask
  [principal name] at [contact].
- **See what is held.** You can ask us what information about your child, if any, is in EducateOS.
  The district's administrators can export what EducateOS holds and tell you.
- **Opt out of student AI.** Tell [Pilot lead name] by [date or "at any time"]. EducateOS has no
  per-student opt-out switch yet. Instead, a student can use the AI tools only after the school
  connects that student's account to them, so we will simply not connect your child's account.
  [In the first phase no student accounts are connected.]
- **Learn more.** EducateOS publishes how it handles student information at
  educateos.io/student-privacy/ and the student guidelines we will use at educateos.io/pilot/students/.

Thank you. We will tell you what we learn from the pilot.

Sincerely,

[Name]
[Title], [School]
[Contact]
