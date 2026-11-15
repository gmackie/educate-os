# EducateOS school sales kit

- Status: Living document.
- Date: 2026-11-14
- Issue: SCHO-405 (related: SCHO-366, the [founding pilot](../pilot/README.md))

Material to take into district and school meetings about the
[founding pilot](https://educateos.io/pilot/): three to five public districts in Texas and Michigan,
one school and a few champion teachers each, about ten weeks, free software and a guided install,
teacher-facing AI first, and synthetic or staff-only data until a DPA is signed.

This is the school-facing kit. It is not the investor pitch deck, and nothing in this folder is
published on educateos.io. The leave-behinds below are published, from `sites/educateos-io`.

## What's here

| File | What it is | When to use it |
| --- | --- | --- |
| [meeting-deck.html](meeting-deck.html) and `meeting-deck.pdf` | 13 slides for a 30-minute district or school meeting. Self-contained: open it in a browser and use the arrow keys, or print it (landscape Letter, one slide per page). | The meeting itself. Fill in slide 1's placeholders first. |
| [demo-script.md](demo-script.md) | A 20-minute walk-through of [educateos.io/demo](https://educateos.io/demo/) with exact clicks per persona, a 5-minute version and a backup plan for bad wifi. | The demo part of the meeting (slide 8). |
| [objections.md](objections.md) | Honest answers to the likely objections: Canvas or Google already, AI safety, student data, support, "what if you disappear", cost, accessibility, IT capacity. | Before every meeting, and for written follow-ups. |
| [outreach-emails.md](outreach-emails.md) | A cold email to a technology director, one follow-up, notes through TCEA or a Texas ESC and through MACUL or a Michigan ISD, and a post-meeting recap. | Getting the meeting, and after it. |

## The leave-behinds (published)

One printable page for each person with a say. Each is a page on educateos.io with a PDF beside it,
and all four are linked from [/pilot/#briefs](https://educateos.io/pilot/#briefs) and from the
matching audience page.

| Audience | Page | PDF | Also linked from |
| --- | --- | --- | --- |
| Superintendents and school boards | [/pilot/brief/superintendents/](https://educateos.io/pilot/brief/superintendents/) | [PDF](https://educateos.io/pilot/brief/superintendents/educateos-brief-superintendents.pdf) | /leaders/ |
| Principals | [/pilot/brief/principals/](https://educateos.io/pilot/brief/principals/) | [PDF](https://educateos.io/pilot/brief/principals/educateos-brief-principals.pdf) | /schools/ |
| Teachers | [/pilot/brief/teachers/](https://educateos.io/pilot/brief/teachers/) | [PDF](https://educateos.io/pilot/brief/teachers/educateos-brief-teachers.pdf) | /teachers/ |
| District IT | [/pilot/brief/it/](https://educateos.io/pilot/brief/it/) | [PDF](https://educateos.io/pilot/brief/it/educateos-brief-it.pdf) | /it/ |

Sources are `sites/educateos-io/public/pilot/brief/<audience>/index.html`, styled by
`public/assets/brief.css`, which fits each to one US Letter page when printed. The integration
status chips and the cost figures in them are stamped by the site build from
`assets/integration-status.json` and `assets/cost-to-run.json`, like every other page.

## Rebuilding the PDFs

After changing a brief or the deck:

```sh
node sites/educateos-io/build.mjs --pdf    # needs Google Chrome; set CHROME to use another Chromium
```

This prints the district overview, the four briefs (served from `public/` on a local port, with
analytics never served) and `meeting-deck.pdf`. Check each brief is still one page.

## Rules for everything in this kit

- **Every claim matches [maturity.md](../maturity.md).** Say built, harness-tested or planned, in
  those words, and update the kit in the PR that changes the evidence.
- **Never "compliant" or "certified".** EducateOS is designed to support FERPA, COPPA and state
  obligations; no certification, third-party audit or 1EdTech certification is claimed.
- **Say the hard parts first:** no real students use EducateOS, no district has run the installer
  in its own account, there are no references yet, and screen-reader testing hasn't been done.
- **The demo has no AI.** Its tutor is scripted. Say so.
- **One contact:** hello@educateos.io. There is no booking link yet; ask for two times instead.
- **Never name a district** publicly, or to another district, without its written approval.

## Still needed from the owner

- A booking link for the 20-minute IT walkthrough, if we want one in place of "reply with two times".
- Named people for the pilot lead and technical contact roles, for slide 1 and the pilot agreement.
- Real contacts at TCEA, the Texas ESCs, MACUL and the Michigan ISDs before templates 3 and 4 are used.
