# Teacher quickstart (founding pilot)

- Issue: SCHO-398. Pilot: SCHO-366.
- Published as <https://educateos.io/pilot/teachers/> from
  `sites/educateos-io/public/pilot/teachers/index.html`. This file is the editable source: change
  both together.
- Checked against Teacher Studio (`packages/educateos-teacher-ui`), the district shell
  (`packages/educateos-shell/src/navigation.ts`), the AI workspace's school home
  (`packages/workshop-frontend/src/pages/home/schoolHomeContent.ts`) and the AI call guard's default
  messages (`packages/educateos-ai-guard/src/config.ts`) on 2026-11-14. Tasks 2 to 5 were also done
  in the public demo (`educateos.io/demo`, Northfield, as Mr. Rivera). See "How each step was checked"
  at the end.

For teachers in an EducateOS founding pilot: one school in your district, a few teachers, about ten
weeks. One task per page, so you can print the pages you need.

**The pilot's one rule about data.** Until your district signs a data processing agreement with
EducateOS, use only made-up (synthetic) students and staff accounts. Don't enter real student names,
work or grades, and don't paste them into the AI workspace. Your pilot lead will tell you when that
changes.

**Practice any time** at <https://educateos.io/demo/>. It needs no sign-in, runs in your browser,
and uses a fictional district. Choose a teacher in the picker: Daniel Yazzie (grade 1),
Fatima Al-Sayed (grade 4), Tomás Ortega (World History 7) or Sam Rivera (English 9). Reloading the
page starts the demo over.

## 1. Sign in

1. Open your district's EducateOS address. Your pilot lead gives it to you. It is your district's own
   web address, such as `yourdistrict.educateos.io` or a district domain.
2. Sign in the way your district set up, usually your school Google or Microsoft account, or a
   one-time code sent to your school email.
3. As a teacher you land in **Teacher Studio**. The page says "Opening Teacher Studio" first.

If you see **"You're signed in, but you haven't been added to this school yet"**, your sign-in worked
but your account isn't linked to the school's records. Choose **Copy your sign-in ID**, send it to
your pilot lead or school administrator, and reload the page once they've added you.

The menu on the left:

| Entry | What it opens |
|---|---|
| Today, Classes | Your class list (My classes) |
| Gradebook | Your class list. Pick a class, then its Gradebook tab |
| Calendar, Inbox | Due dates and notifications |
| AI workspace | The AI tools, at `/ai` on the same address. Shown only if your district has turned AI on |
| Content studio | Your class list. Pick a class, then its Resources tab |

**Sign out** is in the account menu, next to your name.

## 2. Your classes

**My classes** lists each class you teach, with how many students are enrolled. A co-teacher's
classes show a **Co-teacher** badge. If you see "No classes yet", your district hasn't added you to
a class: tell your pilot lead.

Open a class. Its tabs, in order: **Roster**, **Modules**, **Resources**, **Create activity**,
**Submissions**, **Gradebook**, **Announcements**, **Discussions**, **Quizzes**.

- **Roster**: each student, whether they're enrolled, and how many activities they've turned in.
  Your district's roster decides who is in a class; you can't add students yourself.
- **Modules**: the units of the course. **Add a course** brings in a course from your district's
  course library as drafts you can edit. Teacher guides and answer keys arrive as teacher-only notes,
  which students never see.

## 3. Post an assignment

In a class, open **Create activity**.

1. **Template**: Writing task, Science investigation, Primary-source analysis, Problem set, or, for
   K-2, Picture response and Read and respond.
2. **About the activity**: a **Title** and an **Overview for students**, then the template's own
   fields (a writing task has a **Prompt**, **Kind of writing**, **Minimum length in words** and
   **Sources to cite**).
3. Optional: **Learning goals** (standards), **Resources** your class already has, and notes.
4. **AI help**: **None**, **Hints only** or **Full**. Your district may allow less. If it does,
   you're told when you preview.
