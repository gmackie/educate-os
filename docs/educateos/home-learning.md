# Home learning for families (K–2)

Short, structured reading and number practice that a parent chooses, a child does, and the parent
can review. It runs in a **community installation**: a dedicated EducateOS installation for a
learning community (a homeschool co-op, a library program, a parent group), deployed like a
district's. The decisions behind it are in [ADR-0016](adr/0016-community-installations-and-home-learning.md);
the product plan is [K–2 family learning](../plans/2026-11-15-k2-family-learning.html).

## What families get

| Who | Where | What |
|---|---|---|
| A newcomer | Learning Home, first sign-in | Joins the community (open sign-up) or asks to (approval). |
| A parent | `/family/home` (Today) | Each child's next activities, a suggestion per track, the last session's note, and **Hand over to …**. |
| | `/family/library` | Both packs in teaching order: preview, adult guide, minutes, and **Add for …** per child. Draft packs say so. |
| | `/family/learners/:id/plan` | Reorder, pause, resume and remove a child's activities. Saved practice is never changed. |
| | `/family/learners/:id/progress` | Each skill's practice state with the counts behind it, then recent sessions with a note. |
| | `/family/learners/:id/sessions/:id` | Item by item: what was asked, every try, hints, help, the evidence source. Correct or exclude a response; the original is kept. |
| | `/family/shelf` | Books, links, worksheets and notes. Never practice, never evidence. |
| | `/family/home-settings` | Add and remove children, invite and remove grown-ups, change the PIN, end practice on every device, turn read-aloud off, read the family notice, download everything, delete the family, delete your account. |
| A child | anywhere, while a child session is open | Only their queued activities: spoken directions, a worked example, one item a page, large targets, a hint, **Ask my grown-up**, calm retries. |

The child's screen offers a tap or keyboard route for everything: counters are added with a button,
letter tiles are tapped in order, and the number line moves a frog one jump at a time (or the child
taps a mark). Directions and words are read aloud by the browser's speech; letter sounds are not,
because browser speech is not a reliable model of an isolated sound. Where an item needs sounds, the
adult guide tells the grown-up what to say, and the evidence is marked as adult-presented. Oral
reading is recorded by the adult's choice (on their own, with help, not yet); nothing is recorded or
listened to by the app.

## Content

`packages/educateos-home-learning/src/content/` holds two packs, version 1.0.0, both **drafts
awaiting educator review**:

- **Reading foundations.** Count and blend sounds (oral); three letter sets in a common published
  order (s a t i p n; c e h r m d; g o u l f b), each with building (spelling) and reading
  (decoding) practice; heart words (the, a, is, I; to, he, was, of) with their irregular parts named
  in the adult guide; decodable sentences; reading aloud to an adult; and short listening stories,
  reported as listening comprehension and never as word reading. Checks with fresh items follow sets
  2 and 3.
- **Number sense and the number line.** Count to 5 and to 10 (including zero), compare groups, one
  more and one less, place numbers on a line to 10 and to 20, and addition and subtraction as
  jumps within 10 and within 20, each with a check.

`__tests__/content.test.ts` recomputes every answer, checks that every word a child reads or builds
is spelled only with letters taught by then (or is a taught heart word), that a reading item never
says the word it asks the child to read, that heart words are taught before sentences use them, and
that checks use items no practice activity of the same skill uses.

A pack version never changes once shipped. To change content, add a new version to `PACKS` and keep
the old one: sessions pin the version they were started from. When a qualified reviewer has checked
a version, set its `review` to `reviewed` with the reviewer's role and date.

## Evidence and progress

Each saved response keeps every try, whether the hint or a grown-up's help was used, and where the
evidence came from. The server scores it from the pinned item; the screen's own feedback uses the
same scoring code but is never what is stored. Progress is recomputed on every read:

| State | Rule |
|---|---|
| Not tried | No assessed response for the skill. |
| Practicing with help | Tried, but the next rule isn't met. |
| Practicing independently | At least 5 of the 6 most recent responses right on the first try with no hint or help, on at least two different days. |
| Ready to revisit | Was practicing independently, then nothing for 21 days. |

These describe practice. None of them says a skill is mastered, and no learning gain should be
claimed from them, or from time spent.

Mistakes worth naming are recorded as patterns: on the number line, counting the starting mark as a
jump (6 + 3 → 8) or jumping the wrong way; in spelling, the right letters in the wrong order.

