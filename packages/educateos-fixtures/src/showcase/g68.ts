// 6-8: Mathematics 7, English 8 and World History 7 at Northfield Middle School.
import { rubric } from "./rubrics.ts";
import type { ShowcaseCourse } from "./types.ts";

const CHIDI = "prn_nf-student-chidi";
const FELIX = "prn_nf-student-felix";
const ANA = "prn_nf-student-ana";
const KOFI = "prn_nf-student-kofi";
const MAYA = "prn_nf-student-maya";
const RAVI = "prn_nf-student-ravi";

/** Mathematics 7, Period 1, with Casey Patel. */
export const MATH_7: ShowcaseCourse = {
  offeringId: "off_nf-math7-fall-p1",
  band: "6-8",
  teacherId: "prn_nf-teacher-patel",
  modules: [
    {
      title: "Unit 2: Proportional Relationships",
      page: {
        title: "Is It Proportional?",
        body: "## Proportional relationships\n\nTwo quantities are **proportional** when their ratio is always the same: the **constant of proportionality**, *k*.\n\n- The equation looks like **y = kx**.\n- The table has the same *y ÷ x* in every row.\n- The graph is a straight line **through the origin**.",
      },
      items: [{ kind: "activity", key: "unit-rates" }, { kind: "quiz", key: "proportional-or-not" }],
    },
    {
      title: "Unit 3: Equations",
      page: {
        title: "Two-Step Equations",
        body: "## Solving two-step equations\n\nUndo the operations in reverse order:\n\n3x + 5 = 20\n\n3x = 15 (subtract 5 from both sides)\n\nx = 5 (divide both sides by 3)\n\nAlways check: 3(5) + 5 = 20 ✔",
      },
      items: [{ kind: "activity", key: "two-step" }],
    },
  ],
  activities: [
    {
      key: "unit-rates",
      template: "problem-set",
      title: "Unit Rates and the Constant of Proportionality",
      overview: "Decide whether each relationship is proportional and find the constant.",
      problems: [
        { prompt: "A recipe uses 3 cups of flour for every 2 eggs. How many cups of flour for 8 eggs?", answer: "12 cups (k = 1.5 cups per egg)" },
        { prompt: "A taxi charges $3 plus $2 per mile. Is cost proportional to miles? Explain.", answer: "No: the $3 fee means the graph does not pass through the origin." },
        { prompt: "A car travels 150 miles in 2.5 hours at a steady speed. Write an equation for distance d after t hours.", answer: "d = 60t" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "7.RP.A.2" }],
      aiHelp: "hints-only",
      dueInDays: 6,
      rubric: rubric("rbr_sc-math7-unit-rates", "Proportional reasoning", [["accuracy", "Correct solutions"], ["reasoning", "Justifies with ratios, tables or graphs"]]),
      work: {
        [CHIDI]: { stage: "released", text: "1. 3/2 = 1.5 cups per egg; 1.5 × 8 = 12 cups\n2. Not proportional. At 0 miles it costs $3, so the line starts at (0, 3) not the origin.\n3. 150 ÷ 2.5 = 60, so d = 60t", scores: { accuracy: 4, reasoning: 4 }, comment: "Clear and complete, Chidi. Strong use of the origin test in #2." },
        [FELIX]: { stage: "released", text: "1. 12\n2. Yes because it goes up by 2 each mile\n3. d = 60t", scores: { accuracy: 3, reasoning: 2 }, comment: "Check #2: a constant rate of change is not enough. Does the cost start at zero?" },
        [ANA]: { stage: "graded", text: "1. 12 cups\n2. No, because 5/1 and 7/2 are not equal ratios.\n3. d = 60t", scores: { accuracy: 4, reasoning: 3 }, comment: "Nice ratio check in #2! Name the constant in #1 too." },
      },
    },
    {
      key: "two-step",
      template: "problem-set",
      title: "Two-Step Equations in Context",
      overview: "Write and solve two-step equations for real situations.",
      problems: [
        { prompt: "Solve 4x - 7 = 21.", answer: "x = 7" },
        { prompt: "A gym charges a $25 sign-up fee and $15 per month. Kofi's sister paid $130. Write and solve an equation for the number of months.", answer: "25 + 15m = 130; m = 7" },
        { prompt: "The perimeter of a rectangle is 54 cm. Its length is 15 cm. Write and solve an equation for the width.", answer: "2(15) + 2w = 54; w = 12 cm" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "7.EE.B.4" }],
      aiHelp: "hints-only",
      dueInDays: 13,
      rubric: rubric("rbr_sc-math7-two-step", "Equations", [["equation", "Writes the equation"], ["solution", "Solves and checks"]]),
      work: {
        [CHIDI]: { stage: "submitted", text: "1. 4x = 28, x = 7\n2. 25 + 15m = 130, 15m = 105, m = 7\n3. 30 + 2w = 54, 2w = 24, w = 12" },
        [FELIX]: { stage: "not-started" },
        [ANA]: { stage: "draft", text: "1. x = 7\n2. 25 + 15m = 130" },
      },
    },
  ],
  quizzes: [
    {
      key: "proportional-or-not",
      title: "Proportional or Not?",
      description: "Eight minutes. Decide whether each relationship is proportional.",
      items: [
        { type: "multiple-choice", prompt: "Which equation shows a proportional relationship?", points: 1, choices: [{ id: "a", text: "y = 4x" }, { id: "b", text: "y = 4x + 1" }, { id: "c", text: "y = x²" }], correctChoiceId: "a" },
        { type: "true-false", prompt: "The graph of a proportional relationship always passes through the origin.", points: 1, correct: true },
        { type: "numeric", prompt: "Pencils cost $0.35 each. What is the cost, in dollars, of 12 pencils?", points: 2, answer: 4.2, tolerance: 0.001 },
        { type: "essay", prompt: "Give a real-life example of two quantities that are **not** proportional, and explain why.", points: 3 },
      ],
      attempts: {
        [CHIDI]: [{ type: "multiple-choice", choiceId: "a" }, { type: "true-false", value: true }, { type: "numeric", value: 4.2 }, { type: "essay", text: "Your age and your height. They both go up, but the ratio is not constant, and you do not grow at the same rate every year.", points: 3 }],
        [FELIX]: [{ type: "multiple-choice", choiceId: "b" }, { type: "true-false", value: true }, { type: "numeric", value: 4.2 }, { type: "essay", text: "A phone plan with a monthly fee plus cost per gigabyte, because you pay the fee even with zero gigabytes.", points: 3 }],
        [ANA]: [{ type: "multiple-choice", choiceId: "a" }, { type: "true-false", value: false }, { type: "numeric", value: 4.2 }, { type: "essay", text: "Temperature during the day and time.", points: 1 }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Unit 2 quiz on Friday", body: "Our proportional relationships quiz is Friday. Review your notes on finding k from tables, graphs and equations." },
  ],
  weeklyNote: "Unit 2 wraps up this week with a quiz on proportional relationships. Students can retry missed problems during Thursday's study hall.",
};

/** English 8, Period 2, with Hannah Kowalski. */
export const ENGLISH_8: ShowcaseCourse = {
  offeringId: "off_nf-eng8-fall-p2",
  band: "6-8",
  teacherId: "prn_nf-teacher-kowalski",
  modules: [
    {
      title: "Argument Writing",
      page: {
        title: "Claims, Reasons and Counterclaims",
        body: "## Building an argument\n\n1. **Claim**: your position in one clear sentence.\n2. **Reasons**: why a reader should agree.\n3. **Evidence**: facts, data, examples or expert quotes for each reason.\n4. **Counterclaim**: the strongest objection, stated fairly.\n5. **Rebuttal**: why your claim still holds.",
      },
      items: [{ kind: "activity", key: "phones-argument" }, { kind: "discussion", key: "promise" }],
    },
    {
      title: "Theme in Short Fiction",
      page: {
        title: "Reading for Theme",
        body: "## How does a theme develop?\n\nA theme is rarely stated. Trace it through:\n\n- what characters **want** and what they **do**,\n- how the **conflict** changes them,\n- **objects or images** that repeat.\n\nOur story: **\"The Lighthouse Keeper's Daughter.\"**",
      },
      items: [{ kind: "activity", key: "lighthouse-theme" }],
    },
  ],
  activities: [
    {
      key: "phones-argument",
      template: "writing-task",
      title: "Phones in the Classroom",
      overview: "Write an argument about whether students should be allowed to keep phones in middle school classrooms.",
      prompt: "Should Northfield Middle School let students keep their phones in class? Write an argument with a clear claim, two reasons supported by evidence, a counterclaim and a rebuttal.",
      genre: "argument",
      minWords: 250,
      minimumCitations: 0,
      standards: [{ framework: "ccss-ela", code: "W.8.1" }],
      aiHelp: "hints-only",
      dueInDays: 10,
      rubric: rubric("rbr_sc-eng8-phones", "Argument", [["claim", "Claim"], ["evidence", "Reasons and evidence"], ["counterclaim", "Counterclaim and rebuttal"], ["conventions", "Conventions"]]),
      work: {
        [KOFI]: {
          stage: "released",
          text: "Phones should stay in lockers during class. First, notifications pull attention away from learning: when my phone buzzes, it takes me a few minutes to get back into what I was reading. Second, a phone-free room is fairer, because no one is left out of group chats during class. Some people argue that phones are needed for emergencies. However, the front office can reach any classroom in seconds, and phones are still available at lunch and after school. Keeping phones in lockers protects the time we spend learning.",
          scores: { claim: 4, evidence: 3, counterclaim: 4, conventions: 4 },
          comment: "Kofi, your rebuttal is the best in the class: fair to the other side and convincing. Strengthen reason one with a source, not only your own experience.",
        },
        [MAYA]: {
          stage: "released",
          text: "Students should be able to have phones in class because they are useful. You can look things up and use a calculator. Also parents want to text their kids. Phones are part of life now.",
          scores: { claim: 3, evidence: 2, counterclaim: 1, conventions: 3 },
          comment: "A clear claim, Maya! Your argument needs a counterclaim and rebuttal; what would a teacher who disagrees say?",
        },
        [RAVI]: { stage: "submitted", text: "Phones should be allowed but only for learning. Teachers could use a green-light, red-light card on the board. When it is green, phones can be used for research or calculators. Critics say students will get distracted, but clear rules teach responsibility, which we need for high school." },
      },
    },
    {
      key: "lighthouse-theme",
      template: "writing-task",
      title: "Theme in \"The Lighthouse Keeper's Daughter\"",
      overview: "Analyze how a theme develops over the course of the story.",
      prompt: "Identify a theme of \"The Lighthouse Keeper's Daughter\" and analyze how it develops from the beginning to the end of the story. Cite at least two passages.",
      genre: "literary-analysis",
      minWords: 300,
      minimumCitations: 2,
      resources: ["lighthouse-story"],
      standards: [{ framework: "ccss-ela", code: "RL.8.2" }],
      aiHelp: "hints-only",
      dueInDays: 18,
      rubric: rubric("rbr_sc-eng8-lighthouse", "Literary analysis", [["theme", "Theme"], ["development", "Traces development"], ["citations", "Uses passages"]]),
      work: {
        [KOFI]: { stage: "draft", text: "In \"The Lighthouse Keeper's Daughter,\" Nell learns that courage is not the absence of fear." },
        [MAYA]: { stage: "not-started" },
        [RAVI]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [],
  discussions: [
    {
      key: "promise",
      title: "Is it ever right to break a promise?",
      prompt: "Take a position and give **one** reason with an example. Then reply to a classmate who sees it differently: what is the strongest part of their argument?",
      posts: [
        { author: KOFI, body: "Yes, if keeping it would hurt someone. If I promised to keep a secret but a friend was in danger, telling an adult is the right choice." },
        { author: MAYA, body: "I mostly disagree. If people break promises whenever they think it's right, nobody can trust promises at all.", replyTo: 0 },
        { author: RAVI, body: "Maya's point about trust is strong. But I think a promise to do something harmful was never a fair promise to begin with.", replyTo: 1 },
        { author: "prn_nf-teacher-kowalski", body: "Great thread. Notice how Ravi named the strongest part of Maya's argument before answering it. That is exactly the move a rebuttal makes." },
      ],
    },
  ],
  announcements: [
    { title: "Argument essays: peer review Wednesday", body: "Bring a printed or shared draft of your phones argument on Wednesday for peer review." },
  ],
  weeklyNote: "Students are writing arguments about phones in class and learning to answer the other side fairly. Ask your child for their claim, and what the strongest counterclaim is.",
};

/** World History 7, Period 4, with Tomás Ortega. */
export const WORLD_HISTORY_7: ShowcaseCourse = {
  offeringId: "off_nf-whist7-fall-p4",
  band: "6-8",
  teacherId: "prn_nf-teacher-ortega",
  modules: [
    {
      title: "Ancient Mesopotamia",
      page: {
        title: "The Land Between the Rivers",
        body: "## Mesopotamia\n\nAround 3500 BCE, cities grew between the **Tigris** and **Euphrates** rivers. People there developed some of the first:\n\n- **writing** (cuneiform on clay tablets),\n- **written laws**,\n- **cities and kingdoms**.\n\nThis week we read laws from the reign of **King Hammurabi of Babylon** (about 1750 BCE) as historians do: who wrote it, why, and what it tells us.",
      },
      items: [{ kind: "activity", key: "hammurabi" }],
    },
    {
      title: "The Silk Roads",
      page: {
        title: "More Than Silk",
        body: "## The Silk Roads\n\nFrom about 130 BCE, trade routes linked China, Central Asia, India, Persia and the Mediterranean. Merchants carried **silk, spices, paper and horses**, but also **religions, languages, technologies and diseases**.",
      },
      items: [{ kind: "activity", key: "silk-roads" }, { kind: "discussion", key: "ancient-invention" }],
    },
  ],
  activities: [
    {
      key: "hammurabi",
      template: "primary-source-analysis",
      title: "What Do Hammurabi's Laws Tell Us?",
      overview: "Analyze excerpts from Hammurabi's laws as a historian would.",
      sourcingQuestions: ["Who created these laws, and when?", "Why might a king have the laws carved on a stone pillar in public?"],
      contextualizationQuestions: ["What was life like in Babylon at the time?", "Who in Babylonian society do the laws seem to protect, and who do they treat differently?"],
      claimPrompt: "What do these laws reveal about the values of Babylonian society? Support your claim with at least two laws.",
      minimumEvidence: 2,
      resources: ["hammurabi-laws"],
      standards: [{ framework: "c3", code: "D2.His.1.6-8" }, { framework: "c3", code: "D2.His.16.6-8" }],
      aiHelp: "hints-only",
      dueInDays: 9,
      rubric: rubric("rbr_sc-whist7-hammurabi", "Source analysis", [["sourcing", "Sourcing"], ["context", "Context"], ["claim", "Claim and evidence"]]),
      work: {
        [CHIDI]: {
          stage: "released",
          text: "Sourcing: King Hammurabi of Babylon had these laws carved around 1750 BCE. Putting them in public showed everyone the king was just and powerful.\nContext: Babylon was a large city with farmers, merchants and enslaved people.\nClaim: The laws show that Babylonians valued order and fairness, but not equality. Law 196 punishes injuring a free man with the same injury, while law 198 only requires a payment for injuring a commoner.",
          scores: { sourcing: 4, context: 3, claim: 4 },
          comment: "Excellent comparison of laws 196 and 198, Chidi. Your context paragraph could say more about why a king needed laws for a growing city.",
        },
        [FELIX]: { stage: "submitted", text: "Sourcing: Hammurabi wrote them in 1750 BCE.\nContext: Mesopotamia had rivers and farming.\nClaim: Babylonians cared about property. Law 53 says if someone doesn't fix their dam and floods a field they must pay for the grain." },
        [ANA]: {
          stage: "graded",
          text: "Sourcing: The laws were carved on a stone stele for the public so people knew the rules.\nContext: Babylon traded and farmed and had social classes.\nClaim: Babylonians believed punishments should match the crime, like an eye for an eye in law 196. But the laws were different for rich and poor people.",
          scores: { sourcing: 3, context: 3, claim: 3 },
          comment: "Good start, Ana. Name the second law you are thinking of when you say rich and poor were treated differently.",
        },
      },
    },
    {
      key: "silk-roads",
      template: "writing-task",
      title: "Ideas on the Move",
      overview: "Explain how the Silk Roads spread ideas as well as goods.",
      prompt: "Explain how the Silk Roads spread ideas, beliefs or technologies, not just goods. Use two specific examples and explain the effect of each.",
      genre: "informative",
      minWords: 200,
      minimumCitations: 0,
      standards: [{ framework: "c3", code: "D2.His.14.6-8" }, { framework: "c3", code: "D2.Geo.7.6-8" }],
      aiHelp: "hints-only",
      dueInDays: 16,
      rubric: rubric("rbr_sc-whist7-silk", "Explanatory writing", [["examples", "Specific examples"], ["effects", "Explains effects"]]),
      work: {
        [CHIDI]: { stage: "draft", text: "The Silk Roads carried paper-making from China to the Islamic world." },
        [FELIX]: { stage: "not-started" },
        [ANA]: { stage: "submitted", text: "Buddhism spread from India into China along the Silk Roads, carried by monks and merchants. This changed Chinese art and architecture, like cave temples. Paper-making also spread west from China, which made books cheaper in Baghdad and later Europe." },
      },
    },
  ],
  quizzes: [],
  discussions: [
    {
      key: "ancient-invention",
      title: "Which ancient invention matters most today?",
      prompt: "Writing, the wheel, paper, written law, irrigation: choose one. Explain why your life would be different without it, then respond to someone who chose differently.",
      posts: [
        { author: ANA, body: "Writing. Without it we couldn't keep laws, history, or even this discussion board!" },
        { author: CHIDI, body: "I picked irrigation. Before writing mattered, people needed enough food to build cities at all.", replyTo: 0 },
        { author: FELIX, body: "Paper, because writing on clay tablets is heavy. Paper let ideas travel on the Silk Roads." },
      ],
    },
  ],
  announcements: [
    { title: "Museum field trip forms", body: "Permission forms for the Detroit Institute of Arts trip are due next Friday. We'll visit the ancient Near East gallery." },
  ],
  weeklyNote: "We read Hammurabi's laws as historians: asking who wrote them, why, and what they reveal about Babylon. Ask your child which law surprised them most.",
};

/** The 6-8 band's classes. */
export const G68_COURSES: readonly ShowcaseCourse[] = [MATH_7, ENGLISH_8, WORLD_HISTORY_7];