5. **Rubric**: **No rubric**, a rubric from an earlier activity in this class, or a new one
   (**Rubric title**, **Criteria** one per line, **Save and use this rubric**).
6. Choose **Preview as student**. You see the activity as a student will, and how it is assessed.
7. Under **Publish and assign**, set a **Due date** (leave it empty for the end of the term) and
   choose **Publish and assign**. **Back to editing** returns to the form.

Once published, students in the class can open it. Later changes make a new version and don't change
what students already have. Their work appears under **Submissions**.

## 4. Build a quiz, set a time limit and give a student extended time

In a class, open **Quizzes**.

1. Type a **Quiz title** and choose **Create quiz**.
2. Under **Settings**: **Attempts allowed**, **Time limit in minutes (optional)**, **Opens** and
   **Closes** (optional), whether each student sees the questions or choices in their own order,
   when students see the correct answers (**After you release scores**, **As soon as they submit**,
   **Never**) and **Which attempt counts** (best or latest).
3. Add questions: **Add multiple choice**, **Add multiple select**, **Add true or false**,
   **Add number**, **Add short answer** or **Add essay**. Each has its points and its correct answer.
4. **Release scores as grades for**: leave "A new gradebook assignment for this quiz, made when you
   publish it", or pick an existing assignment. Optionally **Place it in a module**.
5. Choose **Save quiz**, then **Publish**. **Unpublish** makes it a draft again. Once students have
   started, the questions are locked so every attempt is scored against the same key; settings can
   still change.

**Extended time** is at the bottom of the quiz page. Choose the **Student**, then the **Time**:
1.25×, 1.5×, 2×, 3×, 4× or **No time limit**. With a 20-minute limit, 1.5× shows as "1.5× time
(30 minutes)". Choose **Give extended time**. Each student with extended time is listed, with
**Remove … extended time** beside them.

- Use the amount the student's IEP or 504 plan sets.
- Only the class's teachers and district administrators see this list. Each student sees only their
  own time.
- An attempt already in progress gets the extra time at once.
- Extended time does nothing until the quiz has a time limit.

Afterwards, **Results and grading** shows each student's score and anything marked **Needs grading**
(short answer and essay). **Release scores** sends them to the gradebook as official grades.

## 5. Gradebook basics

In a class, open **Gradebook**.

- It shows **official grades only**: a grade you approved, or quiz scores you released. A draft score
  or suggestion never appears here.
- Choose a cell (or move to it with the arrow keys and press Enter) to mark it **Excused**,
  **Missing** or **Late**. Marks change how totals add up; they never change a grade.
- **Gradebook settings**: add all scores together or **Weighted by group**, combine by points or
  percent, count missing work as zero, assignment groups with a **Weight (%)** and **Drop lowest**,
  and the letter-grade scale.
- **Export CSV** downloads the gradebook.

To grade written work: **Submissions**, pick the activity, then **Review [student]'s work**. Choose a
level for each rubric criterion and **Save score**, add comments, then **Approve official grade**.
**Share feedback with student** is a separate choice: the student sees your comments and scores only
after you share them.

## 6. Your AI tools

The pilot starts with AI for teachers. Your district decides whether it is on. If it is, **AI
workspace** appears in the menu and opens at `/ai` on your district's address.

**What they do**

- The AI workspace's home, **Teaching companion**, has a **Start a conversation** box and four
  starters: **Plan a lesson**, **Create practice questions**, **Adapt an activity** and **Draft a
  family update**. Each asks you questions first, then drafts something for you to review.
- On a student's work page, **Ask AI about this** opens the AI workspace about that submission. It
  appears only where your district has AI.
- Teacher starter blueprints, **in development**: Week Ahead (reads one Google Calendar), Research
  Kit (web search results with their sources) and Assignment Companion (coursework from one Google
  Classroom course). They are read-only, keep your preparation notes, and make no AI calls. Use them
  only if your pilot lead says your district has added them.

**What they don't do**

