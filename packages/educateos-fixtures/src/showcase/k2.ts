// K-2: Kindergarten Science (Weather Watchers), Grade 1 Reading Foundations and Grade 1 Math at
// Northfield Elementary. Prompts are short and concrete, written to be read aloud.
//
// These classes use the writing, investigation and problem-set templates for now. When the K-2
// templates land (SCHO-323: picture choice, drawing, audio response and read-aloud), the activities
// marked "K-2 template:" below should move to them.
import { EARLY_LEVELS, rubric } from "./rubrics.ts";
import type { ShowcaseCourse } from "./types.ts";

const SOFIA = "prn_nf-student-sofia";
const NOAH = "prn_nf-student-noah";
const AIYANA = "prn_nf-student-aiyana";
const MATEO = "prn_nf-student-mateo";
const PRIYA = "prn_nf-student-priya";
const JONAH = "prn_nf-student-jonah";

/** Kindergarten Science: Weather Watchers, Room 4, with Lena Marsh. Science has no built-in standards, so nothing is aligned. */
export const K_SCIENCE: ShowcaseCourse = {
  offeringId: "off_nf-ksci-fall-r4",
  band: "K-2",
  teacherId: "prn_nf-teacher-marsh",
  modules: [
    {
      title: "Look Up! What Is the Weather?",
      page: {
        title: "Welcome, Weather Watchers!",
        body: "## Look up! ☀️ 🌧️ ❄️\n\nEvery morning we look out the window.\n\n- Is it **sunny**? ☀️\n- Is it **rainy**? 🌧️\n- Is it **snowy**? ❄️\n- Is it **windy**? 🌬️\n\nWe draw what we see on our weather chart.",
      },
      items: [{ kind: "activity", key: "weather-chart" }, { kind: "quiz", key: "weather-words" }],
    },
    {
      title: "Dress for the Weather",
      page: {
        title: "What Do We Wear?",
        body: "## Get ready to go outside 🧥 👢 🧢\n\nWhen it is cold, we wear a **coat**.\n\nWhen it rains, we wear **boots** and bring an **umbrella** ☂️.\n\nWhen it is hot, we wear a **hat** and drink **water**.",
      },
      items: [{ kind: "activity", key: "dress-for-weather" }],
    },
  ],
  activities: [
    {
      // K-2 template: a picture-choice daily chart once picture templates exist.
      key: "weather-chart",
      template: "science-investigation",
      title: "My Weather Chart",
      overview: "Look outside each day this week. Show the weather on your chart.",
      question: "What will the weather be this week?",
      methodPrompt: "Look out the window each morning. Tell a grown-up what you see.",
      dataColumns: [{ name: "Day" }, { name: "Weather" }, { name: "Warm or cold" }],
      analysisPrompt: "Which weather did we see the most?",
      standards: [],
      aiHelp: "none",
      dueInDays: 7,
      rubric: rubric("rbr_sc-ksci-weather-chart", "Weather chart", [["observe", "I looked and told what I saw"], ["record", "I filled in my chart"]], EARLY_LEVELS),
      work: {
        [SOFIA]: {
          stage: "released",
          text: "Monday: sunny ☀️, warm. Tuesday: rainy 🌧️, cold. Wednesday: sunny ☀️. Thursday: cloudy ☁️. Friday: sunny ☀️. We saw sunny the most!",
          scores: { observe: 3, record: 3 },
          comment: "Wonderful watching, Sofia! You saw sunny three times. ☀️☀️☀️",
        },
        [NOAH]: { stage: "submitted", text: "Monday: rain 🌧️. Tuesday: rain. Wednesday: wind 🌬️. It was rainy the most." },
        [AIYANA]: { stage: "draft", text: "Monday: sunny ☀️. Tuesday: cloudy ☁️." },
      },
    },
    {
      // K-2 template: a drawing with a recorded "tell me about it" once draw and audio templates exist.
      key: "dress-for-weather",
      template: "writing-task",
      title: "Dress for a Rainy Day",
      overview: "Draw yourself ready for a rainy day. Tell what you are wearing.",
      prompt: "It is raining! 🌧️ What will you wear outside? Draw it, then say or write two things you put on.",
      genre: "narrative",
      minimumCitations: 0,
      standards: [],
      aiHelp: "none",
      dueInDays: 10,
      rubric: rubric("rbr_sc-ksci-dress", "Dress for the weather", [["clothes", "I chose clothes for the weather"], ["tell", "I told about my picture"]], EARLY_LEVELS),
      work: {
        [SOFIA]: { stage: "graded", text: "I wear my yellow boots and my rain coat. I hold a umbrella.", scores: { clothes: 3, tell: 2 }, comment: "Great choices! Can you tell me why boots help in the rain?" },
        [NOAH]: { stage: "released", text: "Boots. Coat. My hat with a dinosaur.", scores: { clothes: 3, tell: 3 }, comment: "A dinosaur hat to stay dry, how fun! You picked just the right clothes." },
        [AIYANA]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [
    {
      key: "weather-words",
      title: "Weather Words",
      description: "Listen to each question. Tap the picture or word that matches.",
      items: [
        { type: "multiple-choice", prompt: "Which picture shows **rain**?", points: 1, choices: [{ id: "rain", text: "🌧️" }, { id: "sun", text: "☀️" }, { id: "snow", text: "⛄" }], correctChoiceId: "rain" },
        { type: "multiple-choice", prompt: "Which word goes with this picture? ☀️", points: 1, choices: [{ id: "sun", text: "sun" }, { id: "snow", text: "snow" }, { id: "wind", text: "wind" }], correctChoiceId: "sun" },
        { type: "multiple-choice", prompt: "Which picture shows **snow**?", points: 1, choices: [{ id: "wind", text: "🌬️" }, { id: "snow", text: "❄️" }, { id: "cloud", text: "☁️" }], correctChoiceId: "snow" },
        { type: "numeric", prompt: "Count the clouds. ☁️ ☁️ ☁️ How many clouds?", points: 1, answer: 3, tolerance: 0 },
        { type: "true-false", prompt: "🧥 We wear a coat when it is cold.", points: 1, correct: true },
      ],
      attempts: {
        [SOFIA]: [{ type: "multiple-choice", choiceId: "rain" }, { type: "multiple-choice", choiceId: "sun" }, { type: "multiple-choice", choiceId: "snow" }, { type: "numeric", value: 3 }, { type: "true-false", value: true }],
        [NOAH]: [{ type: "multiple-choice", choiceId: "rain" }, { type: "multiple-choice", choiceId: "sun" }, { type: "multiple-choice", choiceId: "cloud" }, { type: "numeric", value: 3 }, { type: "true-false", value: true }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Weather walk on Thursday", body: "We are going on a weather walk Thursday morning. Please send a jacket, even if it looks sunny!" },
    { title: "Thank you for the rain boots", body: "Thank you, families, for the extra rain boots for our class closet. Every Weather Watcher can now go puddle-checking." },
  ],
  weeklyNote: "This week we watched the sky every morning and kept a weather chart. Ask your child: what was the weather today, and what should we wear tomorrow?",
};

/** Grade 1 Reading Foundations, Room 7, with Daniel Yazzie. */
export const G1_READING: ShowcaseCourse = {
  offeringId: "off_nf-g1read-fall-r7",
  band: "K-2",
  teacherId: "prn_nf-teacher-yazzie",
  modules: [
    {
      title: "Short Vowel Sounds",
      page: {
        title: "Sounds We Know",
        body: "## Short vowels 🐱 🐷 🐙\n\nEvery word has a vowel: **a, e, i, o, u**.\n\n- c**a**t 🐱 — short **a**\n- p**i**g 🐷 — short **i**\n- d**o**g 🐶 — short **o**\n\nTap each sound with your finger, then blend them: **c - a - t**, *cat*!",
      },
      items: [{ kind: "activity", key: "word-builders" }, { kind: "quiz", key: "short-vowels" }],
    },
    {
      title: "Stories We Love",
      page: {
        title: "The Little Seed",
        body: "## The Little Seed 🌱\n\nA little seed fell into the dirt.\n\n**First**, the rain came and gave it a drink. 🌧️\n\n**Next**, the sun came and kept it warm. ☀️\n\n**Last**, a tiny green sprout popped up to say hello! 🌱\n\nWho helped the seed grow?",
      },
      items: [{ kind: "activity", key: "retell-seed" }],
    },
  ],
  activities: [
    {
      // K-2 template: picture choice plus an audio "read it to me" response.
      key: "word-builders",
      template: "problem-set",
      title: "Word Builders",
      overview: "Change one sound to make a new word.",
      problems: [
        { prompt: "Say **cat** 🐱. Change the first sound to /h/. What word did you make?", answer: "hat" },
        { prompt: "Say **pig** 🐷. Change the first sound to /b/. What word did you make?", answer: "big" },
        { prompt: "Say **hop**. Change the last sound to /t/. What word did you make?", answer: "hot" },
      ],
      showWork: false,
      standards: [{ framework: "ccss-ela", code: "RF.1.3" }, { framework: "ccss-ela", code: "RF.1.2" }],
      aiHelp: "none",
      dueInDays: 5,
      rubric: rubric("rbr_sc-g1read-word-builders", "Word builders", [["sounds", "I changed the sound"], ["read", "I read my new word"]], EARLY_LEVELS),
      work: {
        [MATEO]: { stage: "released", text: "1. hat 2. big 3. hot", scores: { sounds: 3, read: 3 }, comment: "You are a word-building star, Mateo! ⭐" },
        [PRIYA]: { stage: "released", text: "1. hat 2. bag 3. hot", scores: { sounds: 2, read: 3 }, comment: "So close on number 2! Pig becomes b-i-g. Let's tap it out together." },
        [JONAH]: { stage: "submitted", text: "1. hat 2. big 3. hop" },
      },
    },
    {
      // K-2 template: read-aloud of the story, then an audio retelling.
      key: "retell-seed",
      template: "writing-task",
      title: "Retell The Little Seed",
      overview: "Tell what happened first, next and last.",
      prompt: "Read \"The Little Seed\" with a grown-up. Tell what happened **first**, **next** and **last**.",
      genre: "narrative",
      minimumCitations: 0,
      resources: ["little-seed"],
      standards: [{ framework: "ccss-ela", code: "RL.1.2" }],
      aiHelp: "none",
      dueInDays: 9,
      rubric: rubric("rbr_sc-g1read-retell", "Retell", [["order", "I told it in order"], ["details", "I told important parts"]], EARLY_LEVELS),
      work: {
        [MATEO]: { stage: "graded", text: "First the rain came. Next the sun was warm. Last a sprout popped up!", scores: { order: 3, details: 3 }, comment: "You used first, next and last just like a real storyteller!" },
        [PRIYA]: { stage: "draft", text: "First the seed fell in the dirt." },
        [JONAH]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [
    {
      key: "short-vowels",
      title: "Short Vowel Pictures",
      description: "Say the name of each picture out loud. Listen for the middle sound.",
      items: [
        { type: "multiple-choice", prompt: "Which picture has the short **a** sound, like in *map*?", points: 1, choices: [{ id: "cat", text: "🐱 cat" }, { id: "dog", text: "🐶 dog" }, { id: "fish", text: "🐟 fish" }], correctChoiceId: "cat" },
        { type: "multiple-choice", prompt: "Which picture has the short **i** sound, like in *sit*?", points: 1, choices: [{ id: "sun", text: "☀️ sun" }, { id: "pig", text: "🐷 pig" }, { id: "bed", text: "🛏️ bed" }], correctChoiceId: "pig" },
        { type: "multiple-choice", prompt: "Which picture has the short **u** sound, like in *cup*?", points: 1, choices: [{ id: "bus", text: "🚌 bus" }, { id: "hat", text: "🎩 hat" }, { id: "fox", text: "🦊 fox" }], correctChoiceId: "bus" },
        { type: "short-answer", prompt: "Blend the sounds: **s - u - n**. What word is it?", points: 1, acceptedAnswers: ["sun"] },
      ],
      attempts: {
        [MATEO]: [{ type: "multiple-choice", choiceId: "cat" }, { type: "multiple-choice", choiceId: "pig" }, { type: "multiple-choice", choiceId: "bus" }, { type: "short-answer", text: "sun" }],
        [PRIYA]: [{ type: "multiple-choice", choiceId: "cat" }, { type: "multiple-choice", choiceId: "bed" }, { type: "multiple-choice", choiceId: "bus" }, { type: "short-answer", text: "sun" }],
        [JONAH]: [{ type: "multiple-choice", choiceId: "dog" }, { type: "multiple-choice", choiceId: "pig" }, { type: "multiple-choice", choiceId: "bus" }, { type: "short-answer", text: "son" }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Book bags go home on Fridays", body: "Each Friday your child brings home a book bag with two books at their reading level. Please read together and return the bag on Monday." },
  ],
  weeklyNote: "We practiced short vowel sounds and changed one sound to make a new word (cat → hat). At home, try a word game in the car: what new word can you make from \"pig\"?",
};

/** Grade 1 Mathematics, Room 7, with Daniel Yazzie. */
export const G1_MATH: ShowcaseCourse = {
  offeringId: "off_nf-g1math-fall-r7",
  band: "K-2",
  teacherId: "prn_nf-teacher-yazzie",
  modules: [
    {
      title: "Adding and Taking Away Within 20",
      page: {
        title: "Story Problems",
        body: "## Math stories 🍎\n\nA story problem tells a little story with numbers.\n\n1. Read the story.\n2. Draw it or use counters.\n3. Write a number sentence, like **8 + 5 = 13**.",
      },
      items: [{ kind: "activity", key: "story-problems" }, { kind: "quiz", key: "count-and-compare" }],
    },
    {
      title: "Tens and Ones",
      page: {
        title: "Bundles of Ten",
        body: "## Tens and ones 🔟\n\nTen ones make **one ten**.\n\nThe number **34** is **3 tens** and **4 ones**.\n\n🔟🔟🔟 ➕ 1️⃣1️⃣1️⃣1️⃣",
      },
      items: [{ kind: "activity", key: "tens-and-ones" }],
    },
  ],
  activities: [
    {
      key: "story-problems",
      template: "problem-set",
      title: "Apple Orchard Story Problems",
      overview: "Solve each story. Draw a picture to show how you know.",
      problems: [
        { prompt: "A bear has 8 apples 🍎. She picks 5 more. How many apples does she have now?", answer: "13" },
        { prompt: "There are 12 birds 🐦 on a tree. 4 fly away. How many birds are left?", answer: "8" },
        { prompt: "A fox has 6 red apples and 7 green apples. How many apples in all?", answer: "13" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "1.OA.A.1" }],
      aiHelp: "hints-only",
      dueInDays: 7,
      rubric: rubric("rbr_sc-g1math-story", "Story problems", [["answer", "My answers are right"], ["show", "I showed how I know"]], EARLY_LEVELS),
      work: {
        [MATEO]: { stage: "released", text: "1. 8 + 5 = 13 (I counted on from 8)\n2. 12 - 4 = 8\n3. 6 + 7 = 13", scores: { answer: 3, show: 3 }, comment: "Counting on from 8 is a smart strategy!" },
        [PRIYA]: { stage: "released", text: "1. 13\n2. 8\n3. 12", scores: { answer: 2, show: 1 }, comment: "Check number 3 with your counters. Draw your apples so I can see your thinking." },
        [JONAH]: { stage: "graded", text: "1. 8 + 5 = 13\n2. 12 - 4 = 8\n3. 6 + 7 = 13 (doubles plus one!)", scores: { answer: 3, show: 3 }, comment: "Doubles plus one, wow! Teach that trick to a friend." },
      },
    },
    {
      key: "tens-and-ones",
      template: "problem-set",
      title: "Tens and Ones",
      overview: "Show each number as tens and ones.",
      problems: [
        { prompt: "Show **34** as tens and ones.", answer: "3 tens and 4 ones" },
        { prompt: "Show **50** as tens and ones.", answer: "5 tens and 0 ones" },
        { prompt: "What number is **1 ten and 7 ones**?", answer: "17" },
      ],
      showWork: true,
      standards: [{ framework: "ccss-math", code: "1.NBT.B.2" }],
      aiHelp: "hints-only",
      dueInDays: 14,
      rubric: rubric("rbr_sc-g1math-tens", "Tens and ones", [["place-value", "I showed tens and ones"]], EARLY_LEVELS),
      work: {
        [MATEO]: { stage: "submitted", text: "34 = 3 tens 4 ones. 50 = 5 tens 0 ones. 17." },
        [PRIYA]: { stage: "draft", text: "34 = 3 tens and 4 ones" },
        [JONAH]: { stage: "not-started" },
      },
    },
  ],
  quizzes: [
    {
      key: "count-and-compare",
      title: "Count and Compare",
      description: "Count the pictures. Then answer.",
      items: [
        { type: "numeric", prompt: "How many stars? ⭐⭐⭐⭐⭐⭐⭐", points: 1, answer: 7, tolerance: 0 },
        { type: "numeric", prompt: "How many apples? 🍎🍎🍎🍎🍎🍎🍎🍎🍎🍎🍎🍎", points: 1, answer: 12, tolerance: 0 },
        { type: "multiple-choice", prompt: "Which group has **more**?", points: 1, choices: [{ id: "a", text: "🍓🍓🍓" }, { id: "b", text: "🍓🍓🍓🍓🍓" }], correctChoiceId: "b" },
        { type: "multiple-choice", prompt: "What is **9 + 1**?", points: 1, choices: [{ id: "eight", text: "8" }, { id: "ten", text: "10" }, { id: "eleven", text: "11" }], correctChoiceId: "ten" },
      ],
      attempts: {
        [MATEO]: [{ type: "numeric", value: 7 }, { type: "numeric", value: 12 }, { type: "multiple-choice", choiceId: "b" }, { type: "multiple-choice", choiceId: "ten" }],
        [PRIYA]: [{ type: "numeric", value: 7 }, { type: "numeric", value: 11 }, { type: "multiple-choice", choiceId: "b" }, { type: "multiple-choice", choiceId: "ten" }],
        [JONAH]: [{ type: "numeric", value: 7 }, { type: "numeric", value: 12 }, { type: "multiple-choice", choiceId: "b" }, { type: "multiple-choice", choiceId: "eleven" }],
      },
      releaseScores: true,
    },
  ],
  discussions: [],
  announcements: [
    { title: "Counting collections", body: "Please send in a small bag of buttons, pasta or bottle caps for our counting collections. We will count them in tens!" },
  ],
  weeklyNote: "We solved story problems by drawing pictures and counting on. Ask your child to make up a story problem about snacks at dinner.",
};

/** The K-2 band's classes. */
export const K2_COURSES: readonly ShowcaseCourse[] = [K_SCIENCE, G1_READING, G1_MATH];
