# Demo script: educateos.io/demo in 20 minutes

- For: whoever runs a district or school sales meeting (superintendent, principal, teachers, district IT).
- What it shows: the public, no-AI demo at [educateos.io/demo](https://educateos.io/demo/). It runs the real
  Student, Teacher and Admin apps over the real district application, inside the visitor's browser,
  against a synthetic district. Nothing is sent to a server. Northfield and Cedar Valley are fictional,
  and so is every person and school in them.
- Verified: every click below was performed in headless Chromium at 1440×900 against a production
  build of `packages/educateos-demo` on 2026-11-14, and the steps SCHO-410 changed (the tutor
  label, the gradebook, export and Roster sync) again on 2026-11-16. Labels are quoted as they
  appear on screen.

## Before the meeting

**Browser.** Use desktop Chrome on a laptop at least 1280 px wide. The admin console and the
gradebook are wide tables.

**Two tabs, opened in advance on good wifi.**

1. Tab A: `https://educateos.io/demo/` (Northfield, the K-12 district). Wait until the persona
   cards stop showing "Setting up the district…". This took about 5 seconds on a laptop. Allow
   10 to 20 seconds on venue wifi.
2. Tab B: `https://educateos.io/demo/?district=cedarvalley&presenter` (Cedar Valley, the Clever
   district, in presenter mode). This tab is only needed for the IT segment.

**Reset.** **Reset demo** (top right) boots a fresh copy of the district in about 5 seconds.
Closing the tab also throws everything away. Reset both tabs just before you start.

**Presenter mode.** Add `?presenter` to the URL. In Northfield, number keys 1 to 9 open the
K-12 story tour's steps, → and ← move through them, and **?** shows the shortcuts. In Cedar
Valley, keys 1, 2 and 3 sign in as the administrator, teacher and student through the simulated
Clever portal. Keys do nothing while the cursor is in a text field.

**If the wifi fails.** Once Tab A has loaded, Northfield keeps working with the network off.
The district runs in the page; we checked this by cutting the network after load and then using
the admin, the policy screen and a student. Cedar Valley loads extra code the first time it opens,
so open Tab B before you lose the network. If you have no working tab, use
screenshots: [educateos.io/tour/](https://educateos.io/tour/) shows the same screens. Save it as a
PDF ahead of time, along with the
[district overview PDF](https://educateos.io/educateos-district-overview.pdf).

**Say this at the start, every time:** "This demo has no AI in it. The tutors are scripted, and
every AI cost reads $0.00."

## Timing

| Time | Segment | Who you are |
| --- | --- | --- |
| 0–2 | Framing | the demo's start page |
| 2–7 | Teacher: grade, approve, announce | Fatima Al-Sayed, Grade 4 teacher |
| 7–11 | Student: the announcement, the simulated tutor, feedback | Abena Mensah, Grade 4 student |
| 11–15 | District console: policy, AI budgets, audit, export | Avery Admin, technology director review |
| 15–17 | IT: Clever sign-in and roster sync under the hood | Elaine Park, Cedar Valley administrator |
| 17–20 | Questions and the pilot | – |

## 0–2 Framing

Start in Tab A, on the start page ("Try EducateOS").

- **Point to** the top bar: "Demo · Fictional district · everything stays in your browser · AI tutors are simulated".
- **Point to** the two district tabs, **Northfield · OneRoster + Canvas** and **Cedar Valley · Clever + Google Classroom**,
  and the persona cards grouped by grade band, from "Kindergarten to grade 2" to "District".
- **Say:** "This is the real software running in your browser against a made-up district. No real
  students, no real AI, and nothing you click leaves this laptop."

## 2–7 Teacher: Fatima Al-Sayed, Grade 4

| # | Click | The room sees | Say |
| --- | --- | --- | --- |
| 1 | The **Grade 4 teacher · Fatima Al-Sayed** card | Teacher Studio, "My classes": two Grade 4 classes, 3 students each | "This is Teacher Studio. It's what a teacher opens every morning." |
| 2 | **Grade 4 English Language Arts · Room 12**, then the **Submissions** tab | The class tabs (Roster, Modules, Resources, Create activity, Submissions, Gradebook, Announcements, Discussions, Quizzes) and the activity list with "3 turned in" | "Everything a class needs sits behind one set of tabs." |
| 3 | **The Theme of "The Kite That Would Not Fly"**, then **Review Hana Suzuki's work** | Hana's paragraph, read-only. It says "The student declared no AI assistance. This declaration is not an AI detection result." Below it are the Rubric, Feedback ("Not shared yet") and Official grade sections. | "The student says whether they used AI. We don't pretend to detect it." |
| 4 | In **States a theme** pick **Proficient (3)**, then **Save score**. Do the same for **Uses details from the text** (Proficient (3)) and **Spelling and punctuation** (Advanced (4)) | "Your score: 3 of 4 (Proficient)" under each criterion | "The teacher scores the rubric. Nothing is scored for them." |
| 5 | Type a comment in **Comment**, then **Add comment**, then **Share feedback with student** | Feedback changes to "Shared with the student" | "Feedback stays private until the teacher shares it." |
| 6 | Under Official grade, check that Points and Out of read 10 and 12, then **Approve official grade** | A dialog: "Approve the official grade? This is the official grade: 10 out of 12 for Hana Suzuki…" | "A grade only becomes official when the teacher approves it. Nothing goes to a gradebook before that." |
| 7 | **Yes, approve official grade** | "Official · 10 out of 12 · Approved …" | – |
| 8 | **Gradebook** tab | "Official grades only." The line above the table says it is wider than the screen. Scroll it sideways (or click a cell and use the arrow keys; End jumps to the totals) to the Kite column: Hana's cell reads 10/12 and her row ends 83.3%, B | "The gradebook only shows grades the teacher approved." |
| 9 | **Announcements** tab. Fill in **Title** ("Opinion pieces due Monday") and **Message**, then **Post announcement** | The announcement appears under "Posted and scheduled" | "Now let's see what a student sees." |

The **Things to try** button in the top bar ticks off steps as you do them (2/3 after step 8). You can
open it to show the room what is left.

## 7–11 Student: Abena Mensah, Grade 4

| # | Click | The room sees | Say |
| --- | --- | --- | --- |
| 1 | **Switch persona** (top bar), then the **Grade 4 student · Abena Mensah** card | Learning Home: "Hi, Abena Mensah". Fatima's "Opinion pieces due Monday" is first under Announcements. | "Same district, same data. The announcement the teacher just posted is here." |
| 2 | **Grade 4 English Language Arts · Room 12**, then **Should Recess Be Longer?** | The activity: Instructions, the **Read to me** buttons, the "Homework Helper (simulated)" panel with a "Simulated preview" badge and the line "Simulated preview — scripted, with no AI behind it. Student-facing AI stays off in the founding pilot.", and My work in Plan, Draft and Revise | "Grade 4 gets read-aloud on request and a step-by-step workspace." |
| 3 | **Ask Homework Helper**, then the quick reply **What's the first step?** | The helper answers with a planning step. A line reads "Hall Monitor checked this for grades 3–5: allowed, sent to Homework Helper." | "This tutor is scripted. There is no AI behind it." |
| 4 | Quick reply **Just write it for me** | "Hall Monitor: asks the tutor to do the graded work. Not sent to the AI; Homework Helper steers back kindly." Then: "I can't write it for you…" | "This shows the design: hints, not answers. Student-facing AI is a pilot preview with synthetic students only. In the founding pilot it stays off." |
| 5 | Type a sentence in **Your work for Plan**, then the **Save** under it | "Saved …" and "Plan saved." | – |
| 6 | **Grade 4 English Language Arts · Room 12** (breadcrumb), then **The Theme of "The Kite That Would Not Fly"** | "Grade and feedback": "Official grade: 11 out of 12", "Shared by your teacher", the comment and the criterion results | "Students see the official grade and the comments their teacher released. Nothing else." |

Replies take about half a second after a click. The panel shows "Hall Monitor is checking, then
Homework Helper is thinking…" while it waits.

## 11–15 District console: Avery Admin, technology director review

| # | Click | The room sees | Say |
| --- | --- | --- | --- |
| 1 | **Switch persona**, then **Technology director review · Avery Admin** | "EducateOS district admin" Dashboard: 34 students and staff, 13 classes, **AI usage and cost $0.00**, Roster integration "OneRoster CSV export", Export the district | "One console for the whole district. AI cost is $0.00 because the demo has no AI." |
| 2 | **Policies** in the left menu | District settings: AI spending, Prompt logging, Personal conversation privacy, Teacher observation, Social-emotional profiling, and **Monthly AI cap per person (US dollars)**, now $2.00 | "These are district floors. Schools and classes can be stricter, never less strict." |
| 3 | Change the cap to 1.50, then **Review change** | "Preview: district policy change. This is a preview. Nothing changes until you choose Apply policy." A Classes affected table lists every class, school and head count. | "Every change is a dry run first. You see which classes it reaches before it applies." |
| 4 | **Apply policy** | "District policy updated. Version 2 of the configuration is now in force." | – |
| 5 | **AI budgets** | Gross model cost $0.00. Free allowance and Net estimated bill read "Not available". "No safety reserve is configured. Without one, safety checks cannot run, and student-facing AI that needs them stays off." | "Spend caps and a separate safety reserve. Without a reserve, student-facing AI stays off." |
| 6 | **Admin audit log** | "Administrators' changes, newest first": Avery Admin, "Configure capability config", Allowed, with the rule and a reference | "Every admin change is logged, including the one I just made." |
| 7 | **Dashboard**, then **Export** under "Export the district" | The button spins, then the browser saves `dst_northfield-<date>.zip` after about 1.5 seconds. | "The district can take all of its records out at any time, in one file." |

Optional if the audience is IT: **Roster sync** says "This roster is imported, not synced" and links
to **Roster**, where a district imports OneRoster CSV files with a preview before anything applies
(the live **Preview import** needs a CSV export from disk, which this script does not use; Cedar
Valley shows a real sync). **Operations** says "No admin is enrolled. Nobody can use this
district's operations API." **Safety decisions** lists every policy decision with its rule.
**Sign-in** lists the trusted issuers and says "Synthetic sign-ins: this is a demo district".

Keep these to the console's status. The admin console, default-deny policy, AI spend caps and Hall
Monitor screening are marked "In development" on the site. Export is harness-tested and has not run
in a live district.

## 15–17 IT: Clever sign-in and roster sync (Tab B)

Switch to Tab B (`?district=cedarvalley&presenter`). A notice reads "Simulated Clever district —
runs on our Clever fakes, built to Clever's published v3.1 API. Not connected to Clever."

| # | Click | The room sees | Say |
| --- | --- | --- | --- |
| 1 | Press **1**, or click **District administrator · Elaine Park** and then the **EducateOS** tile | You are signed in through the portal and land on **Roster sync**: source Clever, "Never synced" | "District staff open EducateOS from their Clever portal." |
| 2 | **Under the hood: the Clever sign-in, step by step (11 steps)** | Each hop of the sign-in, marked "Passed": Instant Login, the code exchange, `/me`, the redirect to the district, the id_token check | "The district checks Clever's signed token and the district ID before it opens a session." |
| 3 | **Run complete sync** | Done in about 2 seconds: "39 changes applied". People 8, Classes 4, Enrollments 16 added. Issues (2): a guardian is not imported, and the district administrator role is "granted in EducateOS, never from the roster". | "Admin rights never come from the roster. The district grants them." |
| 4 (optional) | **Clever side** (right panel). Click **Change** next to Isaac Thornton, choose **Withdraw from the district**, then **Run delta sync** | "1 pending" in Clever, then "Delta sync just now · 2 changes applied" with People Deactivated 1 | "Students who leave are deactivated, never deleted." |

Extended IT path, about 3 more minutes, verified:

1. Press **2** (Dana Whitaker, through the portal).
2. Click **Earth Science 8 · Whitaker**, then **Submissions**, then **Where does the rain go?**,
   then **Review An Nguyen's work**.
3. Under **Explanation**, pick **Clear (5)**, then **Save score**. Click **Approve official grade**,
   then **Yes, approve official grade**.
4. Click **Where grades land** (top). It reads "Sent An Nguyen's grade to Google Classroom", then
   "Landed in Google Classroom course Earth Science 8, Period 1…". This is a simulated Classroom.
5. Click **Try sending an unapproved grade in Earth Science 8**. It reads "Refused: This grade has
   not been approved by the class's teacher. Nothing was written to any gradebook."

Say: "Grades leave only after the teacher approves them. An unapproved grade is refused."

## 17–20 Questions and next step

Close with the founding pilot ([educateos.io/pilot/](https://educateos.io/pilot/)):

- 3 to 5 public districts in Texas and Michigan.
- One school and a few champion teachers, for about 10 weeks.
- The software is free, and we install it with your IT team in your own Cloudflare account. The district pays its own Cloudflare bill.
- AI for teachers comes first. Student-facing AI stays off.
- Synthetic or staff-only data until a data processing agreement is signed.
- Contact: hello@educateos.io. There is no booking link, so ask for their email and follow up.

## If you only have 5 minutes

Open `https://educateos.io/demo/?presenter` and let it finish loading. Then:

1. Press **1**: Mateo, grade 1, retells a story by voice and drawing. Say: "Big type, read aloud, no typing needed."
2. Press **→** twice: Mr. Yazzie's submissions, then his course modules. Say: "Teachers review recordings and drawings. Their semester came from a course package they can edit."
3. Press **4**: Abena and the Homework Helper. Click **Ask Homework Helper**, then **Just write it for me**. Say: "Scripted, no AI. Hints, not answers."
4. Press **9**: Avery Admin, **All classes**, from kindergarten to grade 12. Say: "One console for the district, on the district's own Cloudflare account."

Press **?** at any time for the list of steps.

## What we can claim, and how far each one has got

| Topic | Say | Level (see [maturity.md](../maturity.md)) |
| --- | --- | --- |
| The demo | Real apps, fictional district, no AI, scripted tutors, $0.00 AI cost | – |
| Users | No real students use EducateOS yet. No district has run the installer yet. | – |
| Student AI tutors | Pilot preview, synthetic students only. Off in the founding pilot. | – |
| Default-deny policy, AI spend caps, Hall Monitor, admin console | In development | Policy engine harness-tested; AI guard deployed from source |
| LTI 1.3 | Passed live runs against Canvas and Moodle 4.5. No 1EdTech certification is claimed. | External-conformance-tested |
| Google Classroom | Validated live on one course only | Harness-tested, plus one live course |
| Clever sign-in | Tested against our Clever fakes. No live Clever sign-in yet. | Harness-tested |
| Clever roster sync | Tested against our Clever fakes | Harness-tested |
| OneRoster import | Preview before apply | Unit-tested |
| District export | Harness-tested. Not yet run in a live district. | Harness-tested |

> **What not to say**
>
> - Never claim compliance or certification of any kind. If asked, say that no certification is claimed.
> - Don't say "AI" without "simulated" while the tutor is on screen. In the founding pilot, student-facing AI is off.
> - Don't say the demo is connected to Clever, Google Classroom or Canvas. It runs on fakes.
> - Don't name real districts, schools or customers. Northfield, Cedar Valley and everyone in them are fictional.
> - Don't say "students are using it", "districts are running it" or "deployed in schools". None are yet.
> - Don't promise dates, prices or a booking link. Use hello@educateos.io.
> - Don't call the console, policy controls or AI caps finished. They are in development.

## Known rough edges in the demo

- The gradebook is wider than a laptop screen for a class with a full semester of assignments. It
  scrolls sideways inside its own frame, says so above the table, and takes keyboard focus; it does
  not shrink to fit.
