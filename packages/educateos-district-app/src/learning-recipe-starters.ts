// Starter recipes. These are proposals written by the EducateOS team. They are NOT
// educator-approved: each stays "unreviewed" in a class until that class's teacher previews it,
// optionally edits it and approves it, and no recipe works for students before then. A starter
// carries no canonical identifiers; approval pins the district's approved catalog item.
import { RecipeContent } from "./learning-recipe.ts";

const UNIT_RATE_ITEM = { frameworkKey: "ccss-math", code: "6.RP.A.3", label: "6.RP.A.3b", gradeLevels: ["06"], statementIncludes: "Solve unit rate problems including those involving unit pricing and constant speed" };
const UNIT_RATE_PREREQUISITES = [{ concept: "Divide quantities and label units" }, { concept: "Say what one unit of each quantity means (___ per one ___)" }];
const UNIT_RATE_COVERAGE = "Only component (b): unit pricing and constant-speed reasoning, pinned to 6.RP.A.3. Other components are not assessed, and a working project or generated code is not evidence of this standard.";
const UNIT_RATE_RUBRIC = ["Calculate each unit rate correctly and label the units", "Use a rate to predict a new quantity and state the constant-rate assumption", "Explain the comparison and solve an unseen unit-rate problem independently"];

/** The three worked steps every unit-rate recipe walks through, with the domain's own example. */
const unitRateSteps = (quantities: string, rateWords: string, example: string, scale: string) => [
  { title: "Name the quantities", instruction: `A unit rate tells how much of one quantity goes with one of another. Decide which quantity is on top and which one you want one of (${rateWords}).`, action: `Make a two-column table for your project options and label both quantities: ${quantities}.`, example, hints: ["Say the units aloud: ___ per one ___.", "Divide the amount by the matching count of the other quantity, and keep the units attached."] },
  { title: "Calculate and compare", instruction: "Divide each quantity by its matching amount. Compare rates only when they have the same units, then check by multiplying back.", action: "Calculate the rate for each option, label the units, and say which option fits your goal and why.", example: "A faster rate is only better if speed or cost per item is what your project needs. Multiply the rate back by the count to check.", hints: ["Write the division before doing the arithmetic.", "Scale a table down to one unit, then compare."] },
  { title: "Predict and test the assumption", instruction: "Multiply a unit rate by a new amount to predict. The prediction assumes the rate stays constant, so say when that might not hold.", action: "Predict a new quantity for each option and explain what could make the prediction wrong.", example: scale, hints: ["Your units should cancel: rate × amount gives the new quantity.", "A warm-up, a price change or a slowdown could break a constant-rate prediction."] },
];