- They don't grade. Suggested scores count only when you save them as your own and approve the grade.
- They don't send anything to students or families. A draft reaches them only if you put it into
  Teacher Studio and publish it. Anything an agent would write elsewhere, such as an email, waits for
  your approval.
- They can be wrong. Check facts, dates and sources before you use a draft.
- Don't paste student information into a prompt during the pilot.

**Your district sets the policy**

Your district chooses whether AI is on, which models, and how much each person may spend each month.
A class can be stricter than the district, never looser. **AI help** on an activity is how you choose
for students.

**Requests are screened**

Every AI request goes through the AI call guard in your district's own Cloudflare account before it
reaches a model. Where your district's settings call for it, Hall Monitor, the screening service,
checks the message first, and can check the reply before you see it.

If something is flagged, you get a short message in the conversation instead of a reply. It never
says why and never quotes you. The default wording (written for students, and your district can
change it):

| What happened | What you see |
|---|---|
| Your message was flagged | "This message can't be sent to the AI assistant. Try rephrasing it, or ask your teacher for help." |
| The reply was flagged | "The AI assistant's reply can't be shown. Try asking in a different way, or ask your teacher for help." |
| It reads as someone in distress | A supportive message pointing to a counselor or another trusted adult |
| Screening can't run right now | "The AI assistant isn't available right now. You can keep working without it, or ask your teacher." (Your district can let staff requests go ahead unscreened while screening is down.) |
| The monthly AI budget is used up | "The AI budget for this work has been used up. You can keep working without the assistant." |
| Your account isn't linked yet | "Your account isn't linked to your school's records yet, so the AI assistant is off. Ask your school's administrator to link it." |

Nothing else happens to you: no alert, no strike. Rephrase or carry on without the AI. If a message
was stopped that shouldn't have been, tell your pilot lead what you were trying to do. Don't resend
the text in an email. The district keeps no per-message record of these checks; administrators see AI
spend.

## 7. Where your data goes

- EducateOS runs in your district's own Cloudflare account. Classes, work and grades are stored
  there, and your district is their custodian.
- AI requests go from that account to the model your district chose, through the AI call guard. By
  default, prompts are kept out of the AI gateway's logs.
- EducateOS staff can't reach your district unless your district lets them, and everything they do
  is logged.
- No advertising, no sale of data.
- During the pilot: synthetic or staff-only data until the DPA is signed.

More: <https://educateos.io/student-privacy/>.

## 8. Getting help during the pilot

- **First, your school's pilot lead.** Write their name and contact on the printed page.
- **EducateOS:** hello@educateos.io. Say which district, which page (copy the address bar), what
  you did and what you expected. A screenshot helps; make sure it shows no student information.
- **Feedback:** <https://educateos.io/feedback/?source=teachers>.
- **Practice:** <https://educateos.io/demo/>.

## How each step was checked

| Step | Checked how |
|---|---|
| 1. Sign in | Code only: `educateos-student-ui/src/router.tsx` (staff go to `/teach/`), `educateos-teacher-ui/src/NotAddedYet.tsx`, shell navigation and account menu. The demo has no sign-in. |
| 2. Your classes | Demo: My classes, the class tabs and Roster as Mr. Rivera. Modules and Add a course from code and the demo's Mr. Yazzie journey. |
| 3. Post an assignment | Demo: created, previewed and published a writing task with an existing rubric. |
| 4. Quiz and extended time | Demo: created a quiz, set a 20-minute limit, added a true or false question, saved, gave Elena Sato 1.5× time (30 minutes), published. Results and grading from code. |
| 5. Gradebook | Demo: opened the gradebook (the new quiz and activity appeared as columns) and Elena Sato's submission review. Settings dialog labels from code. |
| 6. AI tools | Code only: the public demo has no AI workspace. School home, Ask AI about this, blueprint READMEs and the guard's default messages and behaviour. |
| 7. Data | The site's student privacy and IT pages. |
