# Investor walkthrough (5 to 7 minutes)

- Issue: SCHO-327. Rehearsed on <https://educateos.io/demo/> at 1280x800, 2026-11-02.
- Fallback video of this script: `investor-walkthrough.webm` (see the
  [presenter checklist](presenter-checklist.md#fallback-video)).

One story, kindergarten to the district office, on the in-browser demo. Open
`https://educateos.io/demo/?presenter` before the meeting (see the [checklist](presenter-checklist.md)).
Each beat below gives the click, what to point at, and what to say. Times are cumulative and
approximate; the bracketed beats can be cut to keep it to five minutes.

The three messages to land, in this order:

1. **The district owns it.** Open source (Apache-2.0), installed into the district's own Cloudflare
   account, no vendor holding student data.
2. **It works for a six-year-old and a sixteen-year-old.** One product across K-12, with the
   youngest learners answering by voice and drawing.
3. **AI is safe by construction.** Every tutor message is screened by Hall Monitor at the
   student's grade band, and teachers stay in charge of grades.

## 0:00 The picker

**Screen:** "Try EducateOS", Northfield selected.

- "This is EducateOS, a learning platform a school district owns outright. It's open source, and a
  district installs it into its own Cloudflare account. There's no vendor in the middle holding
  student data."
- "Northfield is a fictional district. Everything you'll see is the real product, and right now
  the whole district is running inside this browser tab. Nothing is sent anywhere."
- Scroll once: "A student and a teacher in every grade band, a parent, and the district office."

**Don't say** the demo is the hosted product. There is no hosted product: each district runs its own.

## 0:40 K-12 tour, step 1: Mateo, grade 1 (key `1`)

**Screen:** "Retell The Little Seed", Start page.

- "Mateo is in first grade. One step a screen, big type, and every instruction is read aloud."
  Click **Read to me** if the room has sound.
- Click **Ask Reading Buddy**, then **Read it again**. "His reading buddy is an AI tutor. Here it's
  a labelled simulation; on the live district it's real AI."
- Click **Tell me a scary story**. Point at the grey line under it: "Hall Monitor stopped that
  before it ever reached the AI, and the tutor steers him back to the story."
- Press `Escape`, then **Let's start**, **Next**. On Question 1 click **Record**, say a sentence,
  **Stop**, **Save my recording**. "No typing, no reading required."
- [**Next** twice to Question 3, draw a sprout, **Save my drawing**, **Finish**, **I'm done!**,
  **Yes, hand it in**.] "His teacher sees it now, and his family once the teacher shares feedback."

## 2:00 Step 2: Mr. Yazzie reviews (key `2` or →)

**Screen:** Retell The Little Seed in Submissions.

- Click **Review Priya Natarajan's work**. Play Question 1's recording, scroll to her drawing.
  "Recordings and drawings arrive as ordinary submitted work." (If you recorded Mateo in step 1 and
  handed it in, you can open his instead.)
- Scroll to the rubric: "A rubric written for six-year-olds: Not yet, Getting there, Got it!"
  Pick **Got it!** on both rows and **Save score** each.
- Type a comment, **Add comment**, then **Approve official grade** and confirm. "Scores become the
  official grade only when the teacher approves it. Nothing is graded behind their back."
- **Share feedback with student**: "Priya and her family see it at the same moment."

## 2:40 [Step 3: Mr. Yazzie's semester (key `3`)]

**Screen:** Mr. Yazzie's course, installed from an Open Course Specification package.

- "The whole semester arrived as one signed course package: units, activities, rubrics. Any district
  can install it, edit it, and publish their own."

## 3:00 Step 4: Abena, grade 4 (key `4`)

**Screen:** "Should Recess Be Longer?", scrolled to the tutor.

- "Grade 4: an opinion piece, instructions read aloud on request."
- **Ask Homework Helper**, **What's the first step?**: "Hints and sentence starters, never answers."
- **Just write it for me**: point at the Hall Monitor line. "Asking it to do the graded work is
  redirected, and every message shows what Hall Monitor decided."
- Type `my address is 12 Oak Street` and **Send**: "Personal details are neither sent to the AI nor
  kept."

## 3:45 Step 5: Chidi, grade 7 (key `5`)

**Screen:** "What Do Hammurabi's Laws Tell Us?", scrolled to **Grade and feedback** at the bottom.

- "A primary-source analysis: sourcing, context, a claim with evidence. His teacher's comment,
  rubric scores and official grade, released to him and his family."

## 4:05 Step 6: Mr. Ortega's gradebook (key `6`)

- Point at "Official grades only" and Chidi's 11/12. "The gradebook holds official grades only.
  Quizzes add theirs when released."

## 4:25 [Step 7: Amara, grade 9 (key `7`)]

- At **Grade and feedback**: "High school: an argument essay, rubric scores, the official
  grade. Her Research & Essay Coach won't write it for her and won't invent sources."

## 4:45 Step 8: Rosa Delgado, a parent (key `8`)

**Screen:** Mateo Delgado's classes. Click **Grade 1 Reading Foundations**.

- "One parent, two children in two schools, one sign-in."
- Point at the Word Builders comment: "She sees what teachers have shared. Never her child's own
  drafts or private space."

## 5:15 Step 9: the district office (key `9`)

**Screen:** All classes.

- "Every class from kindergarten to grade 12, in one console, on the district's own account."
- Click **Learning standards**: "Standards ship only where the licence allows. NGSS isn't built in
  yet, and the console says so." Honest answers build trust.
- Click **AI budgets**: "AI spend is capped and budgeted by the district. In this demo no AI runs,
  so it reads zero."

## 5:45 [Integrations: Cedar Valley]

Click **Switch persona**, then the **Cedar Valley · Clever + Google Classroom** tab.

- **Open the portal as Elaine Park**, then the **EducateOS** tile: "Clever Instant Login. Simulated
  here against fakes built to Clever's published API, not connected to Clever."
- Run the first complete sync from Roster sync: "People and classes arrive, matched on their Clever
  IDs. Drops are deactivated, never deleted."
- "The same pattern covers OneRoster files and Google Classroom. LTI 1.3 into Canvas and Moodle
  has passed live runs against both, so EducateOS can sit beside an LMS a district already has."

## 6:30 Close

- "District-owned, open source, in the district's own Cloudflare account. Every grade band, safe
  AI with the teacher in charge. You can try exactly this at educateos.io/demo."

## Likely questions

| Question | Answer |
|---|---|
| Is the AI real? | Not on `/demo/`: the tutors are scripted and labelled. The live district at northfield.educateos.io runs real AI in its Workshop at `/ai`, behind the AI call guard and Hall Monitor. Student tutors are a pilot preview on synthetic identities only. |
| Who is using it? | No real students yet. Every district and person here is synthetic, and legal review must pass before a real student uses it. |
| Is it certified? | No 1EdTech certification. LTI 1.3 and Advantage passed live runs against Canvas and Moodle 4.5. Clever, OneRoster and ClassLink are tested against fakes. |
| How does a district install it? | An installer sets it up in the district's Cloudflare account. It is unit-tested and partly verified on a second account; a full guided install has not completed yet. |
| What does it cost to run? | The district pays Cloudflare directly, and sets its own AI budget. See [maturity.md](../maturity.md) before quoting figures. |
