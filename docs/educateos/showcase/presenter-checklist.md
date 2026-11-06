# Presenter checklist

- Issue: SCHO-327. For the [investor](investor-walkthrough.md) and
  [educator](educator-walkthrough.md) walkthroughs.

## The day before

- [ ] Run the investor walkthrough once, end to end, on the machine you will present from.
- [ ] Have the fallback video on the presenting machine, not only on a shared drive
  ([Fallback video](#fallback-video)).
- [ ] If you will show the live district, check your presenter identity is linked to the persona
  you need ([Live district](#live-district-northfieldeducateosio)). Relinking takes a minute and an
  administrator's cookie; don't leave it to the meeting.

## Browser

- [ ] Chrome or Edge, current version. Safari and Firefox work, but read-aloud voices differ and
  the rehearsal used Chromium.
- [ ] A clean profile or a guest window: no extensions over the page, no bookmarks bar, no other
  tabs with student or personal data.
- [ ] Window at 1280x800 or larger. The demo was rehearsed at 1280x800 (projector), 820x1180
  (tablet) and 390x844 (phone). On a phone the banner and tour strip take about a quarter of the
  screen, so present from a laptop.
- [ ] Zoom 100%. For a large room, 110% to 125% still fits every tour screen; check step 2 (the
  teacher's submission list) and step 6 (the gradebook) at your zoom.
- [ ] Allow the microphone for `educateos.io` (step 1 records). Turn system sound on if you will
  use **Read to me**; the voice is the browser's own.
- [ ] Light theme unless you have checked yours: the header's theme button switches it for every
  persona.
- [ ] Do Not Disturb on; notifications off.

## Opening the demo

- [ ] Open `https://educateos.io/demo/?presenter` a few minutes before. The picker shows in about
  a second; the district is ready (tour button enabled) in about 4 seconds on a laptop, and up to
  15 seconds on a slow machine or network.
- [ ] Press `?` to check presenter mode: keys `1` to `9` open tour steps, `→` and `←` step
  through. Keys do nothing while the cursor is in a text field: click the page background first.
- [ ] Leave it on the picker, with Northfield selected.

## Reset state

- **Reset demo** (top right) boots a fresh district in about 2 seconds, clears the tour and
  "Things to try", and needs no network.
- Reloading the page also starts over, but it needs the network to fetch the page again.
- Nothing is kept once the tab closes, and nothing a visitor does reaches anyone else. Reset
  between audiences anyway, so the next one sees unhanded work and unshared feedback.
- Things done in one persona stay for the others until reset: if you handed in Mateo's retelling or
  shared Priya's feedback, the next run shows them done.

## Network fallback

- Once the demo has loaded, it makes no network requests: the whole district runs in the tab. If
  the venue network drops mid-meeting, carry on, and use **Reset demo** rather than reloading.
- Load it before you leave for the meeting, and keep the tab open.
- If the network is down before you load it: tether to a phone (the page is about 850 KB
  compressed, cached for a year after the first visit), or play the fallback video.

## Fallback video

- `investor-walkthrough.webm`: the investor walkthrough recorded on the deployed demo at 1280x800,
  with captions and no sound, 5 minutes 37 seconds. It plays in Chrome, Edge and Firefox, and in
  VLC. Talk over it as you would over the live demo.
- The video and the Playwright script that records it (`video.mjs`, which follows this walkthrough
  and overlays the captions) are kept with the meeting materials, not in the repository. Re-record
  after a demo change by rerunning the script against `https://educateos.io/demo/`.
- The 2026-11-05 set (SCHO-343) is kept the same way, with the meeting materials and not on
  educateos.io or in the repository: a 3:29 K-12 walkthrough, a clip for each grade band, the AI
  tutors (pilot preview, synthetic students), open courses, the installer and a 31-second teaser.
  Each is 1920x1080 (the teaser 1280x720) with burned-in captions, as MP4 (H.264) and WebM (VP9),
  with a WebVTT file and a poster.

## Known rough edges

From the 2026-11-02 rehearsal ([README](README.md#rehearsal-findings-2026-11-02)), rechecked on the
deployed demo on 2026-11-05 at 1280x800:

- Tour steps 5 (Chidi) and 7 (Amara) stop at the tutor and **My work**, not at **Grade and
  feedback**, which is about two screens further down. Scroll to it on cue.

## Live district: northfield.educateos.io

Use only when the audience needs to see a real deployment or real AI. Everything there is
persistent and shared with the co-op, so do nothing you would not want the next presenter to find.

- Sign-in is Cloudflare Access with the agents.gmac.io test identities (`teacher@`, `student@`,
  `guardian@`, `admin@`). Sign in from a terminal with
  `node scripts/access-sign-in.ts https://northfield.educateos.io/ <address>` in agent-inbox; never
  type an identity's code on a projected screen.
- Each identity is one showcase persona at a time. Link it to the band you will show before the
  meeting, following [demo-districts.md, "The K-12 showcase"](../runbooks/demo-districts.md#the-k-12-showcase-scho-326)
  step 5 (suggested personas per band are in its table). To switch bands, relink, then sign out of
  the Workshop at `/ai` and back in so its session follows.
- `link` answering `409` means that identity is one of the co-op's own people: present with another.
- The LMS is at `/`, the Workshop with real AI at `/ai`. Student tutors are a pilot preview on
  synthetic identities only, and their enablement is tracked on SCHO-325: check it before showing a
  student's tutor live.
- After the meeting, unlink presenters you linked only for it (`link --persona none`), as in the
  runbook's Reset section.
