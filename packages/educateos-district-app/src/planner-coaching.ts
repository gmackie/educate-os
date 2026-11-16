import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";

/** Student-controlled moves; no free-form chat or requirement to answer a tutor's questions. */
export const PlannerCoachAction = z.enum(["show", "hint", "next", "try", "reflect"]);
/** Immutable instructional content, distinct from an assessment and from a learner response. */
export const PlannerLesson = z.strictObject({
  version: z.literal(1),
  prerequisites: z.array(z.string()),
  coverage: z.string(),
  steps: z.array(z.strictObject({ title: z.string(), instruction: z.string(), action: z.string(), example: z.string(), hints: z.array(z.string()).min(1).max(3) })).min(1).max(4),
  challenge: z.string(),
  transfer: z.string(),
});
/** Persisted, bounded help provenance. Text drafts and reflections are never stored here. */
export const PlannerCoaching = z.strictObject({
  lesson: PlannerLesson,
  step: z.number().int().nonnegative(),
  mode: z.enum(["instruction", "independent", "reflection"]),
  hints: z.number().int().nonnegative().max(3),
  events: z.array(z.strictObject({ action: PlannerCoachAction, at: z.iso.datetime(), source: z.enum(["curriculum", "governed-ai"]) })).max(40),
  guidance: z.string().optional(),
  aiStatus: z.enum(["not-requested", "not-wired", "consent-revoked", "policy-denied", "budget-denied", "invalid-output", "provider-unavailable", "used"]).optional(),
  source: z.enum(["curriculum", "governed-ai"]).default("curriculum"),
});
/** A learner's practice challenge, explicitly shared separately from the project response. */
export const PlannerChallenge = z.strictObject({
  text: z.string().trim().min(1).max(10000),
  reflection: z.string().trim().min(1).max(2000),
  assistance: z.enum(["independent", "adult", "peer", "ai", "unknown"]),
  startedAt: z.iso.datetime(), sharedAt: z.iso.datetime(),
  helpEvents: z.number().int().nonnegative(),
  source: z.literal("student-practice"),
});