## Setting up a community installation

There is no community template in the installer yet. Configure a district installation as follows:

1. **Directory seed** (`DISTRICT_CONFIG.directory`): the community's name, time zone and trusted
   issuer (the Access team), no schools, and the organizers as `staff` principals with
   `district-admin` at the district scope. [`educateos-fixtures/src/willowcreek.ts`](../../packages/educateos-fixtures/src/willowcreek.ts)
   is an example.
2. **`DISTRICT_CONFIG.authority`**: `"local"`. There is no roster.
3. **`DISTRICT_CONFIG.homeLearning`**: `{ "signup": "open" }`, `"approval"` or `"invite-only"`.
4. **Cloudflare Access**: a policy that admits the families the community serves. For `open`
   sign-up that is everyone who completes the login method (for example email one-time PIN);
   `allowedEmails` suits a small invited group.
5. With `approval`, organizers review **Family sign-ups** (`GET /api/admin/family-signups`) and
   approve each with `admin.approveIdentityRequest`.

Organizers have no access to any family's practice. A family's data is excluded from the
installation's district export; each family exports its own.

## Running it locally

```sh
pnpm educateos:community            # Willow Creek on 127.0.0.1:4810, with the Rivers family seeded
EDUCATEOS_DISTRICT_URL=http://127.0.0.1:4810 pnpm --filter @educateos/student-ui dev
```

Open `http://localhost:5181/?token=…` with a token the first command prints. The Rivers family's PIN
is 2468. A newcomer's token shows the sign-up page.

## Tests

| What | Where |
|---|---|
| Content rules, scoring, service, isolation, PIN lock, idempotent saves, progress | `packages/educateos-home-learning/__tests__/` |
| Routes, sign-up modes, child-session enforcement over HTTP | `packages/educateos-district-app/__tests__/home-learning.test.ts` |
| Durable Object storage, resume after eviction | `packages/educateos-district-worker/__tests__/home-learning-store.test.ts` |
| Parent and child screens | `packages/educateos-student-ui/__tests__/home-learning.test.tsx` |

## More grown-ups and retention

Any adult of a family can invite another from Family settings: a single-use link, valid for a week,
whose token travels in the link's fragment (never in a server log). The invitee must also be
admitted by the installation's Access policy. Joining gives the same view and controls as every
other adult. An adult can remove another, or leave, but never the last one; the removed adult's
child sessions end.

`DISTRICT_CONFIG.homeLearning.retentionDays` (30–3650) makes the hourly district job delete practice
sessions started longer ago than that, and the audit trail's decisions about family records
(`family`, `home-practice`) older than that. The trail's trigger refuses any other delete. The same
job deletes child sessions a day after they end, or once their 30-day cookie has expired, and
expired invitations. Family settings states the period. Safranek keeps practice for 730 days.

## Notice, read-aloud and account deletion

- **Notice.** `src/notice.ts` holds the family notice and its version. An adult accepts it when
  setting up a family or joining one; an adult who accepted an older version sees it before any
  family page (`family.acceptNotice`). It names the installation (the directory's district name),
  its retention period and, if set, `DISTRICT_CONFIG.homeLearning.contact`. Change the wording, then
  bump `FAMILY_NOTICE_VERSION`.
- **Read-aloud.** On by default; any adult turns it off in Family settings (`family.readAloud`).
  Off, the practice screen speaks nothing, hides its "Hear" buttons, and where an item needs a
  spoken word or story, shows the grown-up what to say behind "Grown-up: what to say".
- **Account deletion.** `family.deleteAccount` removes the adult from their family (or deletes it, as
  its last adult), then removes their guardian principal and sign-in identifier from the
  directory. Signing in again starts over as a newcomer.

## Reviews

- Content: [home-learning-content-review.md](home-learning-content-review.md) (packet, engineer's
  audit, checklist, sign-off). Packs stay labelled draft until a named reviewer role signs off.
- Legal: [legal/home-learning-counsel-brief.md](legal/home-learning-counsel-brief.md) (data
  inventory, questions, draft family notice). Until counsel answers, community installations admit
  only the operator's own family.

## Not yet

- Child sessions on the phone app.
- Reviewed packs, recorded phoneme models, and later patterns (digraphs, final e, vowel teams).
- Adult-reviewed adaptation of shelf items into practice.
- A family pilot: see [pilot/home-learning-pilot.md](pilot/home-learning-pilot.md).
