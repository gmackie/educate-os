// 9-12: Biology I, English 9 and United States History at Northfield High School.
import { rubric } from "./rubrics.ts";
import type { ShowcaseCourse } from "./types.ts";

const AMARA = "prn_nf-student-amara";
const DMITRI = "prn_nf-student-dmitri";
const ELENA = "prn_nf-student-elena";
const LUCIA = "prn_nf-student-lucia";

/** Biology I, Period 2, with Morgan Lee. Science has no built-in standards, so nothing is aligned. */
export const BIOLOGY: ShowcaseCourse = {
  offeringId: "off_nf-bio-fall-p2",
  band: "9-12",
  teacherId: "prn_nf-morgan-lee",
  modules: [
    {
      title: "Unit 1: Cells and Transport",
      page: {
        title: "Crossing the Membrane",
        body: "## How do things get into a cell?\n\nThe **cell membrane** is selectively permeable.\n\n- **Diffusion**: particles move from high to low concentration.\n- **Osmosis**: *water* diffuses across a membrane.\n- **Active transport**: the cell spends energy (ATP) to move particles *against* the gradient.\n\nIn this unit's lab you'll use a shell-less egg as a model cell.",
      },
      items: [{ kind: "activity", key: "egg-osmosis" }, { kind: "quiz", key: "cell-structures" }],
    },
    {
      title: "Unit 2: Heredity",
      page: {
        title: "Punnett Squares",
        body: "## Predicting offspring\n\nEach parent passes on **one allele** for a gene. A Punnett square shows every combination.\n\n| | **B** | **b** |\n|---|---|---|\n| **B** | BB | Bb |\n| **b** | Bb | bb |\n\nA cross of two heterozygous (Bb) parents gives a **3 : 1** ratio of dominant to recessive phenotypes.",
      },
      items: [{ kind: "activity", key: "punnett" }],
    },
  ],
  activities: [
    {
      key: "egg-osmosis",
      template: "science-investigation",
      title: "The Naked Egg: Osmosis Lab",
      overview: "Use a shell-less egg as a model cell to investigate osmosis.",
      question: "How does the concentration of the surrounding solution affect the mass of a shell-less egg?",
      methodPrompt: "Describe how you will prepare the eggs, which solutions you will use, what you will hold constant and how often you will measure mass.",
      dataColumns: [{ name: "Solution" }, { name: "Starting mass", unit: "g" }, { name: "Mass after 24 h", unit: "g" }, { name: "Percent change", unit: "%" }],
      analysisPrompt: "Explain your results in terms of osmosis and concentration gradients. Which solution was hypertonic to the egg, and how do you know?",
      standards: [],
      aiHelp: "hints-only",
      dueInDays: 7,
      rubric: rubric("rbr_sc-bio-egg-osmosis", "Lab report", [["hypothesis", "Hypothesis"], ["method", "Controlled method"], ["data", "Data and units"], ["analysis", "Analysis uses evidence"]]),
      work: {
        [AMARA]: {
          stage: "released",
          text: "Hypothesis: An egg in corn syrup will lose mass and an egg in distilled water will gain mass, because water moves toward higher solute concentration.\nMethod: Three shell-less eggs, same size, 250 mL of each solution, 24 hours at room temperature, blotted dry before weighing.\nData: distilled water 71.2 g → 82.9 g (+16.4%); 10% salt water 70.8 g → 66.1 g (-6.6%); corn syrup 72.0 g → 51.4 g (-28.6%).\nAnalysis: Corn syrup was strongly hypertonic, so water left the egg by osmosis. Distilled water was hypotonic, so water entered.",
          scores: { hypothesis: 4, method: 4, data: 4, analysis: 4 },
          comment: "Outstanding report, Amara. Your percent change makes the eggs comparable even though their starting masses differed.",
        },
        [DMITRI]: { stage: "draft", text: "Hypothesis: The egg in water gets bigger. Data: water egg went from 70 g to 80 g." },
        [ELENA]: {
          stage: "released",
          text: "Hypothesis: Eggs will gain mass in water and lose mass in syrup.\nData: water +12 g, salt -3 g, syrup -19 g.\nAnalysis: Water moved out of the egg in syrup because the syrup has more sugar. The membrane let water through but not sugar.",
          scores: { hypothesis: 3, method: 2, data: 3, analysis: 3 },
          comment: "Solid analysis. Your method is missing: what did you hold constant? Also report percent change so we can compare eggs.",
        },
        [LUCIA]: { stage: "submitted", text: "Hypothesis: If the solution has a higher solute concentration than the egg, the egg will lose water by osmosis and lose mass.\nData: distilled water +15.1%, salt water -5.9%, corn syrup -26.0%.\nAnalysis: Both salt water and corn syrup were hypertonic; corn syrup more so, which is why the egg lost the most mass." },
      },
    },
    {
      key: "punnett",
      template: "problem-set",
      title: "Punnett Square Practice",
      overview: "Use Punnett squares to predict genotypes and phenotypes.",
      problems: [
        { prompt: "In pea plants, purple flowers (P) are dominant to white (p). Cross Pp × Pp. What fraction of offspring will have white flowers?", answer: "1/4" },
        { prompt: "A brown-furred rabbit (Bb) is crossed with a white rabbit (bb). Give the expected genotype and phenotype ratios.", answer: "1 Bb : 1 bb; 1 brown : 1 white" },
        { prompt: "Two tall plants produce 75 tall and 25 short offspring. What are the parents' genotypes? Explain.", answer: "Tt × Tt: a 3:1 ratio means both parents carry the recessive allele." },
      ],
      showWork: true,
      standards: [],
      aiHelp: "hints-only",
      dueInDays: 14,
      rubric: rubric("rbr_sc-bio-punnett", "Genetics", [["squares", "Correct Punnett squares"], ["ratios", "Ratios and explanation"]]),
      work: {
        [AMARA]: { stage: "submitted", text: "1. PP, Pp, Pp, pp → 1/4 white\n2. Bb, Bb, bb, bb → 1:1 genotype, 1 brown : 1 white\n3. Tt × Tt, because only heterozygous parents give a 3:1 ratio." },
        [DMITRI]: { stage: "not-started" },
        [ELENA]: { stage: "graded", text: "1. 1/4\n2. 1:1\n3. Both Tt", scores: { squares: 2, ratios: 3 }, comment: "Correct answers, but show your Punnett squares so I can see how you got them." },
        [LUCIA]: { stage: "draft", text: "1. 1/4 white (pp)" },
      },
    },
  ],
  quizzes: [
    {
      key: "cell-structures",
      title: "Cell Structures and Transport",
      description: "One attempt, 15 minutes. The last question is graded by your teacher.",
      items: [
        { type: "multiple-choice", prompt: "Which organelle makes most of a cell's ATP?", points: 1, choices: [{ id: "a", text: "Ribosome" }, { id: "b", text: "Mitochondrion" }, { id: "c", text: "Golgi apparatus" }, { id: "d", text: "Vacuole" }], correctChoiceId: "b" },
        { type: "multiple-select", prompt: "Select every structure found in **plant** cells but not animal cells.", points: 2, choices: [{ id: "a", text: "Cell wall" }, { id: "b", text: "Chloroplast" }, { id: "c", text: "Nucleus" }, { id: "d", text: "Cell membrane" }], correctChoiceIds: ["a", "b"], scoring: "all-or-nothing" },
        { type: "short-answer", prompt: "What is the diffusion of water across a membrane called?", points: 1, acceptedAnswers: ["osmosis"] },
        { type: "essay", prompt: "A red blood cell is placed in pure water. Predict what happens and explain why.", points: 4 },
      ],
      attempts: {
        [AMARA]: [{ type: "multiple-choice", choiceId: "b" }, { type: "multiple-select", choiceIds: ["a", "b"] }, { type: "short-answer", text: "Osmosis" }, { type: "essay", text: "It swells and may burst (lyse). Pure water is hypotonic to the cell, so water moves in by osmosis, and animal cells have no cell wall to resist the pressure.", points: 4 }],
        [ELENA]: [{ type: "multiple-choice", choiceId: "b" }, { type: "multiple-select", choiceIds: ["a", "b", "c"] }, { type: "short-answer", text: "osmosis" }, { type: "essay", text: "Water goes into the cell and it gets bigger because there is more salt inside.", points: 3 }],
        [LUCIA]: [{ type: "multiple-choice", choiceId: "a" }, { type: "multiple-select", choiceIds: ["a", "b"] }, { type: "short-answer", text: "osmosis" }, { type: "essay", text: "The cell would swell up and could pop because water rushes in.", points: 3 }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Lab day Tuesday: closed-toe shoes", body: "We run the naked egg lab Tuesday. Closed-toe shoes and tied-back hair, please." },
  ],
  weeklyNote: "Biology students used shell-less eggs as model cells to see osmosis in action. Lab reports are due next week; ask to see your student's data table.",
};

/** English 9, Period 3, with Sam Rivera (and Riley Chen co-teaching). */
export const ENGLISH_9: ShowcaseCourse = {
  offeringId: "off_nf-eng9-fall-p3",
  band: "9-12",
  teacherId: "prn_nf-teacher-rivera",
  modules: [
    {
      title: "Unit 1: The Power of Argument",
      page: {
        title: "Argument That Persuades",
        body: "## What makes an argument persuasive?\n\n- A **precise claim** that can be debated.\n- **Evidence** that is relevant and sufficient.\n- **Reasoning** that connects each piece of evidence to the claim.\n- A fair treatment of **counterclaims**.\n\nYour unit essay asks whether community service should be a graduation requirement.",
      },
      items: [{ kind: "activity", key: "service-argument" }, { kind: "discussion", key: "coming-of-age" }],
    },
    {
      title: "Unit 2: Coming-of-Age Stories",
      page: {
        title: "Growing Up on the Page",
        body: "## Coming-of-age stories\n\nA coming-of-age story follows a young character through a change from innocence toward understanding. Watch for:\n\n- a **threshold** moment,\n- a **mentor** or foil,\n- what the character **loses** and **gains**.",
      },
      items: [{ kind: "activity", key: "coming-of-age-essay" }],
    },
  ],
  activities: [
    {
      key: "service-argument",
      template: "writing-task",
      title: "Should Community Service Be Required to Graduate?",
      overview: "Write an argumentative essay on whether high schools should require community service hours to graduate.",
      prompt: "Should Northfield High School require 40 hours of community service to graduate? Write an argument with a precise claim, evidence from at least one source, reasoning, and a fair counterclaim.",
      genre: "argument",
      minWords: 400,
      minimumCitations: 1,
      resources: ["service-brief"],
      standards: [{ framework: "ccss-ela", code: "W.9-10.1" }],
      aiHelp: "hints-only",
      dueInDays: 12,
      rubric: rubric("rbr_sc-eng9-service", "Argument essay", [["claim", "Precise claim"], ["evidence", "Evidence and reasoning"], ["counterclaim", "Counterclaims"], ["conventions", "Style and conventions"]]),
      work: {
        [AMARA]: {
          stage: "released",
          text: "Northfield should require community service, but it should let students choose how they serve. According to the district's own brief, students who volunteered reported stronger connections to their community. Required service also gives every student, not only those with free time, a reason to try. Critics argue that required volunteering is a contradiction. Yet schools already require things that build citizenship, like civics. By allowing choice, the requirement becomes an invitation rather than a punishment.",
          scores: { claim: 4, evidence: 3, counterclaim: 4, conventions: 4 },
          comment: "A nuanced claim and a graceful rebuttal, Amara. Quote the brief directly instead of paraphrasing so your evidence carries more weight.",
        },
        [ELENA]: { stage: "submitted", text: "Community service should not be required. Many students work after school to support their families, and forty more hours would take time from sleep and homework. Service matters, but making it mandatory turns generosity into a checkbox." },
      },
    },
    {
      key: "coming-of-age-essay",
      template: "writing-task",
      title: "What Changes a Character?",
      overview: "Analyze how a character in a coming-of-age story changes and what theme that change develops.",
      prompt: "Choose a coming-of-age story we read. Analyze how the main character changes and how that change develops a theme. Cite at least two passages.",
      genre: "literary-analysis",
      minWords: 500,
      minimumCitations: 0,
      standards: [{ framework: "ccss-ela", code: "RL.9-10.2" }, { framework: "ccss-ela", code: "RL.9-10.3" }],
      aiHelp: "hints-only",
      dueInDays: 20,
      rubric: rubric("rbr_sc-eng9-coming-of-age", "Literary analysis", [["theme", "Theme"], ["analysis", "Analysis of change"], ["evidence", "Textual evidence"]]),
      work: {
        [AMARA]: { stage: "draft", text: "In the story, the narrator begins the summer certain that her grandmother's garden is boring." },
        [ELENA]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [],
  discussions: [
    {
      key: "coming-of-age",
      title: "What makes a story a coming-of-age story?",
      prompt: "Name a book, film or show you think is a coming-of-age story. What moment marks the character's change? Reply to one classmate.",
      posts: [
        { author: AMARA, body: "*Inside Out 2*. Riley's change happens when she accepts that anxiety is part of her, not the boss of her." },
        { author: ELENA, body: "I like that example because the change is inside her head, not a big event. For me it's when a character makes a choice their parents wouldn't.", replyTo: 0 },
        { author: "prn_nf-teacher-rivera", body: "Both of you are pointing at a *threshold*: the moment after which the character can't go back. Keep that word in mind for Unit 2." },
      ],
    },
  ],
  announcements: [
    { title: "Essay conferences this week", body: "Sign up for a five-minute conference about your argument essay draft. The sign-up sheet is on the classroom door." },
    { title: "Library visit on Friday", body: "We meet in the library on Friday to choose independent reading books for Unit 2." },
  ],
  weeklyNote: "Students are drafting argument essays on community service requirements. Ask your student which side they chose and what the best argument against their position is.",
};

/** United States History, Period 5, with Riley Chen. */
export const US_HISTORY: ShowcaseCourse = {
  offeringId: "off_nf-ushist-fall-p5",
  band: "9-12",
  teacherId: "prn_nf-teacher-chen",
  modules: [
    {
      title: "Unit 3: Industrialization and Labor",
      page: {
        title: "Voices from the Mills",
        body: "## The first factory workers\n\nIn the 1830s and 1840s, textile mills in Lowell, Massachusetts hired thousands of young women from New England farms. Their letters and newspapers are among the richest sources we have on early industrial work.\n\nThis week: read a mill worker's letter and analyze it as historical evidence.",
      },
      items: [{ kind: "activity", key: "mill-letter" }],
    },
    {
      title: "Unit 4: The Progressive Era",
      page: {
        title: "Reformers and Their Targets",
        body: "## The Progressive Era (about 1890-1920)\n\nReformers took on child labor, unsafe food, corrupt city machines and monopolies. Their tools: **muckraking journalism**, **new laws**, and **constitutional amendments** (16th-19th).",
      },
      items: [{ kind: "activity", key: "progressive-reform" }, { kind: "discussion", key: "regulate-business" }],
    },
  ],
  activities: [
    {
      key: "mill-letter",
      template: "primary-source-analysis",
      title: "A Mill Worker Writes Home",
      overview: "Analyze a letter from a Lowell mill worker as a historian would.",
      sourcingQuestions: ["Who wrote the letter, to whom, and when?", "What might the writer want her family to believe, and why?"],
      contextualizationQuestions: ["What economic changes drew young women from farms to mills in the 1840s?", "What other sources would help confirm or challenge her account?"],
      claimPrompt: "What does this letter reveal about the costs and opportunities of early industrial work for young women? Support your claim with at least two quotations.",
      minimumEvidence: 2,
      resources: ["mill-letter"],
      standards: [{ framework: "c3", code: "D2.His.4.9-12" }, { framework: "c3", code: "D2.His.11.9-12" }],
      aiHelp: "hints-only",
      dueInDays: 8,
      rubric: rubric("rbr_sc-ushist-mill-letter", "Source analysis", [["sourcing", "Sourcing"], ["context", "Contextualization"], ["claim", "Claim and evidence"], ["corroboration", "Corroboration"]]),
      work: {
        [ELENA]: {
          stage: "released",
          text: "Sourcing: Written in 1845 by a young mill worker, Hannah, to her sister on the family farm. She may soften the hardships so her family won't worry, or so they keep letting her stay.\nContext: New England farms could not support every child, and mills offered cash wages.\nClaim: The letter shows that mill work traded independence for exhaustion. Hannah writes that she has \"money of my own for the first time,\" but also that \"the bell rules us from before light until after dark.\"\nCorroboration: The Lowell Offering and wage records could confirm her hours.",
          scores: { sourcing: 4, context: 3, claim: 4, corroboration: 3 },
          comment: "Elena, your sourcing paragraph is sophisticated: you saw why she might soften her account. Push your corroboration further: which records, and what would they show?",
        },
        [DMITRI]: {
          stage: "released",
          text: "The letter is by Hannah in 1845. She works at a mill. She says the bell rules them and that she has money. Mill work was hard but paid.",
          scores: { sourcing: 2, context: 1, claim: 2, corroboration: 1 },
          comment: "You found two good quotations, Dmitri. Now explain them: why does the bell matter? Come to office hours Thursday and we'll build the context paragraph together.",
        },
      },
    },
    {
      key: "progressive-reform",
      template: "writing-task",
      title: "The Most Important Progressive Reform",
      overview: "Argue which Progressive Era reform had the greatest long-term impact.",
      prompt: "Which Progressive Era reform had the greatest long-term impact on American life? Defend your choice against at least one alternative, using specific historical evidence.",
      genre: "argument",
      minWords: 500,
      minimumCitations: 0,
      standards: [{ framework: "c3", code: "D2.His.14.9-12" }, { framework: "c3", code: "D4.1.9-12" }],
      aiHelp: "hints-only",
      dueInDays: 21,
      rubric: rubric("rbr_sc-ushist-progressive", "Historical argument", [["claim", "Claim"], ["evidence", "Historical evidence"], ["alternatives", "Weighs alternatives"]]),
      work: {
        [ELENA]: { stage: "draft", text: "The Nineteenth Amendment had the greatest long-term impact because it doubled the electorate." },
        [DMITRI]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [],
  discussions: [
    {
      key: "regulate-business",
      title: "Should the government regulate big business?",
      prompt: "Progressives argued that monopolies harmed workers and consumers. Their critics said regulation slowed growth. Where do you stand, then and now? Use one historical example.",
      posts: [
        { author: ELENA, body: "Yes. *The Jungle* showed that without inspection laws, meatpackers sold spoiled food. The Meat Inspection Act protected everyone, not just workers." },
        { author: DMITRI, body: "Sometimes. Breaking up Standard Oil made sense, but too many rules can stop small businesses from starting.", replyTo: 0 },
      ],
    },
  ],
  announcements: [
    { title: "DBQ practice on Monday", body: "Monday we practice a document-based question in class. Bring your source analysis notes from the mill letter." },
  ],
  weeklyNote: "We analyzed a letter from a Lowell mill worker, weighing what it shows and what it might leave out. Next week begins the Progressive Era.",
};

/** The 9-12 band's classes. */
export const G912_COURSES: readonly ShowcaseCourse[] = [BIOLOGY, ENGLISH_9, US_HISTORY];