/** Creates a functioning curriculum lesson without a model or network dependency. */
export function plannerLesson(code: string): z.infer<typeof PlannerLesson> {
  const writing = code.startsWith("W.");
  const gradeSeven = code === "7.RP.A.1";
  return {
    version: 1,
    prerequisites: writing ? ["Distinguish a claim from a fact", "Identify who produced a source and what it supports"] : ["Divide quantities and label units", ...(gradeSeven ? ["Divide fractions using equivalent ratios or reciprocals"] : [])],
    coverage: writing ? "Argument writing: claims, reasons, credible evidence, linking language, formal style and conclusion. Teacher review still checks every criterion." : gradeSeven ? "Unit rates with ratios of fractions. This does not claim the entire proportional relationships domain." : "Only component (b): unit pricing and constant-speed reasoning, pinned to 6.RP.A.3. Other components are not assessed.",
    steps: writing ? [
      { title: "Make a decision worth explaining", instruction: "Choose a real decision in your project. State one claim your audience could disagree with, then give a reason.", action: "Write your decision, audience, claim and one reason.", example: "Claim: our club should repair the old garden beds. Reason: repairing may use fewer materials than replacing them. This is a claim to investigate, not a verified fact.", hints: ["Complete: I think we should ___ because ___.", "Name a reader who might choose differently and the reason they would need."] },
      { title: "Find and connect evidence", instruction: "Find two credible sources. Record each author, title, date and the specific fact supporting your reason. Check whether the source actually supports your claim.", action: code === "W.7.1" ? "Explain how each fact supports your claim, then acknowledge an opposing claim and respond with evidence." : "Explain how each fact supports your claim; organize the reasons and evidence clearly.", example: "A materials list could support a claim about quantity. A friend's preference alone cannot establish the quantity. Do not invent quotations or citations.", hints: ["For each source ask: who knows this, how do they know, and what can I verify?", "Use: This evidence supports my reason because ___. Use however to introduce an alternative."] },
      { title: "Build the argument", instruction: "Link reasons and evidence with words such as because, therefore and however. Use a formal style. Finish with a conclusion that follows from the argument.", action: "Draft and revise your argument. Read each evidence-contract criterion before sharing.", example: "Therefore, the evidence supports repairing these beds first. A conclusion follows from the evidence; it does not add an unsupported fact.", hints: ["Underline your claim; circle each reason and its supporting evidence.", "Read the conclusion beside the claim: do they agree, and have you supported both?"] },
    ] : [
      { title: "Name the quantities", instruction: "A unit rate tells how much of one quantity goes with one of another. Decide which quantity belongs on top and which is the unit you want one of.", action: "Make a two-column table for your project options and label both quantities.", example: gradeSeven ? "A model car travels 1/2 meter in 1/4 second. We want meters per one second, so divide distance by time." : "A practice machine makes 10 tiles in 2 minutes. We want tiles per minute, so divide tiles by minutes.", hints: ["Say the units aloud: ___ per one ___.", "For cost per item, divide dollars by items; for items per minute, divide items by minutes."] },
      { title: "Calculate and compare", instruction: "Divide each quantity by its corresponding amount. Compare rates with the same units. Check the result by multiplying back.", action: "Calculate both project rates, label units, and explain which option fits your goal.", example: gradeSeven ? "(1/2) ÷ (1/4) = (1/2) × 4 = 2 meters/second. Check: 2 × 1/4 = 1/2 meter." : "10 ÷ 2 = 5 tiles/minute. Check: 5 × 2 = 10 tiles. A faster rate is useful only if speed matters to the project.", hints: ["Write the division before doing arithmetic. Keep the units attached.", gradeSeven ? "Dividing by 1/4 asks how many quarters fit. Multiply by 4, then check." : "Scale the table down to one minute or one item, then compare."] },
      { title: "Predict and check assumptions", instruction: "Multiply a unit rate by a new amount. This prediction assumes the rate stays constant. State when that assumption might fail.", action: "Predict a new quantity for each project option and explain the assumption.", example: gradeSeven ? "At 2 meters/second, the car travels 6 meters in 3 seconds if its speed stays constant." : "At 5 tiles/minute, 6 minutes gives 30 tiles if the machine keeps the same rate.", hints: ["Your units should cancel: tiles/minute × minutes = tiles.", "A startup delay or changing speed could make constant-rate predictions inaccurate."] },
    ],
    challenge: writing ? "Practice independently: choose a different decision, draft a claim with reasons and verifiable evidence, link them in a formal argument and conclude. For grade 7 also address an opposing claim. Your teacher will select a separate unseen prompt for assessment." : gradeSeven ? "Practice independently: a cyclist travels 3/4 mile in 1/8 hour. Find miles per hour and predict distance in 1/2 hour. Label units and check your assumption. Your teacher selects a separate unseen problem for assessment." : "Practice independently: a printer makes 18 cards in 3 minutes and another makes 20 in 4 minutes. Compare rates and predict each output in 7 minutes. Explain units and assumptions. Your teacher selects a separate unseen problem for assessment.",
    transfer: "Where else could you use this idea? Name a new setting, explain what stays the same, and what you would need to change. Reflection alone does not prove transfer.",
  };
}

/** Bounded state machine: help can be requested directly; practice never becomes mastery. */
export function advancePlannerCoach(state: z.infer<typeof PlannerCoaching>, action: z.infer<typeof PlannerCoachAction>, at: string): void {
  if (state.events.length >= 40) throw new EducateOsError("conflict", "This coaching session is full. You can still share your work or start a new plan.");
  if (action === "reflect" && state.mode !== "independent") throw new EducateOsError("conflict", "Try the independent challenge before reflecting.");
  if (action === "next") {
    if (state.mode !== "instruction" || state.step >= state.lesson.steps.length - 1) throw new EducateOsError("conflict", "Choose Try myself to begin independent practice.");
    state.step++; state.hints = 0;
  }
  if (action === "try") { state.mode = "independent"; state.guidance = state.lesson.challenge; }
  else if (action === "reflect") { state.mode = "reflection"; state.guidance = state.lesson.transfer; }
  else {
    if (state.mode !== "instruction") throw new EducateOsError("conflict", "Help is closed during this independent attempt. Start a new opportunity to practice with help.");
    const step = state.lesson.steps[state.step]!;
    if (action === "hint") {
      state.guidance = step.hints[Math.min(state.hints, step.hints.length - 1)];
      state.hints = Math.min(state.hints + 1, 3);
    } else state.guidance = `${step.instruction}\n${step.example}\nYour turn: ${step.action}`;
  }
  state.source = "curriculum";
  state.events.push({ action, at, source: "curriculum" });
}
