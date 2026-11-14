# Success criteria worksheet

- Status: Template. Copy it per district at kickoff.
- Issue: SCHO-366. Run with: [playbook.md](playbook.md).

The district sponsor, school lead and EducateOS pilot lead agree three to five criteria at kickoff.
Each has a target and a measurement method, and both are written down before anyone starts. We
review against them at week 5 and week 10. A method may change mid-pilot only if both sides agree,
and the change is dated here. Targets do not move.

## The worksheet

District: ____________  School: ____________  Kickoff date: ________  Signed off by: ____________

| # | Criterion | Target | How it's measured | Source | Week 5 | Week 10 | Met? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |

Method changes (date, criterion, change, agreed by):

## Example criteria for teacher-facing AI

Pick the ones that fit the school's problems worth solving, and set targets that the district
thinks would justify continuing. The targets below are only illustrations.

| Criterion | Example target | How it's measured | Where the number comes from |
| --- | --- | --- | --- |
| Teacher time saved per week | A median of 60 minutes a week by weeks 6 to 9 | Each champion teacher's estimate of minutes saved or lost that week, asked at each check-in; compared with the baseline survey's planning hours | **Teachers (self-reported).** The product cannot measure time saved. |
| Champion teachers active each week | At least 75% of champion teachers active in 6 of the 8 classroom weeks | A teacher is active in a week if they signed in and made or used something | **Product, partly.** Sign-ins per person are in the district's Cloudflare Access logs (Zero Trust, Logs). That they made something comes from the check-in. |
| Classroom materials created and used | At least 20 assignments, quizzes or gadgets used with students across the pilot | A tally kept at check-ins: what was made and whether it was used in class | **Teachers (tallied at check-ins).** With the district LMS installed, the admin console's district health shows counts of artifacts and installed activities, but not which were used with students. |
| AI use stays within the cap | AI spend under the district's monthly cap every month, with no unplanned stop | The month's AI spend against the cap | **Product.** The AI provider's billing, and AI Gateway logs if the district turned it on. What the AI call guard reports depends on which AI controls are in the install (confirmed at install). |
| Teacher satisfaction | An average of 4 out of 5 or better on "I would want to keep using EducateOS" | The exit survey ([surveys.md](surveys.md)) | **Survey.** |
| Would recommend to a colleague | At least half the champion teachers answer 4 or 5 | The exit survey | **Survey.** |
| Zero unresolved safety escalations | No safety issue open at the end-of-pilot review | The issue log: every issue marked "safety" is resolved and the district agrees | **The issue log (kept by people).** There is no in-product safety-review workflow yet; Hall Monitor screens model calls, but escalations are tracked in the log. |
| Staff-only data held | No student data entered before a DPA is signed | Asked at each check-in; any lapse is a safety issue | **Teachers and the IT lead (self-reported).** |
| IT effort | Install and verification done in one call, and under two hours of IT time a month after | The IT lead's estimate at the mid-point and final reviews | **IT lead (self-reported).** |

## Notes on the numbers

- **Nothing here comes to us automatically.** EducateOS runs in the district's account, and its
  logs, usage and bills are the district's. The IT lead reads them and shares the totals, never
  names or content.
- **Self-reported numbers are estimates.** Ask the same question the same way each week, and
  report a median, not a single teacher's figure.
- **Small numbers.** With three to six teachers, one person's week moves a percentage a lot. Write
  targets as counts where that is clearer.
