# Staff AI use guidance for pilot schools

- Status: Template for founding pilot schools. The district's own AI and data policies come first;
  where they say more, follow them.
- Issue: SCHO-399 (pilot: SCHO-366)
- Web copy: `sites/educateos-io/public/pilot/staff-ai-guidance/index.html`
  (educateos.io/pilot/staff-ai-guidance/), printable.
- Change this file and the web copy in the same pull request.

Status labels follow the site: **In place** means true in the code today; **Built, not proven** means
it exists and is tested but has not run in a real district; **Planned** means it does not exist yet.
No real district has run EducateOS yet, so nothing here has been proven with real students.

## 1. During the pilot, before a DPA: no real student data

Until the district has signed a data processing agreement (DPA) covering EducateOS, **put no real
student information into EducateOS or any AI tool it connects to**. That includes names, initials
with class details, ID numbers, grades, work samples, IEP or 504 details, behavior notes, health
information, photos and anything a student wrote.

Use instead:

- the synthetic people and classes the pilot provides, or ones you invent ("Student A, grade 4,
  reading below grade level");
- your own materials: lesson plans, curriculum guides, rubrics, open course content;
- information about yourself you are comfortable sharing.

If real student data goes in by mistake, tell the pilot lead the same day. The district administers
the account and can help remove it. Don't just delete it yourself: the pilot lead needs to know
where it went.

After a DPA is signed, the district's policy decides what student information may be used, and
EducateOS's policy settings can only be made stricter below the district level (a school, class or
activity can't loosen what the district set). *Built, not proven.*

## 2. Good uses

- Planning lessons and units, and adapting them for different reading levels or languages.
- Drafting materials: question sets, exemplars, rubrics, instructions, family messages (review
  before sending).
- Building small classroom gadgets (a simulation, flashcards, a lab plotter) by asking an agent.
  Each runs in its own sandbox. *In place (Cloudflare OS).*
- Summarizing or reorganizing your own documents, and connecting an agent to the resources you
  choose, such as a Drive folder or the district's curriculum guide. An agent reads only what you
  connect. *In place (Cloudflare OS).*
- Drafting feedback against a rubric, for you to edit. *AI-drafted feedback in Teacher Studio is
  Planned; drafting in a Workshop chat works today.*

## 3. Not for AI

- Real student data before a DPA (section 1), and after one, anything the district's policy rules out.
- Decisions about a student: grades, placement, discipline, special education eligibility,
  safeguarding. AI may help you draft; a person decides. In EducateOS an official grade is written
  only when a teacher records or approves it, and a grade an agent drafts waits for your approval.
  *Built, not proven.*
- Passwords, credentials and other staff members' personal information.
- Judging whether a student used AI. AI-detection tools are unreliable; talk with the student.
- Profiling students' emotions or behavior. EducateOS's policy prohibits automated
  social-emotional profiling, and no setting can turn it on. *Built, not proven.*

## 4. Review everything AI produces

- **Check facts, quotes, citations and math.** Models invent plausible things.
- **Check level and tone** for your students, and for bias or stereotypes.
- **Check accessibility** (section 8).
- **Agents' writes wait for you.** Emails, calendar events and documents an agent prepares wait in
  your approval queue. Read each one before you approve it. *In place (Cloudflare OS).*
- **Nothing reaches students until you publish or approve it** in Teacher Studio. *Built, not proven.*

## 5. How screening works, and what to do when a message is stopped

Every AI request in EducateOS passes the **AI call guard**, which runs in the district's account.
*Built, not proven; deployed on the demo instance.*

- **Your own messages** are sent to **Hall Monitor**, the district's screening service, before the
  model sees them, under the educator profile. Replies to staff are screened only if the
  district's settings require it.
- **Students' messages and the replies to them** are both screened, at the student's grade band.
  If screening is unavailable, a student's request is refused (it "fails closed").
- **Gadgets are screened as if a student were typing**, because a student may be using them: at the
  grade band the gadget declares, or K–2 if it declares none. So when you test a gadget, you may see
  stricter screening than in your own chats. That is expected.
- **What you see when a message is stopped:** a neutral "can't help with that" message (Hall
  Monitor's *hold* or *block*), or a short supportive message pointing to a trusted adult (*support*).
  A message with a picture is refused for students, because screening reads text only.
- **What is recorded:** the decision, its reason codes and IDs, in the district's own account. The
  guard never logs or stores the message text. *Built, not proven.*
- **What does not happen:** EducateOS does not alert anyone when a message is stopped. There is no
  safeguarding referral route in EducateOS. *Planned, gated on privacy review.* Hall Monitor's
  thresholds have not yet been calibrated on human-labelled data, so expect some wrong stops and
  some misses.

**What to do:**

- *Your message was stopped and you think it shouldn't have been:* rephrase it plainly. Don't try to
  get around the check. Tell the pilot lead what kind of request it was and when, so the team can
  tune the settings.
- *A student tells you the AI stopped them, or showed the "talk to a trusted adult" message:* follow
  your school's existing safeguarding and counseling procedures, exactly as if the student had told
  you directly. Don't rely on EducateOS to notice or report anything.
- *The AI produced something harmful or inappropriate:* stop using that gadget or chat, note when
  it happened, and tell the pilot lead.

## 6. Academic integrity

- Tell students, for each assignment, whether AI is allowed and how (none, hints only, full help).
  EducateOS's activity setting for AI help has the same three levels, and the conservative default
  profile allows hints only. *Built, not proven.*
- The bundled tutors give hints, not answers, and ask what the student tried. That is an instruction
  to the model, not a guarantee, so screening also nudges the model back toward hints when a
  student's message looks like an attempt to get graded work done for them. *Built, not proven.*
- Ask students to disclose AI use (see the [student guidelines](student-ai-guidelines.md)), and
  design tasks where the process shows: drafts, conversations, oral explanation.
- Treat a suspicion of AI misuse as a conversation, not a verdict.

## 7. Students' AI conversations

- A student's *personal* AI conversations are private from teachers, classmates and families under
  both default policy profiles. *Built, not proven: checked at the policy engine, not yet over the
  app's API (SCHO-107).*
- A tutor gadget keeps one conversation. If you share one tutor with the class, you and everyone
  you shared it with may see it. Prefer giving each student their own copy, and tell students their
  teacher may see their tutor chats (the student guidelines already say so).
- A student can export a tutor conversation as a file to hand to you.
- Families don't see AI conversations through EducateOS. *Built, not proven.*

## 8. Accessibility

- AI-generated materials need the same accessibility as anything else: headings, alt text for
  images, sufficient contrast, captions or transcripts, and a reading level that fits.
- Tutors can read their replies aloud using the browser's own speech, which never leaves the device.
  K–2 activities can read every instruction aloud and take spoken and drawn answers. *Built, not
  proven.*
- The accessibility audit of EducateOS's student, teacher and admin screens has not been done yet
  (pilot gate, SCHO-22, SCHO-23, SCHO-24). If a student can't use something with a keyboard or
  screen reader, tell the pilot lead and use another route for that student.
- Don't make AI the only way to do an assignment: some students and families will opt out.

## 9. Who to contact

- Questions about this guidance or the pilot: [Pilot lead name], [contact].
- A safeguarding concern: your school's designated safeguarding lead, as always.
- Data put in by mistake, or a family's request to see or remove data: [Pilot lead name], who
  reaches the district's EducateOS administrator.
- The EducateOS team: hello@educateos.io. Don't include student information.
