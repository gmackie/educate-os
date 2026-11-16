# ADR-0016: Community installations and parent-managed home learning

- Status: Accepted
- Date: 2026-11-15
- Plan: [K–2 family learning](../../plans/2026-11-15-k2-family-learning.html)
- Builds on [ADR-0012](0012-guardians-and-dated-roles.md) (guardians), [ADR-0013](0013-educateos-open-core-control-plane.md)
  (installations in the owner's own Cloudflare account) and [ADR-0014](0014-one-origin-per-district.md)
  (one origin).

## Context

We want parents of children in kindergarten to second grade to run short, structured reading and
number practice at home, choose what their child practices, and see what their child can do. The
first audience is families on their own, not families of a school: nothing waits for a school to
assign work or confirm a guardian.

EducateOS assumed a school district in four places that block this:

1. **Who can be a principal.** Every principal is created by a roster, a district administrator, or
   an administrator approving a guardian's invitation. A parent can't sign up.
2. **What a guardian may do.** ADR-0012 makes a guardian read-only: a catch-all rule denies every
   guardian write, so a parent can't manage anything.
3. **Who a child is.** A student is a principal with a sign-in identity. A five-year-old practicing
   on a parent's tablet has no account and should not need one.
4. **Who operates the installation.** A district installs EducateOS into its own Cloudflare account.
   A family can't be expected to.

## Decision

1. **A community is an installation.** A learning community (a homeschool co-op, a library, a
   parent group, a tutoring center) gets its own dedicated EducateOS installation, deployed exactly
   as a district's is (ADR-0013, ADR-0014): its own Cloudflare account, its own origin, its own
   Durable Object. Its directory has no schools, terms or classes. One or more organizers hold
   `district-admin`. There is no shared multi-family runtime, so ADR-0001's rule that an
   organization's data lives in its own account holds unchanged.

2. **Home learning is turned on per installation.** `DISTRICT_CONFIG.homeLearning` is
   `{ signup: "open" | "approval" | "invite-only" }`. Absent, the family and learner routes answer
   `not-found` and nothing else changes; a school district can leave it off. The installation's
   Cloudflare Access policy still decides who can reach it at all; `open` admits everyone that
   policy admits.

3. **A parent is a guardian principal created by sign-up.** `onboarding.joinCommunity` makes a
   verified sign-in that is nobody's principal a `guardian` with no relationship to any student. In an
   `approval` community it records a pending identity link instead, which an organizer approves
   through the existing identity-link flow (`admin.familySignups` lists them). ADR-0003's identity
   rules are unchanged: a sign-in is linked by issuer and subject, never by email.

4. **Family authority is membership of a family, never a school relationship.** Two new resource
   kinds, `family` and `home-practice`, both `personal-private`, are reached only through a new
   `family-adult` relationship that reads stored family membership on every decision. Two rules sit
   *before* the guardian rules: `family.adult.create` (a guardian may start a family; the service
   allows one per adult) and `family.adult.manage`. ADR-0012's catch-all still follows them, so no
   school rule can reach a family adult, and no family rule can reach a school record: a guardian of
   a school student gains nothing in that student's records by having a family, and a family adult
   gains nothing in any school's. Both kinds are excluded from delegation. Community organizers have
   no rule over either kind: a family's practice is the family's.

5. **A child is a learner profile, not a principal.** A learner (`lrn_…`) belongs to one family and
   holds a display name, an avatar from a fixed set, a grade band used only to suggest a starting
   point, and a starting point per track. No birth date, school, photo or sign-in identity.

6. **A child practices inside a child session that only the server can end.** An adult starts one
   for a learner; the server returns it as an `HttpOnly`, `Secure`, `SameSite=Strict` `__Host-`
   cookie and stores only the token's SHA-256 digest. While a valid child session cookie is on a
   browser, every route except practice (`learner.*`) and `me.get` is refused for that browser,
   whatever the page tries. It ends only by:
   - the family PIN (4–8 digits, PBKDF2-SHA-256, 100,000 iterations, five failures lock it for 15
     minutes), entered on that device; or
   - an adult of the family ending every child session from another device (a forgotten or locked
     PIN, a lost tablet).

   Requests are still authorized as the adult who started the session: the session narrows what the
   adult's sign-in may do on that browser; it grants nothing. A cookie another adult started is
   ignored, and a device served as a principal (`/api/m/*`) never carries one.

7. **Content is reviewed data shipped with the release.** `@educateos/home-learning` ships versioned
   packs (reading foundations; number sense and the number line) as typed, strictly parsed data
   with deterministic items whose expected answers the tests recompute. A pack version never
   changes once shipped; a session pins the version it started from. OCS courses (ADR-0011) are
   the wrong shape: their portable exports may not carry answers, and they install as teacher-graded
   class assignments. Packs carry a `review` record, and the library tells parents when a pack is
   still awaiting educator review.

8. **Evidence is structured, scored on the server, and corrected without being rewritten.** A
   practice response records each try, whether a hint or an adult's help was used, and where the
   evidence came from (`captured`, `adult-presented` for sounds an adult said, `adult-observed` for
   oral reading an adult listened to). The server scores it from the pinned item, never from the
   client's claim. Saves are idempotent by a client request ID. An adult may correct or exclude a
   response; the original is kept beside the correction. Progress is derived on every read, never
   stored.

9. **Progress states describe practice, not mastery.** `Not tried`, `Practicing with help`,
   `Practicing independently` (at least 5 of the 6 most recent assessed responses right on the
   first try without help, across at least two days) and `Ready to revisit` (independent, then three
   weeks without practice). Strands stay apart: listening comprehension is never reported as word
   reading, and spelling never as decoding. No state claims a skill is secure or mastered; that needs
   an educator-reviewed rule this ADR doesn't make.

10. **Families keep and remove their own data.** A family adult can export everything kept for the
    family (except the PIN hash) as JSON, remove a child with all their practice, or delete the
    family. Families' home learning is excluded from the organizer's district export. The app
    records no audio: oral reading is an adult's observation.

## Consequences

- A community deploys with `authority: "local"`, an Access policy that admits the families it
  serves (for example email one-time PIN for anyone, for an `open` community), and
  `homeLearning` in `DISTRICT_CONFIG`. The installer and the guided install don't yet have a
  "community" template; [home-learning.md](../home-learning.md) lists the settings by hand.
- The public school manifest (`/.well-known/educateos.json`) is unchanged: the mobile app parses its
  feature keys strictly. The web app learns home learning from `me.get` (`homeLearning`) and, before
  sign-up, from `onboarding.community`.
- Up to four adults per family. An adult invites another by a single-use, week-long link; every
  adult has the same access (amended 2026-11-15). Whether more is needed for custody disputes is a
  question in the [counsel brief](../legal/home-learning-counsel-brief.md).
- Child sessions are web-only. The phone app's device tokens act as the adult with no child session.
- The packs are drafts. Before a community offers them as reviewed content, a qualified reviewer
  checks the scope and sequence, the phoneme guide, decodability and distractors, and the pack
  records that review.
- `homeLearning.retentionDays` deletes practice sessions older than the period, hourly; Safranek
  keeps two years (amended 2026-11-15). Community installations pin storage to the US
  jurisdiction (ADR-0015).
- Amended 2026-11-16, ahead of counsel's answers, so each answer changes a setting or wording
  rather than adding a feature:
  - **Notice.** Every adult accepts a versioned family notice (`FAMILY_NOTICE_VERSION`, the
    counsel brief's draft with the installation's name, retention and optional
    `homeLearning.contact`) before starting or joining a family. Changing its wording bumps the
    version, and each adult is asked again before any family page.
  - **Account deletion.** An adult deletes their own account from Family settings: they leave the
    family, or delete it as its last adult, and their guardian principal, with its sign-in
    identifier, leaves the directory. Only a guardian nothing else in the directory names can.
  - **Audit retention.** The policy audit trail stays append-only, enforced by its trigger, except
    for decisions about `family` and `home-practice` resources, which the hourly job deletes once
    older than `retentionDays`. Decisions about anything else can't be deleted by any statement.
  - **Spent tokens.** The hourly job also deletes child sessions a day after they end (or once
    their 30-day cookie has expired) and expired invitations.
  - **Join news.** Each adult already in a family is told, in the app, who joined after them,
    until they dismiss it. The newcomer sign-up page shows the notice before anything is entered.
  - **Read-aloud.** A family turns the practice screen's read-aloud off in Family settings; items
    that need a spoken word then show the grown-up what to say.
