# Home learning content review packet

For a qualified reviewer: an early-literacy specialist for **Reading foundations**, and an
early-mathematics specialist for **Number sense and the number line**. Both packs ship as version
1.0.0 with `review.status: "draft"`, and the library shows parents "Awaiting educator review" until a
reviewed version replaces them. Packs are data in
`packages/educateos-home-learning/src/content/` (`reading.ts`, `math.ts`); a parent-facing summary
is in [home-learning.md](home-learning.md).

The engineer's audit below is **not** a review. It lists what automated checks guarantee, what a
read-through found, and the decisions only a reviewer can make.

## What the tests already guarantee

`packages/educateos-home-learning/__tests__/content.test.ts`, on every build:

- Every item's stored answer is recomputed from the item (sounds counted, letters spelled, jumps
  made, groups compared) and must match.
- Every word a child is asked to read or build uses only letters taught by that activity, or a heart
  word taught by then.
- A reading item's prompt and hint never say the word or sentence the child is asked to read.
- Heart words are taught before any sentence uses them.
- Each check activity's items differ from every practice item of the same skill.
- Every choice list holds its answer once and has distinct choices.

## Scope and sequence

### Reading foundations 1.0.0

| # | Activity | Skill (strand) | Taught by then | Mode |
|---|---|---|---|---|
| 1 | Count the sounds | phonemic.count-sounds (phonemic awareness) | oral | practice |
| 2 | Blend the sounds | phonemic.blend-sounds (phonemic awareness) | oral, adult says sounds | practice |
| 3 | Listen to a story | listening.stories (listening comprehension) | read aloud | practice |
| 4 | Build words: s a t i p n | spell.set-1 (spelling) | s a t i p n | practice |
| 5 | Read words: s a t i p n | decode.set-1 (decoding) | s a t i p n | practice |
| 6 | Heart words: the, a, is, I | heart-words.set-1 | + 4 heart words | practice |
| 7 | Read sentences | text.set-1 (connected text) | set 1 + heart words 1 | practice |
| 8 | Build words: c e h r m d | spell.set-2 | + c e h r m d | practice |
| 9 | Read words: c e h r m d | decode.set-2 | sets 1–2 | practice |
| 10 | Check: read words | decode.set-2 | sets 1–2, fresh words | check |
| 11 | Heart words: to, he, was, of | heart-words.set-2 | + 4 heart words | practice |
| 12 | Read sentences | text.set-2 | sets 1–2, heart words 1–2 | practice |
| 13 | Build words: g o u l f b | spell.set-3 | + g o u l f b | practice |
| 14 | Read words: g o u l f b | decode.set-3 | sets 1–3 | practice |
| 15 | Check: read words | decode.set-3 | fresh words | check |
| 16 | Check: build words | spell.set-3 | fresh words | check |
| 17 | Read sentences | text.set-3 | sets 1–3, heart words 1–2 | practice |
| 18 | Read aloud to your grown-up | text.oral-reading | adult-observed | practice |
| 19 | Listen to a story | listening.stories | read aloud | practice |

The letter order follows the first three groups of a widely used synthetic-phonics sequence
(s a t i p n; c/k e h r m d; g o u l f b), with `k` left out. Grade starts: K at 1, grade 1 at 4,
grade 2 at 12.

### Number sense and the number line 1.0.0

| # | Activity | Skill | Mode |
|---|---|---|---|
| 1 | Count to 5 | count.within-10 | practice |
| 2 | Count to 10 (includes zero) | count.within-10 | practice |
| 3 | More or fewer? | compare.within-10 | practice |
| 4 | One more, one less | count.one-more-less | practice |
| 5 | Find numbers on the line (0–10) | line.place-10 | practice |
| 6 | Jump forward (add) | line.add-10 | practice |
| 7 | Jump back (subtract) | line.subtract-10 | practice |
| 8 | Check: jump forward | line.add-10 | check |
| 9 | Check: jump back | line.subtract-10 | check |
| 10 | Find numbers to 20 | line.place-20 | practice |
| 11 | Jump forward within 20 | line.add-20 | practice |
| 12 | Jump back within 20 | line.subtract-20 | practice |
| 13 | Check: jump forward within 20 | line.add-20 | check |
| 14 | Check: jump back within 20 | line.subtract-20 | check |

