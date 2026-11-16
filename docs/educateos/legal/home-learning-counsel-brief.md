# Counsel brief: home learning for families (K–2)

> **This is not legal advice.** Engineers wrote this brief to put precise questions to counsel about
> a feature that is already running for one family. It describes what the software does and keeps,
> as built on 2026-11-15, and offers no view on how the law applies. Nothing here should be relied on
> as a legal conclusion until counsel answers.

- Decision record: [ADR-0016](../adr/0016-community-installations-and-home-learning.md). Product
  guide: [home-learning.md](../home-learning.md). Operations: [community-instances.md](../runbooks/community-instances.md).
- Requested from: counsel for the EducateOS project.
- Answer needed by: before any family other than the operator's own uses a community installation,
  and before any community is offered to the public.
- Current exposure: one installation (`safranek.educateos.io`) admits only the project owner, who is
  also the parent of the children practicing on it.

## What it is

- **Home learning** is short reading and number practice for children aged roughly 5 to 8
  (kindergarten to second grade). A parent chooses activities; the child practices on a parent's
  device; the parent reviews what the child did.
- It runs in a **community installation**: one deployment of EducateOS per learning community (a
  family, a homeschool co-op, a library program), on Cloudflare, in the project owner's Cloudflare
  account today. There is no school involved and no school record.
- **Who has an account.** Only adults. An adult signs in through Cloudflare Access (an emailed
  one-time code), then joins the community. Children never sign in and have no account, email or
  identifier outside the family's record.
- **Who decides who joins.** The installation's Access policy lists who may sign in. A community may
  admit anyone who signs in (`open`), require an organizer's approval, or add people by invitation.
- **Organizers** administer the installation. The software gives them no way to read any family's
  children or practice; only the family's own adults can.

## What is kept, where, and for how long

| Data | About | Where | Kept until |
|---|---|---|---|
| Adult's sign-in identifier (Access subject, a random UUID) and the name they typed | Each adult | The installation's Durable Object (Cloudflare, pinned to the US jurisdiction) | The adult deletes their account from Family settings, or the installation is offboarded |
| Family name, adults' names as shown to each other, a hashed 4–8 digit PIN, the read-aloud setting, and which notice version each adult accepted and when | The family | Same | The family deletes itself |
| Child's display name or nickname, chosen avatar (from 12 emoji), grade band (K, 1 or 2), starting activity per subject | Each child | Same | The child is removed, or the family deleted |
| Practice queue and saved practice: which activity, which items, each answer tapped, whether a hint or "ask my grown-up" was used, timestamps; a parent's corrections | Each child | Same | **Deleted automatically 2 years after the session started** (Safranek's setting), or earlier when the family removes the child or deletes the family |
| A parent's shelf: titles, links and notes they add | The family | Same | The family removes them |
| Child-session token (digest only) and invitation tokens (digest only) | The device / invitee | Same | A child session: deleted a day after it ends, or 30 days after it started. An invitation: when used or revoked, or within an hour after it expires |
| Policy decision audit: who read or changed which family record, when, by which rule | Each adult's actions | Same | **Deleted automatically on the same schedule as practice** (2 years). Decisions about anything other than family records stay, append-only |

