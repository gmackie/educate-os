# Outreach email templates

- Status: Living document.
- Date: 2026-11-14
- Issue: SCHO-405 (related: SCHO-366, the founding pilot)

Templates for reaching districts about the [founding pilot](https://educateos.io/pilot/). Fill
every `[bracket]`, and delete any sentence you can't make true for that reader.

Rules for every email:

- **Send from, and reply to, hello@educateos.io**, or a named person's address that copies it.
- **Keep it short.** A technology director reads the first two lines on a phone.
- **Only say what [maturity.md](../maturity.md) supports.** Reuse the status wording from the briefs and
  the templates. Never write "compliant", "certified" or "proven in districts".
- **No booking link exists yet.** Ask for a reply with two times that work. Don't invent a
  calendar link.
- **No student information**, ever, in either direction. Ask readers not to send any.
- **Mention a partner organisation only if it's true.** Don't imply that TCEA, MACUL, an Education
  Service Center or an intermediate school district endorses EducateOS. They don't.
- **Attach or link one brief, not four.** Pick the one that matches the reader:
  - [superintendents and boards](https://educateos.io/pilot/brief/superintendents/)
  - [principals](https://educateos.io/pilot/brief/principals/)
  - [teachers](https://educateos.io/pilot/brief/teachers/)
  - [district IT](https://educateos.io/pilot/brief/it/)

## 1. Cold email to a district technology director

**Subject:** AI for teachers, run in [District]'s own Cloudflare account (free pilot)

> Hi [First name],
>
> Teachers at most districts are already using AI tools nobody reviewed. We're building
> EducateOS, an open-source (Apache-2.0) learning platform whose AI runs in the district's own
> Cloudflare account. Every AI call goes through district policy, screening and a spending cap,
> and student records stay with you.
>
> We're looking for three to five public districts in [Texas / Michigan] for a free, ten-week
> founding pilot: one school, a few champion teachers, AI for teachers only, and synthetic or
> staff-only data until a DPA is signed. We run the install with your team on a call. You pay
> Cloudflare directly, about $5 a month plus small usage for a pilot.
>
> To be straight about where we are: it runs today on demo districts, and no district has
> installed it yet. Your district would be among the first.
>
> Would a 20-minute walkthrough with you be useful? If so, reply with two times that work.
> One-page brief for IT: https://educateos.io/pilot/brief/it/
>
> [Name]
> EducateOS · hello@educateos.io · https://educateos.io/pilot/

## 2. Follow-up (one week later, no reply)

**Subject:** Re: AI for teachers, run in [District]'s own Cloudflare account (free pilot)

> Hi [First name],
>
> A short follow-up. If it's easier to look before talking, the public demo runs in the browser
> with a fictional district, no sign-up: https://educateos.io/demo/
>
> The three things IT teams usually ask first:
>
> - **Where the data lives:** in your Cloudflare account. We don't receive student records.
> - **What the install needs:** Workers Paid, a domain, Cloudflare Zero Trust with your identity
>   provider, and an API token you create and delete.
>   https://educateos.io/it/ has the exact permissions.
> - **How it ends:** keep it, export everything as open JSON, or uninstall.
>
> If now isn't the time, say so and I won't write again this term.
>
> [Name]

Send at most one follow-up. If there's no reply, stop.

## 3. A note through TCEA or a Texas Education Service Center

For a contact you already know at TCEA, or a digital learning or technology coordinator at one of
the Texas Education Service Centers. Ask them to pass it on. Don't ask them to recommend it.

**Subject:** A free AI-for-teachers pilot for Texas districts, if any of yours are looking

> Hi [First name],
>
> We're running a small founding pilot of EducateOS, an open-source learning platform with AI
> built in, for three to five public districts in Texas and Michigan. It's for districts that
> want to give teachers AI tools but keep control: it runs in the district's own Cloudflare
> account, every AI call goes through district policy and a spending cap, and student records
> stay with the district.
>
> The pilot is free: one school, a few champion teachers, about ten weeks, teacher-facing AI only,
> and synthetic or staff-only data until a DPA is signed. If the district uses the Texas student
> data privacy agreement, we'd start from that.
>
> If any districts in [Region / your network] are asking about AI for teachers, would you be
> willing to pass this on? The one-page brief for district leaders is at
> https://educateos.io/pilot/brief/superintendents/ and the full terms are at
> https://educateos.io/pilot/.
>
> It's early: it runs on demo districts today, and the pilot districts will be the first real
> installs. I'm happy to walk you through the demo first.
>
> [Name]
> EducateOS · hello@educateos.io

## 4. A note through MACUL or a Michigan intermediate school district

For a contact you already know at MACUL, or an instructional technology or data privacy
contact at a Michigan ISD or RESA. Same rule: ask them to pass it on, not to endorse it.

**Subject:** A free AI-for-teachers pilot for Michigan districts

> Hi [First name],
>
> We're inviting three to five public districts in Michigan and Texas to a free, ten-week founding
> pilot of EducateOS, an open-source learning platform with AI built in. It runs in the
> district's own Cloudflare account. Teachers get course agents and small classroom apps, and
> every AI call goes through district policy, screening and a spending cap.
>
> The pilot is one school, a few champion teachers and AI for teachers only. Student data stays
> out until a DPA is signed. If the district uses the Michigan student data privacy agreement,
> we'd start from that.
>
> If a district in [ISD / your network] is weighing AI for teachers, would you pass this on? The
> brief for district leaders: https://educateos.io/pilot/brief/superintendents/. The terms:
> https://educateos.io/pilot/.
>
> To be clear about where we are: it runs on demo districts today, with no district installs yet.
>
> [Name]
> EducateOS · hello@educateos.io

## 5. Post-meeting recap

Send the same day. Repeat what was agreed, not what was hoped for.

**Subject:** EducateOS: notes from today and next steps for [District]

> Hi [First name],
>
> Thank you for the time today with [names and roles]. My notes, so we have the same picture:
>
> **What you're hoping to solve:** [their words, for example "teachers spending evenings on
> differentiated practice sets"].
>
> **Your systems:** sign-in through [identity provider], roster from [Clever / ClassLink /
> OneRoster / SIS / none], LMS [Canvas / Schoology / Google Classroom / none]. How ready EducateOS
> is for each:
>
> - [For example: Canvas: passed live LTI runs against a current Canvas; no 1EdTech certification
>   is claimed.]
> - [For example: Clever sign-in: running against Clever's live sandbox; roster sync not needed
>   for a teachers-first pilot.]
>
> **What we said we'd do:** [for example, send the pilot agreement and the DPA template by
> Friday; confirm in writing which AI controls are on before any teacher signs in].
>
> **What you said you'd check:** [for example, whether the district already has a Cloudflare Zero
> Trust plan; who the school lead would be].
>
> **Open questions:** [anything we didn't answer, and when we'll answer it].
>
> For people who weren't in the room: the one-page briefs are at
> https://educateos.io/pilot/#briefs and the full terms are at https://educateos.io/pilot/.
>
> [Name]
> EducateOS · hello@educateos.io

Log the meeting and every promise you made in it the same day.
