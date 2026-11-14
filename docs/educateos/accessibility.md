# EducateOS accessibility audit and conformance report (WCAG 2.1 AA)

- Status: Living document. Re-run the audit and update this page in the PR that changes its evidence.
- Date: 2026-11-13 (audit run on branch `SCHO-361-accessibility`, rebased on main `ef94376e7`)
- Issue: SCHO-361 (parent SCHO-358). 2.2.1 Timing Adjustable rated Partially supports on 2026-11-14 (SCHO-394).
- Public report: [educateos.io/it/accessibility/](https://educateos.io/it/accessibility/), an ACR in VPAT layout built from this page

## Summary

EducateOS **partially conforms** to WCAG 2.1 Level AA. The Student, Teacher, Guardian and Admin
UIs, as they run in the zero-login demo, were audited with automated and programmatic checks on 143
screens, each in a light theme, a dark theme and at 320 CSS pixels wide. Before fixes, those checks
found 14 distinct failures, all serious. All 14 are fixed in this change. After the fixes:

- axe-core reports no WCAG 2.0/2.1 A or AA violations on any of the 429 screen audits;
- no screen scrolls sideways at 320px;
- every one of 4,782 keyboard focus stops has a name and a visible focus change;
- every action exercised announced its outcome through a live region.

Three criteria remain **Partially supports**:

| Criterion | Why | Follow-up |
|---|---|---|
| 1.4.3 Contrast (Minimum) | Kumo's link hover colour is under 4.5:1 while hovered. | SCHO-380 |
| 1.4.11 Non-text Contrast | Text field boundaries are 1.25 to 1.52:1. | SCHO-379, SCHO-380 |
| 2.2.1 Timing Adjustable | A teacher can extend a timed quiz for one student (1.25× to 4×) or remove its limit, and the server enforces it (SCHO-383), but a student can't extend a limit themselves. | None open |

**No screen reader or other assistive technology was used.** "Supports" in this report means the
checks below found no failure on the screens audited. It is not a claim verified with assistive
technology. Screen-reader testing of the critical flows is SCHO-381.

## What was evaluated

The demo at [educateos.io/demo/](https://educateos.io/demo/), built from `packages/educateos-demo`. It
mounts the real Student (`@educateos/student-ui`), Teacher (`@educateos/teacher-ui`) and Admin
(`@educateos/admin-ui`) apps over the real district application, in the browser, against the
synthetic Northfield district. Guardians use the Student app's family view. The audit visits every
persona on Northfield's picker:

| App | Personas | Screens audited (each in light, dark and 320px) |
|---|---|---|
| Learning Home (student) | Grade 1, Grade 4, Grade 7, Grade 9 student | 43: Home, My space, Grades, Calendar, Notifications, Settings, each course, an activity, a quiz, and a notification's activity |
| Learning Home (family) | Guardian of Mateo (grade 1) and Lucía (grade 10) | 3: a child's home, My children, the other child |
| Teacher Studio | Grade 1, Grade 4, World History 7, English 9 teacher | 64: My classes, Roster, Modules, Resources, Create activity, Submissions, an assignment's submissions, a student's work under review, Gradebook, Announcements, Discussions, Quizzes, quiz results |
| Admin console | District administrator, Technology director review | 32, 16 each: Home, Dashboard, Roster, Roster sync, All classes, Manage classes and people, Guardians, Modules and activation, Learning standards, Course library, Policies, AI usage, AI budgets, Term rollover, Operations, a school |
| Demo chrome | none | 1: the persona picker |

Not evaluated: the Cedar Valley district's Clever portal and tour, the Workshop AI workspace at
`/ai` (the demo's tutors are simulated), sign-in through Cloudflare Access, LTI launches, guardian
invitations and device connection, the mobile app, and browsers other than Chromium (SCHO-384).

## Method and tools

- axe-core 4.14.0, rules tagged `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`
- Playwright 1.64.1 driving Chromium 156.0.8078.4 (headless shell), Node 24.14.0, macOS
- `packages/educateos-demo/scripts/a11y-audit.ts`, run as `pnpm --filter @educateos/demo a11y`
  after `pnpm exec vp run -F @educateos/demo build`

The script serves the built demo and opens each persona's app. From each app's home screen it opens
every screen the app's navigation reaches, plus one screen of each critical flow it finds linked: an
activity, a quiz, an assignment's submissions, a student's work under review, quiz results,
notifications and settings. It stops at 16 screens per persona. It does that three times: at
1280px in the light theme, at 1280px in the dark theme, and at 320px in the light theme. On every
screen it records:

| Check | WCAG | How |
|---|---|---|
| axe violations, and what axe couldn't decide | all A and AA rules axe has | `axe.run` on the whole document |
| Headings and live regions | 1.3.1, 4.1.3 | counts `h1`s and live regions |
| Sideways scrolling at 320px | 1.4.10 | `scrollWidth` against the viewport, and the outermost elements that stick out |
| Form-control boundary contrast | 1.4.11 | each text field's, checkbox's, radio's, switch's and combobox's border, ring or fill against the surface behind it |
| Text spacing | 1.4.12 | applies the criterion's line, paragraph, letter and word spacing, then looks for text a hidden overflow cuts off |

In the light pass it also walks each screen by keyboard. From the top of the page it presses Tab
until focus comes back round, recording each stop's role and name. It records whether the stop's
outline, ring, border, background or underline changes when it has focus. It then exercises status
messages (4.1.3) with a MutationObserver on live regions:

- switching the theme, for every persona;
- pinning a discussion, for each teacher;
- making a staff member an administrator, for the administrator.

It writes `results.json` and `summary.md`, and exits 1 on any serious or critical axe violation.

By hand: screenshots of focused controls in both themes, to confirm the focus heuristic shows a
real ring. Also a code review for criteria no tool checks: media, shortcuts, timing, error messages,
hover content and input purpose. Contrast ratios quoted here are WCAG 2.x relative-luminance ratios.

## Findings and fixes

Severity follows axe's impact where axe found it. Every finding below fails an A or AA success
criterion, so all are rated serious.

| # | Finding | WCAG | Where | Fix | Status |
|---|---|---|---|---|---|
| 1 | Secondary text (Kumo `text-kumo-subtle`, #737373) is 4.46:1 on elevated surfaces and 4.27:1 on the tab list, under 4.5:1 | 1.4.3 | Every screen, light theme | `--text-color-kumo-subtle` raised to oklch(53% 0 0): 4.7 to 5.3:1 | Fixed |
| 2 | Banner "alert" text (#bd6500) is 4.0:1 on its tint | 1.4.3 | Admin Home, Dashboard, Roster sync | `--text-color-kumo-warning` raised to oklch(55% 0.135 57.5): 4.9:1 | Fixed |
| 3 | Placeholder text is 2.58:1 light and 3.78:1 dark (a Select's "Choose…" is its only text) | 1.4.3 | Admin Term rollover | `--text-color-kumo-placeholder` raised in both themes | Fixed |
| 4 | Unchecked checkbox, radio and switch rings are 1.0 to 1.85:1 | 1.4.11 | Teacher Create activity, Discussions, Announcements; Admin Modules | Rings raised to 3.2:1 or more in both themes | Fixed |
| 5 | "Make administrator" and "Remove administrator" are named "Make X an administrator", which doesn't contain the visible label | 2.5.3 | Admin Manage classes and people | Named "Make administrator: X" | Fixed |
| 6 | "Read to me" is named "Read the instructions to me" | 2.5.3 | Student activities and quizzes | Named "Read to me: the instructions" | Fixed |
| 7 | "Mark read" is named `Mark "…" as read` | 2.5.3 | Student Notifications | Named "Mark read: …" | Fixed |
| 8 | Wide tables scroll in a region the keyboard can't reach | 2.1.1 | Admin Manage classes and people, Course library; Teacher quiz results | Focusable, named scroll groups (`TableScroll` in the admin, on all 20 of its tables) | Fixed |
| 9 | The Learning Home header and phone navigation scroll sideways by 41 to 46px | 1.4.10 | Every student and guardian screen at 320px | The header wraps; the phone navigation stacks each icon over its label | Fixed |
| 10 | Admin tables widen the page by 137px | 1.4.10 | Manage classes and people | Tables scroll in their own region | Fixed |
| 11 | The gradebook's screen-reader-only cell labels sit outside its scroll card and widen the page by 2,086 to 2,533px | 1.4.10 | Teacher Gradebook | The card is the labels' containing block | Fixed |
| 12 | The quizzes table widens the page by 199 to 205px | 1.4.10 | Teacher Quizzes | It scrolls in its own region | Fixed |
| 13 | Long discussion titles, which are one-line buttons, widen the page by 44 to 91px | 1.4.10 | Teacher Discussions; student course pages | The title buttons wrap | Fixed |
| 14 | The submissions layout's single grid column sizes to its content, 16 to 60px too wide | 1.4.10 | Teacher assignment submissions | `grid-cols-1` below the md breakpoint | Fixed |
| 15 | Text field, text area and combobox boundaries (Kumo's `kumo-line` ring) are 1.25 to 1.52:1 | 1.4.11 | 284 controls on 132 of 429 screen audits | Not changed: darkening every field is a design change | Open, SCHO-379 |
| 16 | Kumo Link's hover colour (`text-kumo-link/70`) is 4.23:1 light and 4.08:1 dark while hovered | 1.4.3 | Links in lists, such as notifications | Upstream | Open, SCHO-380 |
| 17 | Every screen of an app has the same document title | 2.4.2 | All apps | Per-route titles, set by the shell's `PageHeading` and `useRouteTitle` (SCHO-382) | Fixed |
| 18 | A teacher can't extend a timed quiz's limit for one student (IEP/504 extended time) | 2.2.1 | Student quizzes | Per-student extended time (1.25× to 4×, or no limit), set by the class's teachers or a district administrator and enforced by the district's clock | Fixed, SCHO-383 |

Counts: 18 findings, all serious; 16 fixed, 2 open. Findings 1 to 4 are fixed in one stylesheet,
`packages/educateos-shell/src/contrast.css`, which every app's stylesheet and the demo's import after
Kumo's. They override Kumo's tokens until Kumo's own meet AA (SCHO-380).

Related, not a WCAG failure: Kumo's `Radio.Group` puts no name on its `role=radiogroup` element
(SCHO-125). Its fieldset and legend name the group.

Demo only: the demo's banner (Things to try, Switch persona, Reset demo, the tour) comes before each
app's skip link, so a keyboard user passes five banner controls first. The banner isn't part of a
district's install.

## Results after the fixes

| Check | Result |
|---|---|
| axe violations (429 audits) | 0 |
| axe "incomplete" (left to manual review) | color-contrast on 174 nodes in each 1280px theme and 905 at 320px: text over gradients, pseudo-content, very short text, and text partly covered by the sticky header or fixed phone navigation. Two `th-has-data-cells`. None reviewed node by node. |
| Screens with exactly one `h1` | 143 of 143 |
| Sideways scrolling at 320px | 0 of 143 screens |
| Text clipped by the 1.4.12 spacing | 0 of 143 screens |
| Keyboard walks | 142 walks, 4,782 stops. Every stop has a name and a visible focus change, and each walk cycled back to its start. The exception is the four teachers' Modules screens, which have more than 120 stops: the walk still moved through 120 distinct elements, so nothing trapped it. Each app's skip link is its first stop after the demo banner. |
| Status messages | 14 actions exercised, 14 announced (two more teachers had no discussion to pin) |
| Form controls under 3:1 | 284 text fields, text areas and comboboxes (finding 15). No checkboxes, radios or switches. |

## Conformance by criterion

Supports means the checks named in the remark found no failure on the screens audited. Criteria a
screen reader would confirm are marked "not yet confirmed with a screen reader" (SCHO-381).

### Level A

| Criterion | Conformance | Remarks |
|---|---|---|
| 1.1.1 Non-text Content | Supports | axe's image, SVG and role=img rules pass. Decorative icons are hidden. Uploaded images and files carry their title as their name. The young learners' drawing step offers a photo upload. Teachers write the text alternatives for their own content. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Not applicable | The apps contain no prerecorded media of their own. Media a teacher or student uploads plays in the browser's player, and its alternative is the author's to provide. |
| 1.2.2 Captions (Prerecorded) | Not applicable | As 1.2.1. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not applicable | As 1.2.1. |
| 1.3.1 Info and Relationships | Supports | axe's structure, table, list and form-label rules pass. Every screen has landmarks and one h1. Tables have captions and headers, and radio groups are fieldsets with legends. Not yet confirmed with a screen reader. |
| 1.3.2 Meaningful Sequence | Supports | DOM order matches the visual order: the keyboard walks follow reading order on every screen. |
| 1.3.3 Sensory Characteristics | Supports | No instruction relying on shape, size, position or sound alone was seen in the screens reviewed. They weren't reviewed exhaustively. |
| 1.4.1 Use of Color | Supports | Statuses are words in badges, not colour alone. axe's link-in-text-block rule passes. |
| 1.4.2 Audio Control | Supports | Nothing plays automatically. "Read to me" starts on request and stops when pressed again. |
| 2.1.1 Keyboard | Supports | Every control on every screen is reachable by Tab. Wide tables scroll by keyboard (finding 8). Freehand drawing needs a pointer, which is path-dependent input the criterion exempts, and the step offers a photo upload. The audit reaches controls by Tab but doesn't operate composite widgets (radio groups, comboboxes, the gradebook grid) by their arrow keys. |
| 2.1.2 No Keyboard Trap | Supports | No walk was trapped (see Results). |
| 2.1.4 Character Key Shortcuts | Not applicable | The apps have no single-character shortcuts. The demo's presenter keys are demo-only and work only with `?presenter`. |
| 2.2.1 Timing Adjustable | Partially supports | The apps set no session time limits; sign-in sessions are the district's Cloudflare Access policy. A quiz's time limit is one its teacher sets for the assessment. A teacher of the class, or a district administrator, can give one student 1.25 to 4 times that limit, or no time limit, as an IEP or Section 504 plan sets it. The district's clock, on the server, enforces each student's own deadline, extends an attempt already in progress, and shows the student only their own time; API and UI tests check this (SCHO-383). A student can't extend or turn off a limit themselves, before or during an attempt, so a student whose plan isn't entered gets no adjustment. The quiz's close date still ends every attempt. |
| 2.2.2 Pause, Stop, Hide | Supports | No moving, blinking or auto-updating content other than loading indicators and a timed quiz's countdown, which is essential to the quiz. |
| 2.3.1 Three Flashes or Below Threshold | Supports | Nothing flashes. |
| 2.4.1 Bypass Blocks | Supports | Each app's first control is "Skip to content", and every screen has landmarks. |
| 2.4.2 Page Titled | Supports | Every screen sets its own document title: its name, then its class or child where it has one, then the app, such as "Gradebook · English 9 · Period 3 · Teacher Studio" or "My grades · Learning Home". While a screen loads or can't load, its route's name stands in ("Activity · Learning Home"). The apps' tests check a unique title on each route. In the audit, no two of a persona's screens share a title, apart from its Home, which is the screen its app opens on (SCHO-382). |
| 2.4.3 Focus Order | Supports | Focus follows the layout. Teacher Studio and the Learning Home move focus to the new page's heading when you navigate, the admin console moves it to the new screen's content, and dialogs keep focus inside. Not yet confirmed with a screen reader. |
| 2.4.4 Link Purpose (In Context) | Supports | axe's link-name rule passes. Icon-only links, such as Settings and Notifications, have names. |
| 2.5.1 Pointer Gestures | Supports | No multipoint or path-based gesture is needed to operate anything. Drawing is the exempt path-based case and has an upload alternative. |
| 2.5.2 Pointer Cancellation | Supports | Controls are native or Base UI buttons that act on release. |
| 2.5.3 Label in Name | Supports | After findings 5 to 7, axe's label-content-name-mismatch passes everywhere. |
| 2.5.4 Motion Actuation | Not applicable | Nothing responds to device motion. |
| 3.1.1 Language of Page | Supports | `lang="en"` on every app. |
| 3.2.1 On Focus | Supports | No walk caused navigation or a change of context. |
| 3.2.2 On Input | Supports | No change of context on input was seen: choosing an option doesn't navigate or submit. |
| 3.3.1 Error Identification | Supports | Code review: failed actions and invalid forms state the error in text, in an alert region. Not every form's errors were triggered. |
| 3.3.2 Labels or Instructions | Supports | axe's label rules pass, and fields have visible labels. |
| 4.1.1 Parsing | Supports | axe's duplicate-id rules pass. The criterion is obsolete in WCAG 2.2. |
| 4.1.2 Name, Role, Value | Supports | axe's ARIA and name rules pass, and every focus stop has a name. Toggles expose pressed and expanded states. Not yet confirmed with a screen reader. |

### Level AA

| Criterion | Conformance | Remarks |
|---|---|---|
| 1.2.4 Captions (Live) | Not applicable | No live media. |
| 1.2.5 Audio Description (Prerecorded) | Not applicable | As 1.2.1. |
| 1.3.4 Orientation | Supports | Nothing locks orientation; layouts were audited at 320 and 1280px wide. |
| 1.3.5 Identify Input Purpose | Not applicable | People's identity comes from district sign-in. The apps don't ask anyone for their own personal details; the admin's name and email fields are about other people. |
| 1.4.3 Contrast (Minimum) | Partially supports | After findings 1 to 3, axe's color-contrast passes in both themes and at 320px. Kumo's link hover colour is under 4.5:1 while hovered (SCHO-380). axe couldn't decide some text over gradients or partly covered (see Results). |
| 1.4.4 Resize Text | Supports | Layouts hold from 1280 down to 320 CSS px, the equivalent of 400% zoom. Text-only zoom was not tested. |
| 1.4.5 Images of Text | Supports | All text is text. |
| 1.4.10 Reflow | Supports | After findings 9 to 14, no screen scrolls sideways at 320px. Data tables scroll within their own region, which the criterion allows for two-dimensional content. |
| 1.4.11 Non-text Contrast | Partially supports | Checkbox, radio and switch boundaries meet 3:1 (finding 4), and focus rings were checked visible. Text field, text area and combobox boundaries are 1.25 to 1.52:1 (SCHO-379). |
| 1.4.12 Text Spacing | Supports | With the criterion's spacing applied, no text is cut off. |
| 1.4.13 Content on Hover or Focus | Supports | No custom content appears on hover or focus: menus and popovers open on click. Browser title tooltips are the browser's own. |
| 2.4.5 Multiple Ways | Supports | Each app has persistent navigation, and screens are also reached from lists, breadcrumbs, the calendar and notifications. |
| 2.4.6 Headings and Labels | Supports | Every screen has one h1 that names it, and sections and fields are labelled for their purpose. |
| 2.4.7 Focus Visible | Supports | All 4,782 focus stops change visibly with focus, and screenshots confirm the rings in both themes. |
| 3.1.2 Language of Parts | Supports | The apps' own text is English. Teacher-written content in another language isn't marked with its language: there is no authoring control for it. |
| 3.2.3 Consistent Navigation | Supports | Each app's navigation is the same, in the same order, on every screen. |
| 3.2.4 Consistent Identification | Supports | The same components and labels are used for the same functions across the apps. |
| 3.3.3 Error Suggestion | Supports | Code review: validation messages say what to do, such as "Give the activity a title." |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports | Submitting a quiz asks for confirmation, and a term move confirms in a dialog. Not every submitting flow was reviewed. |
| 4.1.3 Status Messages | Supports | Every action exercised announced its outcome in a live region, and loading states are status regions. Not yet confirmed with a screen reader. |

Totals: 50 criteria. 39 Supports, 3 Partially supports, 0 Does not support, 8 Not applicable.

## Known gaps and follow-ups

| Issue | Gap |
|---|---|
| SCHO-379 | Text field, text area and combobox boundaries under 3:1 (1.4.11) |
| SCHO-380 | Kumo upstream: subtle, warning and placeholder text tokens, control rings and link hover colour, so `contrast.css` can go |
| SCHO-381 | Screen-reader testing of the critical flows with NVDA, JAWS, VoiceOver and TalkBack |
| SCHO-384 | Audit Cedar Valley's Clever portal, `/ai`, sign-in, LTI, invitations, the mobile app, Firefox and Safari. Run the audit in CI, and turn the pilot gate's accessibility todos into checks (they ask for WCAG 2.2 AA). |
| SCHO-385 | Link this report from the IT evaluation packet at /it |
| SCHO-125 | Kumo `Radio.Group` accessible name (upstream) |
| SCHO-389 | Not the district UIs: the educateos.io site's shared header scrolls the page sideways, and /security/ has contrast failures |

The pilot gate's accessibility criterion ([pilot-gate.md](pilot-gate.md)) stays NOT MET. Its tables
are generated from `packages/educateos-pilot-gate/src/criteria.ts`, whose accessibility checks are
todos naming SCHO-22 to SCHO-24. This audit runs in a browser, outside that suite, so it doesn't
turn them into tests. Wiring it in is part of SCHO-384.

## Re-running

```sh
pnpm --filter @educateos/demo exec playwright install chromium   # once
pnpm exec vp run -F @educateos/demo build
pnpm --filter @educateos/demo a11y                               # about six minutes
pnpm --filter @educateos/demo a11y --persona "English 9" --pass narrow --report-only
```

It writes to `/tmp/educateos-a11y` unless `--out` names another directory. Update this page and the
public report together when the results change.