const STARTERS: Array<{ id: string; content: unknown }> = [
  {
    id: "g6-unit-rate-game-production",
    content: {
      title: "Unit rates in a game production line",
      standard: UNIT_RATE_ITEM,
      interest: { domain: "game-production", label: "game production", anyOf: ["roblox", "tycoon", "minecraft", "game", "simulator"], alsoRequireAnyOf: ["pizza", "restaurant", "factory", "production", "oven", "shop", "store", "bakery", "farm", "business", "machine"], exclude: ["cheat", "hack", "exploit"] },
      whyNow: "A production game only feels fair when you can say how fast each machine really works. Unit rates let you compare machines and predict output before you build.",
      prerequisites: UNIT_RATE_PREREQUISITES,
      steps: unitRateSteps("amount made and minutes taken", "items per minute", "A practice oven makes 10 pizzas in 2 minutes. We want pizzas per minute, so divide pizzas by minutes: 5 per minute.", "At 5 pizzas per minute, 6 minutes gives 30 pizzas if the oven keeps the same rate."),
      studentTask: "In your game, compare two production options (for example two ovens or two upgrade paths). Record how much each makes and how long it takes, calculate each unit rate with units, predict output for a new time, and explain which option fits your game. Then solve a fresh unit-rate problem without help.",
      independentChallenge: "Practice independently: a printer makes 18 cards in 3 minutes and another makes 20 in 4 minutes. Compare their rates and predict each output in 7 minutes. Explain the units and assumptions. Your teacher selects a separate unseen problem for assessment.",
      transfer: { prompt: "Where else could you use a rate to choose between two options? Name a new setting, what stays the same and what you would change. Reflection alone does not prove transfer.", rubric: UNIT_RATE_RUBRIC },
      coverage: UNIT_RATE_COVERAGE,
    },
  },
  {
    id: "g6-unit-rate-basketball-practice",
    content: {
      title: "Unit rates in basketball practice",
      standard: UNIT_RATE_ITEM,
      interest: { domain: "basketball-practice", label: "basketball practice", anyOf: ["basketball", "free throw", "free throws", "layup", "layups", "three pointer"], alsoRequireAnyOf: ["practice", "drill", "drills", "train", "training", "improve", "better", "stats", "percentage", "faster", "tryout", "tryouts"], exclude: [] },
      whyNow: "Getting better at a skill means choosing the drill that gives you the most useful reps for your time. A rate shows which drill does that.",
      prerequisites: UNIT_RATE_PREREQUISITES,
      steps: unitRateSteps("shots made and minutes spent", "makes per minute", "In a drill you make 12 shots in 4 minutes. Divide makes by minutes: 3 makes per minute.", "At 3 makes per minute, a 20-minute practice gives 60 makes if your pace stays the same."),
      studentTask: "Time two of your own practice drills. Record the makes and minutes for each, calculate makes per minute with units, predict makes in a 20-minute practice, and explain which drill fits your goal. Then solve a fresh unit-rate problem without help.",
      independentChallenge: "Practice independently: in drill A you make 15 free throws in 5 minutes and in drill B 14 in 4 minutes. Find makes per minute for each and predict makes in 12 minutes. Explain the units and your assumption. Your teacher selects a separate unseen problem for assessment.",
      transfer: { prompt: "Name a different skill you practise. How could a rate help you choose how to spend your time, and what would you need to measure?", rubric: UNIT_RATE_RUBRIC },
      coverage: UNIT_RATE_COVERAGE,
    },
  },
  {
    id: "g6-unit-rate-baking-prices",
    content: {
      title: "Unit prices in baking and cooking",
      standard: UNIT_RATE_ITEM,
      interest: { domain: "cooking-baking", label: "baking and cooking", anyOf: ["bake", "baking", "cookie", "cookies", "cake", "brownies", "cooking", "recipe", "bake sale"], alsoRequireAnyOf: ["price", "prices", "cost", "cheaper", "batch", "sell", "sale", "budget", "bulk", "compare", "which", "serving", "servings"], exclude: [] },
      whyNow: "Deciding what to bake for a group or a sale depends on cost per item. A unit price lets you compare two offers fairly.",
      prerequisites: UNIT_RATE_PREREQUISITES,
      steps: unitRateSteps("price paid and items bought", "dollars per item", "A tray of 12 cookies costs $6. Divide dollars by cookies: $0.50 per cookie.", "At $0.50 per cookie, 30 cookies cost $15 if the price per cookie does not change."),
      studentTask: "Compare two real or realistic offers for your baking project (for example 12 cookies for $6 and 20 for $8). Calculate the cost per item, predict the cost of 30 at each rate, and explain which offer fits your goal. Then solve a fresh unit-price problem without help.",
      independentChallenge: "Practice independently: a 10-pound bag of flour costs $8 and a 25-pound bag costs $17. Find the cost per pound for each and the cost of 50 pounds at each rate. Explain the units and your assumption. Your teacher selects a separate unseen problem for assessment.",
      transfer: { prompt: "Name another purchase where two offers have different sizes. What would you compare and what could make the comparison unfair?", rubric: UNIT_RATE_RUBRIC },
      coverage: UNIT_RATE_COVERAGE,
    },
  },
  {
    id: "g6-argument-evidence-decision",
    content: {
      title: "An evidence-based argument about a real decision",
      standard: { frameworkKey: "ccss-ela", code: "W.6.1", label: "W.6.1", gradeLevels: ["06"] },
      interest: { domain: "argument-decision", label: "arguing for a decision", anyOf: ["argue", "argument", "persuade", "persuasive", "convince", "debate", "petition", "pitch", "proposal", "speech"], alsoRequireAnyOf: ["school", "class", "club", "team", "town", "city", "community", "rule", "rules", "policy", "should", "vote", "decision", "ban", "change"], exclude: ["fight", "fighting"] },
      whyNow: "You already want others to agree with you. A strong argument gives readers reasons and evidence they can check instead of just your opinion.",
      prerequisites: [{ concept: "Tell a claim from a fact" }, { concept: "Name who produced a source and what it supports" }],
      steps: [
        { title: "Make a decision worth explaining", instruction: "Choose a real decision. State one claim your audience could disagree with, then give a reason.", action: "Write your decision, audience, claim and one reason.", example: "Claim: our club should repair the old garden beds. Reason: repairing may use fewer materials than replacing them. This is a claim to investigate, not a verified fact.", hints: ["Complete: I think we should ___ because ___.", "Name a reader who might choose differently and the reason they would need."] },
        { title: "Find and connect evidence", instruction: "Find two credible sources. Record each author, title, date and the specific fact that supports your reason. Check that the source really supports your claim.", action: "Explain how each fact supports your claim and organise your reasons and evidence clearly.", example: "A materials list could support a claim about quantity. A friend's preference alone cannot. Do not invent quotations or citations.", hints: ["For each source ask: who knows this, how do they know, and what can I verify?", "Use: This evidence supports my reason because ___."] },
        { title: "Build the argument", instruction: "Link reasons and evidence with words such as because, therefore and however. Use a formal style and finish with a conclusion that follows from the argument.", action: "Draft and revise your argument, then read each criterion before sharing.", example: "Therefore, the evidence supports repairing these beds first. A conclusion follows from the evidence; it adds no unsupported fact.", hints: ["Underline your claim; circle each reason and its evidence.", "Read the conclusion beside the claim: do they agree?"] },
      ],
      studentTask: "Choose a decision in your project or community. Write a claim, support it with clear reasons and relevant evidence from two credible sources, connect reasons to your claim, use a formal style and write a conclusion. Then explain and defend your reasoning independently to your teacher.",
      independentChallenge: "Practice independently: choose a different decision, draft a claim with reasons and verifiable evidence, link them in a formal argument and conclude. Your teacher selects a separate unseen prompt for assessment.",
      transfer: { prompt: "Where else could you make a case with evidence? Name a new setting, what stays the same and what you would change. Reflection alone does not prove transfer.", rubric: ["State a claim and organise reasons and relevant evidence clearly", "Use credible sources, linking language, formal style and a conclusion", "Independently explain why the evidence supports the claim"] },
      coverage: "Argument writing only: claims, reasons, credible evidence, cohesion, formal style and a conclusion. A persuasive project, speech or generated text is not evidence of this standard on its own.",
    },
  },
  {
    id: "g7-fraction-rates-recipes-and-pace",
    content: {
      title: "Unit rates with fractions in recipes and pace",
      standard: { frameworkKey: "ccss-math", code: "7.RP.A.1", label: "7.RP.A.1", gradeLevels: ["07"], statementIncludes: "Compute unit rates associated with ratios of fractions" },
      interest: { domain: "fraction-rates", label: "recipes, gardens and pace", anyOf: ["recipe", "bake", "baking", "garden", "bike", "cycling", "hiking", "walking", "running", "model car"], alsoRequireAnyOf: ["half", "quarter", "third", "fraction", "fractions", "cup", "cups", "1/2", "1/4", "3/4", "per hour", "miles per hour", "pace", "speed", "scale", "double", "halve"], exclude: [] },
      whyNow: "Real quantities are often fractions of a unit. Finding the rate per whole unit lets you scale a recipe or predict how far you will travel.",
      prerequisites: [{ concept: "Divide fractions using equivalent ratios or reciprocals" }, { concept: "Say what one unit of each quantity means (___ per one ___)" }],
      steps: [
        { title: "Name the quantities", instruction: "Write the two quantities with their fractional amounts and decide which one you want one of.", action: "Make a two-column table for your project and label both quantities.", example: "A model car travels 1/2 meter in 1/4 second. We want meters per one second, so divide distance by time.", hints: ["Say the units aloud: ___ per one ___.", "Dividing by 1/4 asks how many quarters fit."] },
        { title: "Calculate and check", instruction: "Divide the fractions and keep the units. Check by multiplying the rate back by the time.", action: "Calculate the unit rate for your project and check your result.", example: "(1/2) ÷ (1/4) = (1/2) × 4 = 2 meters per second. Check: 2 × 1/4 = 1/2 meter.", hints: ["Write the division before doing the arithmetic.", "Multiply by the reciprocal, then check."] },
        { title: "Predict and test the assumption", instruction: "Multiply the unit rate by a new amount. The prediction assumes the rate stays constant, so say when it might not.", action: "Predict a new quantity for your project and name one thing that could change the rate.", example: "At 2 meters per second the car travels 6 meters in 3 seconds if its speed stays constant.", hints: ["Your units should cancel.", "A hill, a hot oven or a tired runner can change a rate."] },
      ],
      studentTask: "Use a quantity from your project that is a fraction of a unit (for example 3/4 cup per 1/2 batch or 1/2 mile in 1/8 hour). Compute the unit rate with units, predict a new quantity, and explain what could change the rate. Then solve a fresh fractional unit-rate problem without help.",
      independentChallenge: "Practice independently: a cyclist travels 3/4 mile in 1/8 hour. Find miles per hour and predict the distance in 1/2 hour. Label units and name your assumption. Your teacher selects a separate unseen problem for assessment.",
      transfer: { prompt: "Name a new setting where a fractional rate would help. What stays the same and what would you need to measure?", rubric: ["Compute a unit rate from fractional quantities with correct units", "Use the rate to predict a new quantity and state the constant-rate assumption", "Explain the result and solve an unseen fractional-rate problem independently"] },
      coverage: "Unit rates with ratios of fractions only. This does not claim the whole proportional relationships domain.",
    },
  },
];

/** The starter recipes, validated at import so a malformed one cannot ship. */
export const STARTER_RECIPES: ReadonlyArray<{ id: string; content: RecipeContent }> = STARTERS.map((s) => ({ id: s.id, content: RecipeContent.parse(s.content) }));
