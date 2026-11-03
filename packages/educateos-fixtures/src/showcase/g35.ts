// 3-5: Grade 4 English Language Arts, Grade 4 Mathematics and Grade 5 Science at Northfield
// Elementary.
import { rubric } from "./rubrics.ts";
import type { ShowcaseCourse } from "./types.ts";

const ABENA = "prn_nf-student-abena";
const DIEGO = "prn_nf-student-diego";
const HANA = "prn_nf-student-hana";
const OMAR = "prn_nf-student-omar";
const TALIA = "prn_nf-student-talia";
const ELIJAH = "prn_nf-student-elijah";

/** Grade 4 English Language Arts, Room 12, with Fatima Al-Sayed. */
export const G4_ELA: ShowcaseCourse = {
  offeringId: "off_nf-g4ela-fall-r12",
  band: "3-5",
  teacherId: "prn_nf-teacher-alsayed",
  modules: [
    {
      title: "Finding the Theme",
      page: {
        title: "What Is a Theme?",
        body: "## Theme: the lesson under the story\n\nA **theme** is a message the author wants readers to take away, like *\"Keep trying even when it is hard.\"*\n\nTo find a theme, ask:\n\n1. What problem does the main character face?\n2. How do they change?\n3. What does that teach us about life?\n\nThis week we read **\"The Kite That Would Not Fly.\"**",
      },
      items: [{ kind: "activity", key: "kite-theme" }],
    },
    {
      title: "Opinion Writing",
      page: {
        title: "Say It and Support It",
        body: "## Opinion writing\n\nAn opinion piece has:\n\n- an **opinion** stated clearly at the start,\n- at least **two reasons**, each with facts or examples,\n- linking words like *because*, *for example* and *also*,\n- a **conclusion** that restates your opinion.",
      },
      items: [{ kind: "activity", key: "longer-recess" }],
    },
  ],
  activities: [
    {
      key: "kite-theme",
      template: "writing-task",
      title: "The Theme of \"The Kite That Would Not Fly\"",
      overview: "Name a theme of the story and explain it with details from the text.",
      prompt: "What is a theme of \"The Kite That Would Not Fly\"? State the theme in one sentence, then use two details from the story to explain how the author shows it.",
      genre: "literary-analysis",
      minWords: 80,
      minimumCitations: 1,
      resources: ["kite-story"],
      standards: [{ framework: "ccss-ela", code: "RL.4.2" }, { framework: "ccss-ela", code: "RL.4.3" }],
      aiHelp: "hints-only",
      dueInDays: 7,
      rubric: rubric("rbr_sc-g4ela-kite-theme", "Theme response", [["theme", "States a theme"], ["evidence", "Uses details from the text"], ["conventions", "Spelling and punctuation"]]),
      work: {
        [ABENA]: {
          stage: "released",
          text: "A theme of \"The Kite That Would Not Fly\" is that you should not give up when something fails the first time. At the start, Lila's kite crashes three times and she wants to throw it away. Her grandfather shows her that the tail is too short, so she adds ribbons from her old dress. In the end the kite flies higher than any other kite in the park. The author shows that fixing a mistake is better than quitting.",
          scores: { theme: 4, evidence: 4, conventions: 3 },
          comment: "Abena, your theme statement is clear and your two details prove it. Watch for run-on sentences in your second paragraph.",
        },
        [DIEGO]: {
          stage: "released",
          text: "The theme is kites. Lila has a kite and it does not fly and then it flies. Her grandpa helps her.",
          scores: { theme: 1, evidence: 2, conventions: 3 },
          comment: "Kites are the topic, Diego. A theme is the lesson. What did Lila learn when her kite crashed? Let's talk about it at our conference.",
        },
        [HANA]: {
          stage: "submitted",
          text: "One theme is that the people who love us can help us fix our problems. Lila could not fix her kite by herself, but her grandfather noticed the tail was too short. Together they made it work. I think the author wants us to ask for help.",
        },
      },
    },
    {
      key: "longer-recess",
      template: "writing-task",
      title: "Should Recess Be Longer?",
      overview: "Write an opinion piece about whether our school should have a longer recess.",
      prompt: "Should Northfield Elementary have a longer recess? Write an opinion piece. State your opinion, give at least two reasons with examples, and end with a conclusion.",
      genre: "argument",
      minWords: 100,
      minimumCitations: 0,
      standards: [{ framework: "ccss-ela", code: "W.4.1" }],
      aiHelp: "hints-only",
      dueInDays: 14,
      rubric: rubric("rbr_sc-g4ela-recess", "Opinion writing", [["opinion", "States an opinion"], ["reasons", "Reasons and examples"], ["organization", "Linking words and conclusion"]]),
      work: {
        [ABENA]: { stage: "draft", text: "I think recess should be longer because we need time to move our bodies. For example, after recess I can focus better in math." },
        [DIEGO]: {
          stage: "graded",
          text: "Recess should be longer. First, kids need exercise to stay healthy. Second, recess is when we learn to solve problems with friends, like deciding teams for soccer. Also, we come back calmer. That is why recess should be longer.",
          scores: { opinion: 4, reasons: 3, organization: 3 },
          comment: "Big improvement, Diego! Your reasons are strong. Add one fact or example to your second reason.",
        },
        [HANA]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [],
  discussions: [],
  announcements: [
    { title: "Reading log reminder", body: "Reading logs are due every Friday. Twenty minutes a night of any book your child enjoys counts!" },
  ],
  weeklyNote: "We are learning to find the theme of a story: the lesson underneath it. Ask your child what lesson Lila learned in \"The Kite That Would Not Fly.\"",
};

/** Grade 4 Mathematics, Room 12, with Fatima Al-Sayed. */
export const G4_MATH: ShowcaseCourse = {
  offeringId: "off_nf-g4math-fall-r12",
  band: "3-5",
  teacherId: "prn_nf-teacher-alsayed",
  modules: [
    {
      title: "Equivalent Fractions",
      page: {
        title: "Same Amount, Different Names",
        body: "## Equivalent fractions\n\n**1/2**, **2/4** and **4/8** name the same amount.\n\nMultiply the numerator and the denominator by the **same number**:\n\n1/2 = (1 × 2)/(2 × 2) = 2/4\n\nUse fraction strips to check: they line up!",
      },
      items: [{ kind: "activity", key: "fraction-strips" }, { kind: "quiz", key: "fraction-check" }],
    },
    {
      title: "Adding Fractions",
      page: {
        title: "Adding Pieces of the Same Size",
        body: "## Adding fractions with like denominators\n\nWhen the pieces are the same size, add the numerators:\n\n2/8 + 3/8 = **5/8**\n\nThe denominator stays the same because the size of each piece does not change.",
      },
      items: [{ kind: "activity", key: "pizza-fractions" }],
    },
  ],
  activities: [
    {
      key: "fraction-strips",
      template: "problem-set",
      title: "Fraction Strips",
      overview: "Find equivalent fractions and explain why they are equal.",
      problems: [
        { prompt: "Write two fractions equivalent to 1/3.", answer: "Examples: 2/6, 3/9, 4/12" },
        { prompt: "Is 3/4 equivalent to 6/8? Explain with a model.", answer: "Yes: 3/4 = (3 × 2)/(4 × 2) = 6/8" },
        { prompt: "Fill in the blank: 2/5 = ?/10", answer: "4" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "4.NF.A.1" }],
      aiHelp: "hints-only",
      dueInDays: 6,
      rubric: rubric("rbr_sc-g4math-strips", "Equivalent fractions", [["accuracy", "Correct answers"], ["reasoning", "Explains with a model"]]),
      work: {
        [ABENA]: { stage: "released", text: "1. 2/6 and 4/12\n2. Yes. I multiplied 3 and 4 by 2 and got 6/8. My strips lined up.\n3. 4", scores: { accuracy: 4, reasoning: 4 }, comment: "Excellent use of the strips to prove it!" },
        [DIEGO]: { stage: "released", text: "1. 2/6, 3/9\n2. Yes because 6/8 is bigger numbers\n3. 4", scores: { accuracy: 4, reasoning: 2 }, comment: "Right answers! For #2, \"bigger numbers\" isn't the reason. Show how 3/4 and 6/8 cover the same part of the strip." },
        [HANA]: { stage: "released", text: "1. 2/6, 5/15\n2. Yes, 3/4 × 2/2 = 6/8. I drew two bars the same length.\n3. 4", scores: { accuracy: 4, reasoning: 3 }, comment: "Nice work. Label the parts of your bars next time." },
      },
    },
    {
      key: "pizza-fractions",
      template: "problem-set",
      title: "Pizza Party Fractions",
      overview: "Add fractions with like denominators to solve pizza problems.",
      problems: [
        { prompt: "Ari ate 2/8 of a pizza and Bo ate 3/8. How much of the pizza did they eat together?", answer: "5/8" },
        { prompt: "A pan of cornbread is cut into 6 equal pieces. The class ate 4/6, then 1/6 more. How much is left?", answer: "1/6" },
        { prompt: "Write 7/8 as a sum of eighths in two different ways.", answer: "Examples: 3/8 + 4/8; 1/8 + 2/8 + 4/8" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "4.NF.B.3" }],
      aiHelp: "hints-only",
      dueInDays: 13,
      rubric: rubric("rbr_sc-g4math-pizza", "Adding fractions", [["accuracy", "Correct answers"], ["reasoning", "Shows the steps"]]),
      work: {
        [ABENA]: { stage: "submitted", text: "1. 2/8 + 3/8 = 5/8\n2. 4/6 + 1/6 = 5/6, so 1/6 is left\n3. 3/8 + 4/8 and 1/8 + 6/8" },
        [DIEGO]: { stage: "draft", text: "1. 5/8\n2. " },
        [HANA]: { stage: "graded", text: "1. 5/8\n2. 1/6 left because 6/6 - 5/6 = 1/6\n3. 2/8 + 5/8, 1/8 + 1/8 + 5/8", scores: { accuracy: 4, reasoning: 4 }, comment: "Perfect! I love that you subtracted from 6/6 to find what was left." },
      },
    },
  ],
  quizzes: [
    {
      key: "fraction-check",
      title: "Fraction Check",
      description: "Show what you know about equivalent fractions. You may use fraction strips.",
      items: [
        { type: "multiple-choice", prompt: "Which fraction is equivalent to **1/2**?", points: 1, choices: [{ id: "a", text: "2/3" }, { id: "b", text: "3/6" }, { id: "c", text: "1/4" }], correctChoiceId: "b" },
        { type: "multiple-select", prompt: "Select **every** fraction equal to **2/3**.", points: 2, choices: [{ id: "a", text: "4/6" }, { id: "b", text: "6/9" }, { id: "c", text: "3/4" }, { id: "d", text: "8/12" }], correctChoiceIds: ["a", "b", "d"], scoring: "partial" },
        { type: "true-false", prompt: "**3/4** and **6/8** name the same amount.", points: 1, correct: true },
        { type: "numeric", prompt: "**2/5 = ?/10**. Type the missing numerator.", points: 1, answer: 4, tolerance: 0 },
      ],
      attempts: {
        [ABENA]: [{ type: "multiple-choice", choiceId: "b" }, { type: "multiple-select", choiceIds: ["a", "b", "d"] }, { type: "true-false", value: true }, { type: "numeric", value: 4 }],
        [DIEGO]: [{ type: "multiple-choice", choiceId: "b" }, { type: "multiple-select", choiceIds: ["a", "c"] }, { type: "true-false", value: true }, { type: "numeric", value: 4 }],
        [HANA]: [{ type: "multiple-choice", choiceId: "b" }, { type: "multiple-select", choiceIds: ["a", "b"] }, { type: "true-false", value: true }, { type: "numeric", value: 5 }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Fraction strips are coming home", body: "Your child is bringing home a set of paper fraction strips. Please keep them in their homework folder; we use them all unit." },
  ],
  weeklyNote: "This week we found equivalent fractions with fraction strips (1/2 = 2/4 = 4/8). Next week we start adding fractions. A pizza or a sandwich at home makes great practice!",
};

/** Grade 5 Science, Science Lab, with Marcus Johnson. Science has no built-in standards, so nothing is aligned. */
export const G5_SCIENCE: ShowcaseCourse = {
  offeringId: "off_nf-g5sci-fall-lab",
  band: "3-5",
  teacherId: "prn_nf-teacher-johnson",
  modules: [
    {
      title: "Matter and Its Properties",
      page: {
        title: "Everything Is Made of Matter",
        body: "## Matter\n\nMatter is anything that has **mass** and takes up **space**.\n\nWhen sugar **dissolves** in water, it seems to disappear, but it is still there. The water gets sweeter, and the mass of the cup does not change!\n\nIn this unit we will test what makes things dissolve faster.",
      },
      items: [{ kind: "activity", key: "dissolving" }, { kind: "quiz", key: "states-of-matter" }],
    },
    {
      title: "Earth's Water",
      page: {
        title: "The Water Cycle",
        body: "## Where does rain come from?\n\nWater moves in a cycle:\n\n1. **Evaporation**: the sun warms water and it rises as water vapor.\n2. **Condensation**: the vapor cools into tiny drops that make clouds.\n3. **Precipitation**: the drops fall as rain, snow or hail.\n4. **Collection**: water gathers in oceans, lakes and the ground.",
      },
      items: [{ kind: "activity", key: "water-cycle" }],
    },
  ],
  activities: [
    {
      key: "dissolving",
      template: "science-investigation",
      title: "Does Temperature Change How Fast Sugar Dissolves?",
      overview: "Test whether sugar dissolves faster in warm water or cold water.",
      question: "Does sugar dissolve faster in warm water or cold water?",
      methodPrompt: "Describe your steps. What will you keep the same in each cup? What will you change? How will you time it?",
      dataColumns: [{ name: "Water temperature", unit: "°C" }, { name: "Time to dissolve", unit: "s" }, { name: "Trial" }],
      analysisPrompt: "What did your data show? Use your numbers to explain why temperature made a difference.",
      standards: [],
      aiHelp: "hints-only",
      dueInDays: 8,
      rubric: rubric("rbr_sc-g5sci-dissolving", "Investigation", [["hypothesis", "Testable hypothesis"], ["method", "Fair test"], ["data", "Data recorded with units"], ["conclusion", "Conclusion uses data"]]),
      work: {
        [OMAR]: {
          stage: "released",
          text: "Hypothesis: Sugar will dissolve faster in warm water because the water particles move faster.\nMethod: Same cup, 200 mL water, 1 spoon of sugar, stir 5 times. Change only the temperature: 10°C, 25°C, 45°C.\nData: 10°C = 95 s, 25°C = 61 s, 45°C = 28 s.\nConclusion: The warmest water dissolved the sugar more than 3 times faster than the cold water, so my hypothesis was supported.",
          scores: { hypothesis: 4, method: 4, data: 4, conclusion: 4 },
          comment: "Textbook fair test, Omar. Your conclusion uses your numbers to prove the point.",
        },
        [TALIA]: {
          stage: "released",
          text: "I think warm water is faster. We put sugar in hot and cold water. The hot water was faster. Cold took a long time.",
          scores: { hypothesis: 3, method: 2, data: 1, conclusion: 2 },
          comment: "Good prediction! Add your times in seconds and the temperature of each cup so a reader can see the difference.",
        },
        [ELIJAH]: { stage: "submitted", text: "Hypothesis: warm water dissolves sugar faster. Data: cold 88 s, room 57 s, warm 31 s. The warmer the water, the faster it dissolved." },
      },
    },
    {
      key: "water-cycle",
      template: "writing-task",
      title: "Explain the Water Cycle",
      overview: "Explain how a drop of water travels through the water cycle.",
      prompt: "Follow one drop of water through the water cycle. Explain each step (evaporation, condensation, precipitation, collection) and what causes it.",
      genre: "informative",
      minWords: 80,
      minimumCitations: 0,
      standards: [],
      aiHelp: "hints-only",
      dueInDays: 15,
      rubric: rubric("rbr_sc-g5sci-water-cycle", "Water cycle explanation", [["science", "Accurate science ideas"], ["clarity", "Clear explanation"]]),
      work: {
        [OMAR]: { stage: "draft", text: "My drop starts in Lake Northfield. The sun heats it and it evaporates into water vapor." },
        [TALIA]: { stage: "not-started" },
        [ELIJAH]: {
          stage: "graded",
          text: "A drop of water in the ocean is warmed by the sun and evaporates. It rises and cools, condensing into a cloud with other drops. When the drops get heavy they fall as precipitation, like rain. The rain collects in a river and flows back to the ocean to start again.",
          scores: { science: 4, clarity: 3 },
          comment: "Accurate and complete! Add a sentence about what makes the vapor cool as it rises.",
        },
      },
    },
  ],
  quizzes: [
    {
      key: "states-of-matter",
      title: "States of Matter",
      description: "Five quick questions about matter.",
      items: [
        { type: "multiple-choice", prompt: "Which is a **gas**?", points: 1, choices: [{ id: "ice", text: "🧊 ice" }, { id: "steam", text: "♨️ steam" }, { id: "milk", text: "🥛 milk" }], correctChoiceId: "steam" },
        { type: "true-false", prompt: "When sugar dissolves in water, the sugar is gone.", points: 1, correct: false, feedback: "The sugar is still there: it has spread out between the water particles." },
        { type: "short-answer", prompt: "What is it called when a liquid turns into a gas?", points: 1, acceptedAnswers: ["evaporation", "evaporating", "boiling"] },
      ],
      attempts: {
        [OMAR]: [{ type: "multiple-choice", choiceId: "steam" }, { type: "true-false", value: false }, { type: "short-answer", text: "evaporation" }],
        [TALIA]: [{ type: "multiple-choice", choiceId: "steam" }, { type: "true-false", value: true }, { type: "short-answer", text: "evaporation" }],
      },
      releaseScores: false,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Lab safety goggles", body: "We start hands-on labs next week. Every scientist will get their own goggles to keep in the lab." },
  ],
  weeklyNote: "Our scientists ran a fair test to see whether temperature changes how fast sugar dissolves. Ask your child what they kept the same in every cup, and why that matters.",
};

/** The 3-5 band's classes. */
export const G35_COURSES: readonly ShowcaseCourse[] = [G4_ELA, G4_MATH, G5_SCIENCE];
