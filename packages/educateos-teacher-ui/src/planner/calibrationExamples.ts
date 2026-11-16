/** Synthetic discussion anchors, not validated scoring keys or live student work. Teacher UI only. */
export const calibrationExamples: Record<string, { check: string; met: string; developing: string; scope: string }> = {
  "6.RP.A.3b": {
    check: "Common check: a tap fills 24 liters in 6 minutes; another fills 30 in 10. Compare liters/minute and predict each output after 15 minutes. Explain the assumption.",
    met: "4 L/min and 3 L/min; 60 L and 45 L after 15 minutes. The first is faster if flow stays constant. Observe the learner explain division and units independently.",
    developing: "24 ÷ 6 = 4 and 30 ÷ 10 = 3, but predicts 19 and 18 liters by adding 15. Rate calculation alone does not meet the prediction criterion.",
    scope: "Game production, basketball practice and cooking prices use the same unit-rate reasoning. This checks component (b), not the entire 6.RP.A.3 standard. Compare against this opportunity's exact criteria.",
  },
  "W.6.1": {
    check: "Common check: give every learner the same two teacher-verified source extracts about repairing or replacing garden beds, including authors, dates and costs. Ask for an independent formal argument choosing an option.",
    met: "A clear claim, organized reasons, accurate evidence traced to both supplied sources, an explanation connecting evidence to the claim, linking language, formal style and a conclusion following the argument. Verify these in actual excerpts; this checklist is not a learner response.",
    developing: "We should repair because it is better. Everyone agrees. This offers a claim but no verifiable evidence or reasoning. Polished wording or AI-generated prose does not establish independent argument writing.",
    scope: "A game proposal, basketball decision or cooking choice can practise argument. The common source packet and independent check allow comparison across paths. Sources must be real and verified by the teacher; do not invent citations.",
  },
};
