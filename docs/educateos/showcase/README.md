# The K-12 showcase

- Issue: SCHO-327 (epic SCHO-320). Built by SCHO-322 (fixtures), SCHO-324 (demo), SCHO-325 (tutors)
  and SCHO-326 (live seeding).
- Rehearsed: 2026-11-02 on the deployed <https://educateos.io/demo/> at 1280x800, 820x1180 and
  390x844.

The showcase is one fictional K-12 district, Northfield Public Schools, built out across four grade
bands so that investors and educators can see the same product from a first grader's screen to the
district office. This page says where it runs, what is real and what is simulated, and what not to
claim. The scripts for presenting it are beside it:

| Page | For |
|---|---|
| [investor-walkthrough.md](investor-walkthrough.md) | A 5 to 7 minute scripted story, with talking points per click |
| [educator-walkthrough.md](educator-walkthrough.md) | One section per grade band: what a teacher authors, what the student does, feedback and grades, the tutor |
| [presenter-checklist.md](presenter-checklist.md) | Before the meeting: browser, zoom, reset, fallbacks, live-district sign-in |

## Where it runs

| | `educateos.io/demo/` | `northfield.educateos.io` |
|---|---|---|
| What it is | A static site. The real district application, Student, Teacher, Guardian and Admin UIs run in the visitor's browser over in-memory stores. | The live demo co-op district (`schoolos-district-worker`), with the Workshop at `/ai`. |
| Sign-in | None. Pick a persona. | Cloudflare Access. Presenters use the agents.gmac.io test identities, linked to showcase personas ([demo-districts.md](../runbooks/demo-districts.md#the-k-12-showcase-scho-326)). |
| Data | Northfield's showcase, seeded on every page load. Nothing leaves the tab. Reset demo, or a reload, starts it over. | The showcase seeded into the co-op by an administrator. Additive, persistent and shared: what a presenter does stays. |
| AI | None. Each band's tutor is a scripted, labelled simulation. | Real AI in the Workshop at `/ai`, behind the AI call guard and Hall Monitor. See the caveats below for students. |
| Use it for | Every meeting. Zero setup, works offline once loaded. | A question the demo cannot answer: "is this running somewhere real?", or real AI for an educator. |

The second district on `/demo/`, Cedar Valley USD, shows the Clever path: a simulated Clever portal,
Clever Instant Login and a Clever roster sync, all against in-browser fakes built to Clever's
published v3.1 API. Its own guided "Clever tour" covers it.

## What is in Northfield

Three schools (Northfield Elementary K-5, Middle 6-8, High 9-12), twelve showcase classes, three per
band, and one past-term class. Each class has modules, readings, activities with signed rubrics,
announcements, quizzes, and student work at every stage: not started, draft, submitted, graded and
released. The picker offers ten personas:

| Band | Student | Teacher |
|---|---|---|
| K-2 | Mateo Delgado, grade 1 | Daniel Yazzie, Grade 1 Reading and Mathematics |
| 3-5 | Abena Mensah, grade 4 | Fatima Al-Sayed, Grade 4 ELA |
| 6-8 | Chidi Okafor, grade 7 | Tomás Ortega, World History 7 |
| 9-12 | Amara Okafor, grade 9 | Sam Rivera, English 9 |
| Family | Rosa Delgado, guardian of Mateo (grade 1) and Lucía (grade 10) | |
| District | Avery Admin, district administrator | |

Each persona has "Things to try" (the band journeys in `packages/educateos-demo/src/journeys.ts`),
which tick as the real app makes the requests that doing them takes. The K-12 tour strip under the
banner opens eight screens in order (`src/tour/storyTour.ts`). `?presenter` in the URL turns on
presenter mode: number keys 1 to 8 open a step, the arrow keys step through, `?` shows the keys.

## Real and simulated

| On `/demo/` | Real code | Simulated |
|---|---|---|
| District application, API, policy engine, gradebook, feedback release, guardian view, admin console | Yes. The same packages a district deploys, running in the browser. | Storage is in memory. There is no Cloudflare account, so cost and allowance figures are empty. |
| Young-learner activity: read-aloud, recording, drawing | Yes. Read-aloud uses the browser's speech; recording uses the microphone. | The seeded classmates' recordings (Priya's, Jonah's) are short hummed tunes standing in for voices, not speech. |
| AI tutors (Reading Buddy, Homework Helper, Study Coach, Research & Essay Coach) | Their names, greetings, privacy reply and personal-details check are the bundled blueprints' own. | The replies are scripted per activity, and the Hall Monitor verdicts shown under each message are what the live screening would decide, not a live call. Free typing outside the script gets "This preview follows a script". |
| OneRoster and Canvas (Northfield's tab label) | The directory came from the OneRoster-shaped fixture. | No OneRoster file is imported and no Canvas is connected in the demo. |
| Clever, Google Classroom (Cedar Valley) | The Clever roster sync and Clever sign-in code paths. | Clever itself: the portal and Data API are in-browser fakes. Not connected to Clever. |

## Maturity caveats: what not to claim

These follow [maturity.md](../maturity.md) and [pilot-gate.md](../pilot-gate.md). Use the level the
table there gives, never a stronger one.

- **No real student has used EducateOS.** Every district, person and piece of work is synthetic. The
  live instance is synthetic too, and legal review (SCHO-118) must pass before any real student uses
  it ([production-instance.md](../runbooks/production-instance.md)).
- **Student AI is a pilot preview on synthetic identities only.** The four tutors ship in the
  release, and the guard screens each at its band. Turning them on for students on the live
  district is a procedure in
  [production-instance.md, "AI tutors by grade band"](../runbooks/production-instance.md#ai-tutors-by-grade-band-scho-325)
  whose steps the runbook records as not yet run; check SCHO-325 before saying students use a real
  tutor anywhere. On `/demo/` the tutors are always simulated.
- **G1, the synthetic classroom gate, is not met.** The accessibility audit is still open, some AI
  routes are missing, and capability rollout is not enforced ([pilot-gate.md](../pilot-gate.md)).
  Say "built and harness-tested", not "pilot-ready".
- **LTI 1.3 and LTI Advantage** are external-conformance-tested against a current Canvas and Moodle
  4.5 on labnuc. No 1EdTech certification is claimed.
- **Clever** roster sync and Clever SSO are harness-tested against fakes, not against a real Clever
  district.
- **OneRoster 1.2** sync is unit-tested; no run against a real OneRoster provider.
- **Google Classroom** sync is harness-tested, with grade sync validated live on a single course.
- **ClassLink** is implemented against fakes only.
- **NGSS is not shipped.** Its licence allows metadata and pointers only, so it is not built in and
  cannot be approved; the admin console says so under Learning standards. CCSS, C3 and other
  frameworks whose publishers allow it do ship ([standards-licensing.md](../standards-licensing.md)).
- **Installer:** no full guided install into a district's own account has completed yet (SCHO-66,
  SCHO-243). "Runs in the district's own Cloudflare account" is the architecture, and the co-op runs
  that way through ForgeGraph, not yet from a signed release through the installer.

## Rehearsal findings (2026-11-02)

Ranked by what an investor or teacher would notice. Evidence screenshots are in
`/tmp/educateos-plan/rehearsal/shots/` on the rehearsing machine; they are not committed.

| Rank | Finding | Status |
|---|---|---|
| Major | The admin persona lands on a Dashboard that read "Classes: EducateOS is not set up yet" and "Roster integration: Not set up", and Policies read "Set up the district under Modules and activation first", because the demo's Northfield had no applied configuration. | Fixed in SCHO-327 (Northfield applies a configuration on boot); live after the next demo deploy. Until then, present the admin from tour step 8 (All classes) and skip Dashboard and Policies. |
| Major | "Mr. Yazzie listens to Priya's retelling": Priya's recordings are 1.4-second hummed tunes, not a child's voice. | Say so, or record a real retelling as Mateo first and play that one. |
| Major | The 3-5 copy promised "Sentence starters" on Abena's screen; only K-2 activities show them. The Homework Helper's hints give starters. | Copy fixed in SCHO-327. |
| Major | K-2 teacher: "release feedback to Jonah" had no pointer, and Jonah's Word Builders work is ungraded, so releasing it shares nothing. His graded, unreleased work is Apple Orchard Story Problems in Grade 1 Mathematics. | Persona and journey copy fixed in SCHO-327. |
| Minor | Tour steps 4 and 6 ("reads feedback") open at the top of a long activity page; the feedback is at the bottom. Step 3's tutor is below the fold at 1280x800. | Scroll on cue (scripted in the walkthroughs). |
| Minor | Tour step 5 (World History 7 gradebook) has one graded student of three. | Point at Chidi's row and the "official grades only" line. |
| Minor | Tour step 7 opens Lucía's page (one class) though the step leads with Mateo; Mateo's page shows the Word Builders comment. | Click "Mateo Delgado" on cue. A one-line route change in `storyTour.ts` would fix it. |
| Minor | Resources are listed as "Resource 1" (the student API names a resource only by release, `packages/educateos-student-ui/src/activity/ResourceList.tsx:24`). | Known limitation; avoid pointing at it. The K-2 story text is on the "Listen" step and in the course's module. |
| Minor | A grade-1 student sees "Course grade: 100.0% · A", a receipt code after handing in, and "You can submit this activity up to 3 times". A grade-4 student can see letter grades (Diego, 6/12, F). | Educator-facing question; no change made. |
| Minor | The Study Coach's tagline is "Math by asking the right questions" on a history activity; free typing outside the tutor script is marked "allowed, sent to" the tutor while the reply says the preview follows a script. | Copy, left as is. |
| Minor | Sentence starters "First, Next, Last" appear on the K-2 drawing step too. | Left as is. |
| Minor | On a phone the demo banner and tour strip take about a quarter of the height. | Present at 1280x800 or larger. |
| Minor | Dev builds log a React "Cannot update a component while rendering a different component" warning from `NotificationsLink`; production does not show it. | Not visible to visitors. |

Nothing was broken: every journey step for all ten personas and all eight tour steps completed at
all three sizes with no console errors, and presenter keys, the typing guard and Reset demo worked.

Boot, measured cold with Playwright's Chromium from a residential connection: the picker is visible
in 1.0 to 1.5 s and the district is ready (tour and personas usable) in 3.5 to 3.9 s, of which the
in-page district boot and seed is 2.5 s. With the CPU throttled four times, ready took 12.4 s; with
a slow network as well, 16.7 s. The bundle is one 3.3 MB script (850 KB compressed), cached as
immutable, so a second visit is fast. Once loaded the demo makes no network requests at all; a
reload needs the network.
