# Founding pilot playbook

- Status: Operator playbook, not yet run with a district.
- Issue: SCHO-366. Terms: [program.md](program.md).
- Audience: the EducateOS pilot lead and technical contact.

How we run a founding pilot from first email to the end-of-pilot review. Copy the templates into
the district's shared pilot folder (the district's choice of tool, not ours) so both sides edit the
same copy.

## Before kickoff

1. **First reply within one business day** of the email to hello@educateos.io. Ask for the
   identity provider, roster source, LMS and the school in mind, and offer times for the 20-minute
   IT walkthrough.
2. **IT walkthrough (20 minutes).** Architecture and data flow ([/it/](https://educateos.io/it/)),
   the token permissions, the readiness checklist, the data rule, and an honest answer on their
   systems from [maturity.md](../maturity.md) and the integrations page. Leave with the readiness
   checklist and the date the district expects to have it done.
3. **Pilot agreement and DPA.** Send the pilot agreement and the [DPA template](https://educateos.io/student-privacy/dpa/).
   Record whether a DPA is signed. If not, the pilot is synthetic or staff-only data, and the IT lead
   admits staff only in the Access policy.
4. **Guided install (about an hour on a call)** following
   [district-install.md](../runbooks/district-install.md): `doctor`, `plan`, fix preflight items,
   install, verify, delete the token. Confirm in writing which AI controls are in place in the
   install (the AI call guard, Hall Monitor screening, spending caps) and the AI cap the district
   chose. Note the release ID and instance ID in the issue log.
5. **Before any teacher signs in:** the IT lead and one champion teacher sign in successfully; an
   address outside the admitted domains is refused.

## Kickoff (week 1, 60 minutes)

Attendees: district sponsor, IT lead, school lead, champion teachers, EducateOS pilot lead and
technical contact.

| Time | Item | Owner |
| --- | --- | --- |
| 5 min | Introductions and roles | Pilot lead |
| 10 min | Why this pilot: the school's one or two problems worth solving | School lead |
| 10 min | What EducateOS is and is not today, and the data rule, read out | Pilot lead |
| 15 min | Success criteria: agree three to five, each with a target and a method ([worksheet](success-criteria.md)) | District sponsor |
| 10 min | Logistics: the weekly check-in slot, how to raise issues and safety concerns, the support target | Pilot lead |
| 10 min | Questions; schedule teacher training; send the baseline survey | All |

Leave with: the signed-off worksheet, the check-in slot in everyone's calendar, the baseline survey
sent, and teacher training booked (it can follow straight on).

### Teacher training (60 minutes, champion teachers)

1. Signing in, and what the data rule means in practice (no student names or work).
2. Building one thing each from their own planning: an agent for their course, a gadget, a quiz or
   practice set.
3. Approvals: what an agent can draft and what waits for them.
4. How to raise an issue, and what to do if something looks unsafe.
5. Fill in the baseline survey before leaving, if not done.

## Weekly check-in (weeks 2 to 9, 20 minutes)

Attendees: champion teachers and the pilot lead; school lead and IT lead when needed.

```text
Pilot check-in: <district>, week <n>, <date>
Present:

1. Since last week (5 min, each teacher in one line)
   - What did you make or do with EducateOS?
   - Rough time saved or lost this week (minutes):
2. What didn't work (5 min)
   - New issues -> issue log, with an ID
3. Issue log review (5 min)
   - Status changes since last week
   - Anything blocking a teacher right now?
4. Safety and data (2 min)
   - Any content, AI output or data concern? (If yes -> issue log, severity "safety")
5. Next week (3 min)
   - One thing each teacher will try
   - Actions, owner, due date
```

The pilot lead sends the notes the same day and records the self-reported time and who was active
for the success criteria.

## Issue log

One row per issue, kept by the pilot lead and visible to the district.

| ID | Date raised | Raised by (role) | Area | Severity | Description (no student data) | Tracker link | Status | Resolution and date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-01 | | | install / sign-in / AI / content / other | safety / blocking / annoying / idea | | SCHO-... | open / in progress / fixed / won't fix / explained | |

- **Safety** (an unsafe or inappropriate AI output, or any suspected data exposure): acknowledge the
  same business day, tell the district sponsor and IT lead, and do not close it until the district
  agrees it is resolved. It counts toward "zero unresolved safety escalations".
- **Blocking**: stops a teacher from doing their pilot work. Aim for a fix or workaround before the
  next check-in.
- Every issue that needs code gets a Kanbanger issue in the EducateOS project, linked in the log.

## Mid-point review (week 5, 30 minutes)

Attendees: district sponsor, school lead, IT lead, pilot lead.

1. Each success criterion: the number so far against its target. On track, at risk or off track.
2. The issue log: open safety and blocking issues.
3. What the teachers say: two or three quotes from check-ins, with permission.
4. Adjustments: change a criterion's method (not its target) only if both sides agree, and write it
   on the worksheet with the date.
5. Plan for weeks 6 to 9, and book the end-of-pilot review.

## End-of-pilot review (week 10, 45 minutes)

Before it: close the exit survey, total the numbers, and send a one-page draft review to the
district sponsor two days ahead.

1. Results against each success criterion, with the evidence and its source.
2. The issue log: what was fixed, what is still open and its plan.
3. Teacher feedback from the exit survey.
4. What it cost: the district's Cloudflare bill and AI spend for the pilot, from its own dashboard.
5. **The decision: keep, export or uninstall.** For export or uninstall, walk through
   [district-offboarding.md](../runbooks/district-offboarding.md) and book a call if the IT lead
   wants help.
6. The advisory council seat: who will take it, if anyone.
7. A reference: ask once, accept no without discussion, and get any approval in writing.

After it: send the final written review within five business days, update the Kanbanger pilot
issue, and file follow-up issues for anything still open.