Grade starts: K at 1, grade 1 at 5, grade 2 at 10.

## Engineer's read-through: findings for the reviewer

Each is a question, not a change: a reviewed version (1.0.1 or 1.1.0) makes the changes the reviewer
agrees with. Version 1.0.0 has shipped and is never edited.

**Pictures and words**

1. `tap` uses 🚰 ("a tap"). Many US children say "faucet". Keep, replace (for example `nap`/`pan`
   only), or add the word to the adult guide?
2. `pit` uses 🕳️ ("a pit"): reads as "hole". Replace?
3. `ten` uses 🔟, which shows the numeral: a child may match by number knowledge instead of
   decoding. Replace with a picture of ten objects, or drop?
4. `red` uses 🟥 and `hot` uses 🥵: abstract. Acceptable for a check item?
5. `sad`/`mad` use 😢/😠 with 👨 in sentences: emotion emoji differ across platforms. Acceptable?
6. Emoji render differently on Apple, Google and Windows devices. Is emoji acceptable for picture
   choices at all, or should reviewed versions ship drawn images?

**Phonics and heart words**

7. `a` is taught as a heart word. Some programs treat it as decodable (short a) with a schwa note.
   Keep?
8. `is` is a heart word because `s` says /z/. Keep, or teach `s`=/z/ explicitly?
9. `blend-sounds` and `count-sounds` include `fish` (/f/ /i/ /sh/) and `frog` (4 sounds, a
   blend). They are oral only, but is a digraph and a consonant blend right this early?
10. Phoneme models come from the adult reading the guide; there are no recordings. Is the adult
    guide's advice on clipped sounds ("not 'muh'") enough, or are recordings a prerequisite?
11. Distractors in `read-word` differ by one sound from the target, but pictures of untaught words
    (for example `pen` before `e`) appear as distractors. The child never reads them; confirm this
    is acceptable.

**Connected text and comprehension**

12. Sentences are matched to pictures: this checks meaning, not fluency. Is the adult-observed
    read-aloud activity enough for oral reading at this level?
13. Listening stories use vocabulary above decoding level on purpose (shivering, purring). Are the
    questions literal enough for K, and should there be inferential questions in later versions?

**Math**

14. The number line counts jumps, and the hint warns against counting the starting mark. The
    progress page names that mistake when it repeats. Is the wording to parents right?
15. Subtraction is only "jump back". Should take-away with objects precede it for K?
16. Compare items show emoji groups up to 10 per side without a ten-frame arrangement. Should
    groups be arranged in fives?
17. Zero appears only in "Count to 10" (an empty tray). Enough exposure?

**Progress rules (shared)**

18. "Practicing independently" means at least 5 of the 6 most recent responses right on the first
    try without help, on at least two different days. Is that a reasonable threshold to show
    parents, given it is explicitly not a mastery claim?
19. "Ready to revisit" after 21 days without practice. Reasonable?

## Reviewer checklist

For each pack, the reviewer records:

- [ ] Scope and sequence is sound for the grade bands claimed (K–2), or the claim is narrowed.
- [ ] Every activity's preview, directions, example and adult guide is accurate and age-appropriate.
- [ ] Every item: correct answer, unambiguous picture, fair distractors (findings 1–6, 11).
- [ ] Phonics: correspondences, heart-word treatment and phoneme guidance (findings 7–10).
- [ ] Connected text and listening items (findings 12–13).
- [ ] Math representations and progression (findings 14–17).
- [ ] Progress rules and parent-facing wording (findings 18–19).
- [ ] No claim of diagnosis, mastery or learning gain anywhere a parent reads.

## Recording the review

1. The reviewer's decisions on each finding are written into a new pack version (`version` bumped,
   content changed as agreed) with `review: { status: "reviewed", scope: "<what was checked>",
   reviewer: "<role, never a personal name>", reviewedOn: "<date>" }`.
2. The new version is added to `PACKS` beside 1.0.0, which stays so existing sessions still resolve.
3. The library then offers the reviewed version, and the "Awaiting educator review" banner goes
   away for that pack.

## Sign-off

| Pack | Version reviewed | Reviewer (role) | Date | Outcome |
|---|---|---|---|---|
| Reading foundations | | | | |
| Number sense and the number line | | | | |
