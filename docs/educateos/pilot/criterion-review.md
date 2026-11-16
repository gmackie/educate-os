# Criterion-level teacher reconfirmation (SCHO-435)

Non-deploying WIP stacked on PR #417, baseline `fb262fbd232e2707e407b395c4176340d79d32f1`.
No live student data, model grading, merge or deployment is part of this work.

## The gap and the change

Previously an independent check recorded a task/context, timestamp and overall teacher assertion,
but no criterion-level evidence. Teacher Studio now places shared project work, disclosed assistance,
independent practice and separate common-check observations together. The teacher rates every
criterion of the **existing pinned evidence contract**, recording a source excerpt for each.
A recommendation requires exactly that contract ID/version, every criterion exactly once, all rated
`met`, independent assistance, an independent practice challenge and the existing time/context rules.
The server checks completeness and binding. It does not interpret, score or grade free text.

No new rubric registry, identity layer or store is added. Approved learning recipes already pin
transfer criteria into the opportunity's versioned evidence contract; those are the criteria reviewed.
An edit/new recipe version creates a new contract on a new opportunity. The existing catalog release
URI/version/digest and recipe approval checks still run before a new recommendation. Review cannot
replace the standard or change the contract. These advisory judgments never enter the gradebook.

## Historical judgments

Old review JSON remains valid and readable through the same routes and stores. Reading never
rewrites, deletes or upgrades it. A legacy recommendation without criterion observations is shown as
**Needs criterion-level reconfirmation** in the planner and standards evidence drill-down. Trusted
knowledge reports `needsCriterionReconfirmation: true`; coverage no longer counts it as newly verified
independent evidence. The original recommendation, rationale, reviewer and time remain visible.
The teacher explicitly appends a reconfirmation or a hold/withdrawal. Nothing backfills `met` ratings.

## Educator rehearsal before a pilot

1. Use invented learners. Approve the actual district standards release and the appropriate recipe
   for the class. Check the standard statement, grade, subject, scope and transfer criteria first.
   `6.RP.A.3b` remains component (b) of the real `6.RP.A.3` item, not an invented CASE item.
2. Two educators open **Learning planner → Calibrate with a synthetic common check**. Independently
   discuss which observations would meet each exact criterion. Use the developing rate-prediction
   example and the unsupported argument example to identify disagreement. Agree on evidence needed;
   the software neither resolves disagreement nor certifies calibration. Anchors are draft rehearsal
   material, not educator-validated scoring keys. Writing needs teacher-verified source extracts.
3. Offer game production, basketball or cooking paths voluntarily. Use the same underlying unit-rate
   criteria and equivalent independent common checks across paths. Do not require an interest match;
   a learner can skip or choose another path. An assisted project remains practice, even if polished.
4. Ask the learner to share only the selected task evidence and disclose assistance. Private goals,
   matched goal words, coaching and chats stay out of the teacher view. Teachers must not transcribe
   private material into the check. Teacher observations are visible to the learner and authorized
   class teachers, so include only the minimum relevant excerpt, with a page/source reference.
5. After the independent practice challenge, administer a separate unseen task without AI, peer or
   adult hints. Choose a fresh equivalent form if a learner has seen the displayed anchor. Record
   task/context, time, observed assistance and each criterion's actual observed excerpt. Default
   ratings are **Not observed**. Missing evidence means no recommendation. A developing criterion
   can be saved with **Hold**. Record a complete check before saving criterion observations.
6. A teacher alone decides whether to recommend. Inspect the history for the criterion descriptions,
   ratings, excerpts, contract version, source, reviewer ID and observation/review times. A rationale
   explains the judgment. Change it with another review, or enter a rationale and choose **Withdraw
   recommendation**; both preserve earlier history. Withdrawal remains possible after a recipe or
   standard is withdrawn. Stale tabs must reload instead of overwriting another teacher's review.
7. Retention still needs another independently reviewed demonstration at least seven days earlier;
   transfer needs a prior demonstration in a different context. Both need new observed criterion
   evidence. Time passing, repeating a project or naming a new context cannot supply missing evidence.

K–5 model restrictions, student agency, optional CASEL practice (never therapy or diagnosis), consent
and district/class role authorization are unchanged. No model is called by the rubric review flow.

## Limits and verification

Synthetic API/UI tests establish contract validation, privacy boundaries, persistence compatibility,
reconfirmation/withdrawal and timing behavior. They cannot establish that a teacher's attestation is
true, that an unseen prompt is equivalent, that excerpts fairly represent reasoning, or that learning
transfers. All-met is a necessary evidence floor, not automatic proof or a grade. There is no automated
text judgment, inter-rater reliability score, psychometric calibration or live-school validation.

Before a real pilot, educators must validate the common forms and sources, test accommodations and
accessibility with users, rehearse independent ratings and resolve differences, obtain district/privacy
approval, and evaluate pre/post/delayed learning. No school outcomes or measured reliability are claimed.
