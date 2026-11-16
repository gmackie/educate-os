# Student AI use guidelines, by grade band

- Status: Template for founding pilot schools. Post or hand out the band that fits the class.
- Issue: SCHO-399 (pilot: SCHO-366)
- Web copy: `sites/educateos-io/public/pilot/students/index.html` (educateos.io/pilot/students/).
  Each band prints as one classroom poster.
- Change this file and the web copy in the same pull request.

## Notes for teachers (not part of the posters)

- **In the first phase of the founding pilot, students don't use EducateOS AI.** These guidelines
  are for when the district turns student AI on, and for any other AI tool students meet. Teach them
  before students use AI, not after.
- **What the posters rely on, and why:**
  - *AI can be wrong.* Models make things up. The tutors' prompts tell the model to give hints, but
    that is an instruction, not a guarantee (`packages/bundled-blueprints/libraries/tutor/README.md`).
  - *Don't share personal information.* The tutors never ask for any, and a message that looks like
    an email address, phone number or street address is neither sent to the model nor kept. Other
    personal details (a full name, a school, a health matter) are not caught that way, so the rule
    stays.
  - *Your teacher may be able to see your AI chats.* A tutor gadget keeps one conversation, and a
    learner can export it as a file for the teacher. A tutor a teacher shares with the class is
    therefore not private from the teacher. EducateOS's policy keeps a student's *personal*
    conversations private from teachers under both default policy profiles
    (`packages/educateos-config/src/document.ts`), but students should not have to work out which
    is which, so the posters say "your teacher may see them". Families don't see AI conversations
    through EducateOS ([ADR-0012](../adr/0012-guardians-and-dated-roles.md)).
  - *If AI won't answer.* For students, Hall Monitor screens every message and every reply. A
    blocked message gets a neutral reply; a message that suggests someone needs help gets a short
    message pointing to a trusted adult. The AI never tells anyone, so the posters tell students to
    tell an adult (`packages/educateos-ai-guard/README.md`, "Decisions").
  - *Pictures.* Hall Monitor screens text only, so a student's message with an image is refused.
- Adjust the "cite" rule to your class's citation practice. Keep the language at the band's reading
  level.

---

## Grades K–2: Using AI helpers

1. **Ask a grown-up first.** Use an AI helper only when your teacher says it's time.
2. **Keep secrets safe.** Never tell the AI your full name, where you live, your phone number or your
   passwords.
3. **AI can make mistakes.** If something sounds wrong or strange, ask your teacher.
4. **Your teacher may see your chats.** Write only what you'd be happy for your teacher to read.
5. **Feeling worried or sad? Tell a grown-up.** The AI can't help you the way a person can.
6. **Be kind.** Type to the AI the way you'd talk to a classmate.
7. **Tell the truth.** If the AI helped you, say so.

## Grades 3–5: Using AI helpers

1. **Use AI when your teacher says you can,** and only for what they said.
2. **AI gives hints, you do the thinking.** The tutor helps you find the next step. The answer is
   yours to work out.
3. **Check it.** AI can sound sure and still be wrong. Check facts in your book, a trusted website or
   with your teacher.
4. **Keep personal information private.** Don't share your full name, address, phone number,
   birthday, passwords, or private things about you, your family or your friends.
5. **Your teacher may see your AI chats.** Don't write anything you wouldn't want your teacher to read.
6. **Be honest.** Tell your teacher when you used AI and what it helped with.
7. **If the AI won't answer, that's on purpose.** Some questions are stopped for safety. If something
   is bothering you, talk to a trusted adult. The AI can't get help for you.
8. **Stuck or unsure? Ask your teacher.**

## Grades 6–8: Using AI for learning

1. **Follow your teacher's rules for each assignment.** Some work allows AI, some doesn't. When in
   doubt, ask before you use it.
2. **Your work is your own.** Use AI to brainstorm, get hints or check your understanding, not to
   produce work you hand in as yours.
3. **Say when you used AI.** Note what you asked it and how it helped, the way you'd cite a source.
4. **Verify everything.** AI can invent facts, quotes and sources. Check important claims against a
   reliable source before you use them.
5. **Protect personal information,** yours and other people's: no full names, addresses, phone
   numbers, passwords, photos or private details.
6. **Your teacher may see your AI chats.** Treat them like schoolwork, not a diary.
7. **Blocked messages are part of the safety system.** If something worries you or a friend, tell a
   trusted adult. The AI won't tell anyone.
8. **Be respectful.** Don't try to trick the AI into breaking school rules.

## Grades 9–12: Using AI responsibly

1. **Know the rules for each assignment.** Your teacher decides whether and how AI may be used. If
   it isn't stated, ask.
2. **Do your own thinking.** Use AI to explore ideas, get feedback, practice or find where you're
   stuck. Don't submit AI-generated work as your own.
3. **Disclose and cite.** Say which AI tool you used, what you asked and what you kept. Cite the
   original sources, not the AI.
4. **Verify.** AI output can be wrong, out of date, biased or made up, including citations. You're
   responsible for what you submit.
5. **Protect privacy.** Don't enter personal information about yourself or anyone else: names,
   contact details, IDs, passwords, health or family matters, photos.
6. **Assume your teacher can read your AI chats.** Write accordingly.
7. **Understand the safety checks.** Messages and replies are screened, and some are stopped. If you
   or someone you know needs help, talk to a trusted adult or counselor. AI is not a substitute.
8. **Use it fairly.** Don't use AI to harass, impersonate or deceive anyone, or to get around school
   rules.