Not collected: birth date, age in years, school, photo, voice or audio (oral reading is recorded only
as the adult's choice of "on their own", "with help" or "not yet"), location, contacts, device
identifiers for the child, advertising or analytics identifiers. Product analytics is off for
community installations.

**Third parties.** Cloudflare hosts and processes all of it (Workers, Durable Objects, Access). The
child's screen reads directions and words aloud with the **browser's built-in speech synthesis**.
Depending on the browser and voice, that text may be sent to the browser or OS vendor's speech
service. The text is the activity's own content (directions, a word, a story), never anything the
child typed or said. No AI model is used in home learning.

**Export and deletion.** Any adult of the family can download everything kept for the family (JSON,
without the PIN hash), remove a child with all their practice, delete the family, or delete their
own account (which deletes the family too if they are its only adult).

**Notice and read-aloud.** Every adult reads and accepts the notice below before starting or joining
a family; which version they accepted, and when, is kept. When the wording changes, every adult is
asked again. A family can turn read-aloud off in Family settings.

## Questions

1. **COPPA.** Is the project, or a community's organizer, an "operator" collecting personal
   information from a child under 13, given that (a) only adults hold accounts and type the child's
   details, (b) the child's activity on the device is limited to tapping answers inside a session
   the adult started, and (c) the stored data is a nickname, an emoji, a grade band and answers?
   If it is, what consent mechanism suffices when the consenting parent is the account holder who
   entered the data?
2. **Who is the operator.** For a community installation in the project owner's account, run for
   another community, who is responsible to families: the project, the community's organizer, or
   both? Does that change if the installation moves to the community's own Cloudflare account (the
   model ADR-0013 describes for districts)?
3. **State law.** Which state student- or child-privacy laws (for example, ones covering education
   technology used outside schools, or biometric and children's privacy laws) apply to a family in
   Illinois (the first family's time zone is Central), and to families elsewhere?
4. **Retention.** Is two years from each session a defensible period for practice records? Should
   the audit log entries about a family, and adult sign-in identifiers, be purged on the same
   schedule or when the family is deleted?
5. **Notice.** Is the draft notice below sufficient, where must it be shown (sign-up, family setup,
   settings), and does an adult need to affirmatively accept it?
6. **Invitations.** An invited second adult gets the same access to the children's records as the
   inviter. Is the inviter's choice enough, or does the software need anything more (for example,
   notifying every adult when one joins, or handling custody disputes)?
7. **Browser speech.** Does reading activity text aloud through the browser's speech service need
   disclosure, given no child-provided content is sent?
8. **Content claims.** The content is labelled "awaiting educator review" and the product avoids
   mastery or learning-gain claims. Are the current wording and labels enough to avoid misleading
   parents?

## Draft notice for families (for counsel to edit)

As shown today (version `2026-11-16`, in `packages/educateos-home-learning/src/notice.ts`), on
Safranek:

> **Your family's information.**
>
> Only your family's grown-ups can see your children's practice. Children don't have accounts; a
> grown-up signs in and hands over the device.
>
> We keep each child's nickname, the picture they picked, a starting grade, the activities you
> choose, and the answers they tap. We don't collect birth dates, photos, recordings or locations.
>
> Practice is deleted automatically 2 years after it happened, and so is the record of who looked
> at it.
>
> You can download everything, delete a child, delete your family, or delete your account at any
> time from Family settings.
>
> Reading aloud uses your browser's own voice, which may send the activity's words (never your
> child's answers) to your browser's speech service. You can turn reading aloud off in Family
> settings.
>
> This installation is run by Safranek Family. [Contact, once `homeLearning.contact` is set.]

It is shown to read on the community sign-up page, then with an "I've read this and agree" checkbox
when an adult sets up a family or joins one by invitation, and to any adult who accepted an older
version before any family page. It is always readable in Family settings.

## Built ahead of the answers (2026-11-16)

Each is built so that an answer changes a setting or the wording, not the design:

- The notice is shown and accepted at family setup and on joining, with the version and time
  recorded; a new version asks every adult again (questions 5 and 1).
- An adult can delete their own account and sign-in identifier (question 4).
- Audit entries about family records, and spent tokens, are purged on schedule (question 4).
- A family can turn off read-aloud (question 7).

- The notice is shown at community sign-up, before anything is entered (question 5).
- When an adult joins, every adult already in the family sees "<name> joined your family" on Today,
  with a pointer to remove them, until they dismiss it (question 6). This is in-app only: the
  installation keeps no adult's email address and sends no email.

Still open: anything counsel's answers add, such as email notice of a join or custody handling.

## Sign-off

| Question | Counsel's answer | Date |
|---|---|---|
| 1–8 | | |

Counsel's review is recorded here and in ADR-0016's consequences when answered. Until then, the
installation stays limited to the owner's own family.
