// Number sense, version 1.0.0 (ADR-0016): counting and comparing within 10, one more and one less,
// then the number line as a model of distance and change: placing numbers, and addition and
// subtraction as jumps, first within 10 and then within 20. Each check activity uses fresh items,
// with no hints and one try.
//
// `__tests__/content.test.ts` recomputes every answer (a jump lands on start + change, inside the
// line) and checks every choice list holds its answer once.
//
// Status: draft, awaiting qualified review of representations and distractors.
import type { Item } from "./schema.ts";

const count = (key: string, emoji: string, label: string, n: number, choices: number[]): Item => ({
  type: "count-objects", key, picture: { emoji, label }, count: n, choices, answer: n,
  prompt: `How many ${label}? Count them, then tap the number.`,
  hint: "Touch each one as you count it, and count each one only once.",
});

const compare = (key: string, emoji: string, label: string, left: number, right: number, ask: "more" | "fewer"): Item => ({
  type: "compare-groups", key, picture: { emoji, label }, left, right, ask,
  answer: (ask === "more") === (left > right) ? "left" : "right",
  prompt: `Which side has ${ask} ${label}? Tap it.`,
  hint: "Count each side. Then compare the two numbers.",
});

const oneMoreLess = (key: string, start: number, change: 1 | -1, choices: number[]): Item => ({
  type: "one-more-less", key, start, change, choices, answer: start + change,
  prompt: `Here are ${start} dots. What number is one ${change > 0 ? "more" : "less"}?`,
  hint: change > 0 ? `Count the dots, then count one more: ${start}, …` : `Count back one from ${start}.`,
});

const place = (max: 10 | 20, target: number): Item => ({
  type: "place-on-line", key: `place-${max}-${target}`, max, target, answer: target,
  prompt: `Find ${target} on the number line. Tap it.`,
  hint: `Start at 0 and count each mark: 1, 2, 3… until you reach ${target}.`,
});

const jump = (max: 10 | 20, start: number, change: number): Item => {
  const forward = change > 0;
  const steps = Math.abs(change);
  const path = Array.from({ length: Math.min(steps, 3) }, (_, i) => start + (forward ? i + 1 : -(i + 1)));
  return {
    type: "number-line-jump", key: `jump-${max}-${start}-${forward ? "plus" : "minus"}-${steps}`, max, start, change, answer: start + change,
    prompt: `Start on ${start}. Make ${steps} ${steps === 1 ? "jump" : "jumps"} ${forward ? "forward" : "back"}. Where do you land?`,
    hint: `Put your finger on ${start}. Don't count ${start} itself. Count each jump: ${path.join(", ")}${steps > 3 ? ", …" : ""}.`,
  };
};

const LINE_GUIDE = "A number line shows numbers as distances. Count the jumps, not the marks: starting on 6 and making 3 jumps lands on 9. Counting the starting mark as \"one\" (landing on 8) is the most common mistake, and the progress page names it when it happens.";

/** Number sense 1.0.0. */
export const NUMBER_SENSE = {
  id: "number-sense",
  version: "1.0.0",
  track: "math",
  title: "Number sense and the number line",
  summary: "Count and compare small amounts, find one more and one less, then use a number line to place numbers and to add and subtract by jumping, within 10 and then within 20.",
  gradeBands: ["K", "1", "2"],
  language: "en",
  review: { status: "draft", scope: "Awaiting qualified review of representations, distractors and the number-line sequence." },
  startFor: { K: "count-to-5", "1": "place-on-line-10", "2": "place-on-line-20" },
  skills: [
    { id: "count.within-10", strand: "counting", title: "Count objects to 10", description: "Counts up to ten objects, touching each once, and knows the last number said is how many.", standards: ["CCSS.MATH.CONTENT.K.CC.B.5", "CCSS.MATH.CONTENT.K.CC.B.4.B"] },
    { id: "compare.within-10", strand: "comparing", title: "Compare groups", description: "Tells which of two groups has more or fewer.", standards: ["CCSS.MATH.CONTENT.K.CC.C.6"] },
    { id: "count.one-more-less", strand: "counting", title: "One more, one less", description: "Knows each next number is one more, and the one before is one less.", standards: ["CCSS.MATH.CONTENT.K.CC.B.4.C"] },
    { id: "line.place-10", strand: "number-line", title: "Place numbers to 10 on a line", description: "Finds where a number goes on a number line from 0 to 10.", standards: ["CCSS.MATH.CONTENT.2.MD.B.6"] },
    { id: "line.add-10", strand: "addition", title: "Add by jumping, within 10", description: "Adds by counting on along a number line, counting jumps rather than marks.", standards: ["CCSS.MATH.CONTENT.1.OA.C.5", "CCSS.MATH.CONTENT.K.OA.A.2"] },
    { id: "line.subtract-10", strand: "subtraction", title: "Subtract by jumping back, within 10", description: "Subtracts by counting back along a number line.", standards: ["CCSS.MATH.CONTENT.1.OA.C.5", "CCSS.MATH.CONTENT.K.OA.A.2"] },
    { id: "line.place-20", strand: "number-line", title: "Place numbers to 20 on a line", description: "Finds where a number goes on a number line from 0 to 20.", standards: ["CCSS.MATH.CONTENT.2.MD.B.6"] },
    { id: "line.add-20", strand: "addition", title: "Add by jumping, within 20", description: "Adds within 20 by counting on along a number line.", standards: ["CCSS.MATH.CONTENT.1.OA.C.6"] },
    { id: "line.subtract-20", strand: "subtraction", title: "Subtract by jumping back, within 20", description: "Subtracts within 20 by counting back along a number line.", standards: ["CCSS.MATH.CONTENT.1.OA.C.6"] },
  ],
  activities: [
    {
      key: "count-to-5", title: "Count to 5", skill: "count.within-10", mode: "practice", minutes: 4,
      preview: "Your child counts up to five pictures and taps the number.",
      adultGuide: "Watch for touching each picture once. If your child recounts and gets a new number, that's a sign to slow down and touch as they count.",
      directions: "Count the pictures. Tap the number that tells how many.",
      example: "One, two, three apples. There are three. I tap 3.",
      itemsPerSession: 5,
      items: [count("apples", "🍎", "apples", 3, [2, 3, 4]), count("fish", "🐟", "fish", 5, [4, 5, 6]), count("star", "⭐", "stars", 1, [1, 2, 3]), count("ladybugs", "🐞", "ladybugs", 4, [3, 4, 5]), count("flowers", "🌸", "flowers", 2, [1, 2, 3]), count("cars", "🚗", "cars", 5, [3, 5, 6])],
    },
    {
      key: "count-to-10", title: "Count to 10", skill: "count.within-10", mode: "practice", minutes: 5, after: ["count-to-5"],
      preview: "Your child counts up to ten pictures, including an empty tray (zero).",
      adultGuide: "Zero is a number too: an empty tray has zero. Ten-frame rows of five make bigger amounts easier to see.",
      directions: "Count the pictures. Tap the number that tells how many.",
      example: "One, two, three, four, five, six, seven strawberries. I tap 7.",
      itemsPerSession: 5,
      items: [count("strawberries", "🍓", "strawberries", 7, [6, 7, 8]), count("ducks", "🦆", "ducks", 9, [8, 9, 10]), count("balloons", "🎈", "balloons", 6, [5, 6, 7]), count("cookies", "🍪", "cookies", 10, [8, 9, 10]), count("turtles", "🐢", "turtles", 8, [7, 8, 9]), count("none", "🍩", "donuts", 0, [0, 1, 2]), count("socks", "🧦", "socks", 7, [6, 7, 9])],
    },
    {
      key: "compare-groups", title: "More or fewer?", skill: "compare.within-10", mode: "practice", minutes: 4, after: ["count-to-10"],
      preview: "Two groups of pictures: your child taps the side with more, or with fewer.",
      adultGuide: "\"Fewer\" is a new word for many children. Practice it in everyday life: who has fewer crackers?",
      directions: "Look at both sides. Tap the side the question asks for.",
      example: "Left has 4 bees, right has 2. Which has more? Left, because 4 is more than 2.",
      itemsPerSession: 5,
      items: [compare("bees-more", "🐝", "bees", 4, 2, "more"), compare("frogs-fewer", "🐸", "frogs", 6, 3, "fewer"), compare("pears-more", "🍐", "pears", 5, 8, "more"), compare("boats-fewer", "⛵", "boats", 2, 7, "fewer"), compare("leaves-more", "🍃", "leaves", 9, 6, "more"), compare("moons-fewer", "🌙", "moons", 5, 4, "fewer")],
    },
    {
      key: "one-more-less", title: "One more, one less", skill: "count.one-more-less", mode: "practice", minutes: 4, after: ["count-to-10"],
      preview: "Your child sees some dots and finds the number that is one more or one less.",
      adultGuide: "One more is the next number when you count. One less is the number just before.",
      directions: "Count the dots. Then find the number that is one more, or one less.",
      example: "Here are 5 dots. One more is 6.",
      itemsPerSession: 5,
      items: [oneMoreLess("more-5", 5, 1, [4, 6, 7]), oneMoreLess("less-7", 7, -1, [6, 8, 5]), oneMoreLess("more-3", 3, 1, [2, 4, 5]), oneMoreLess("less-4", 4, -1, [3, 5, 2]), oneMoreLess("more-9", 9, 1, [8, 10, 11]), oneMoreLess("less-1", 1, -1, [0, 1, 2])],
    },
    {
      key: "place-on-line-10", title: "Find numbers on the line", skill: "line.place-10", mode: "practice", minutes: 4, after: ["one-more-less"],
      preview: "A number line from 0 to 10. Your child taps where a number belongs.",
      adultGuide: LINE_GUIDE,
      directions: "Find the number on the number line and tap it.",
      example: "Where is 4? I start at 0 and count the marks: 1, 2, 3, 4. Here.",
      itemsPerSession: 5,
      items: [place(10, 3), place(10, 7), place(10, 5), place(10, 9), place(10, 1), place(10, 8)],
    },
    {
      key: "jump-forward-10", title: "Jump forward (add)", skill: "line.add-10", mode: "practice", minutes: 5, after: ["place-on-line-10"],
      preview: "Start on a number and make jumps forward to add. For example, start on 6, make 3 jumps, and land on 9.",
      adultGuide: LINE_GUIDE,
      directions: "Start on the first number. Jump forward, counting each jump. Tap where you land.",
      example: "Start on 6. Jump 3 times: 7, 8, 9. I land on 9, so 6 plus 3 is 9.",
      itemsPerSession: 5,
      items: [jump(10, 2, 3), jump(10, 6, 3), jump(10, 4, 2), jump(10, 1, 5), jump(10, 5, 4), jump(10, 7, 3), jump(10, 0, 4), jump(10, 3, 3)],
    },
    {
      key: "jump-back-10", title: "Jump back (subtract)", skill: "line.subtract-10", mode: "practice", minutes: 5, after: ["jump-forward-10"],
      preview: "Start on a number and jump back to subtract.",
      adultGuide: LINE_GUIDE,
      directions: "Start on the first number. Jump back, counting each jump. Tap where you land.",
      example: "Start on 9. Jump back 3: 8, 7, 6. I land on 6, so 9 take away 3 is 6.",
      itemsPerSession: 5,
      items: [jump(10, 9, -3), jump(10, 7, -2), jump(10, 10, -4), jump(10, 5, -5), jump(10, 8, -3), jump(10, 6, -1), jump(10, 4, -2)],
    },
    {
      key: "check-add-10", title: "Check: jump forward", skill: "line.add-10", mode: "check", minutes: 4, after: ["jump-forward-10"],
      preview: "Fresh addition jumps within 10, no hints and one try.",
      adultGuide: "Please don't help on this one: it shows what your child can do on their own.",
      directions: "Jump forward by yourself and tap where you land.",
      example: "Start on the first number and count your jumps.",
      itemsPerSession: 5,
      items: [jump(10, 3, 4), jump(10, 2, 6), jump(10, 5, 2), jump(10, 1, 7), jump(10, 6, 4)],
    },
    {
      key: "check-subtract-10", title: "Check: jump back", skill: "line.subtract-10", mode: "check", minutes: 4, after: ["jump-back-10"],
      preview: "Fresh subtraction jumps within 10, no hints and one try.",
      adultGuide: "Please don't help on this one: it shows what your child can do on their own.",
      directions: "Jump back by yourself and tap where you land.",
      example: "Start on the first number and count your jumps back.",
      itemsPerSession: 5,
      items: [jump(10, 8, -2), jump(10, 10, -3), jump(10, 9, -4), jump(10, 7, -5), jump(10, 6, -3)],
    },
    {
      key: "place-on-line-20", title: "Find numbers to 20", skill: "line.place-20", mode: "practice", minutes: 4, after: ["check-add-10"],
      preview: "A number line from 0 to 20. Your child taps where a number belongs.",
      adultGuide: "Ten is a landmark: numbers after 10 are \"ten and some more\". 14 is 10 and 4 more.",
      directions: "Find the number on the number line and tap it.",
      example: "Where is 13? I find 10, then count 3 more: 11, 12, 13.",
      itemsPerSession: 5,
      items: [place(20, 12), place(20, 15), place(20, 18), place(20, 11), place(20, 20), place(20, 14)],
    },
    {
      key: "jump-forward-20", title: "Jump forward within 20", skill: "line.add-20", mode: "practice", minutes: 5, after: ["place-on-line-20"],
      preview: "Addition by jumping forward on a number line to 20.",
      adultGuide: LINE_GUIDE,
      directions: "Start on the first number. Jump forward, counting each jump. Tap where you land.",
      example: "Start on 8. Jump 5 times: 9, 10, 11, 12, 13. I land on 13.",
      itemsPerSession: 5,
      items: [jump(20, 8, 5), jump(20, 11, 4), jump(20, 9, 6), jump(20, 13, 5), jump(20, 7, 7), jump(20, 14, 3), jump(20, 10, 8)],
    },
    {
      key: "jump-back-20", title: "Jump back within 20", skill: "line.subtract-20", mode: "practice", minutes: 5, after: ["jump-forward-20"],
      preview: "Subtraction by jumping back on a number line to 20.",
      adultGuide: LINE_GUIDE,
      directions: "Start on the first number. Jump back, counting each jump. Tap where you land.",
      example: "Start on 15. Jump back 4: 14, 13, 12, 11. I land on 11.",
      itemsPerSession: 5,
      items: [jump(20, 15, -4), jump(20, 13, -5), jump(20, 18, -6), jump(20, 12, -3), jump(20, 20, -5), jump(20, 16, -7)],
    },
    {
      key: "check-add-20", title: "Check: jump forward within 20", skill: "line.add-20", mode: "check", minutes: 4, after: ["jump-forward-20"],
      preview: "Fresh addition jumps within 20, no hints and one try.",
      adultGuide: "Please don't help on this one: it shows what your child can do on their own.",
      directions: "Jump forward by yourself and tap where you land.",
      example: "Start on the first number and count your jumps.",
      itemsPerSession: 5,
      items: [jump(20, 12, 5), jump(20, 6, 8), jump(20, 15, 4), jump(20, 9, 9), jump(20, 11, 7)],
    },
    {
      key: "check-subtract-20", title: "Check: jump back within 20", skill: "line.subtract-20", mode: "check", minutes: 4, after: ["jump-back-20"],
      preview: "Fresh subtraction jumps within 20, no hints and one try.",
      adultGuide: "Please don't help on this one: it shows what your child can do on their own.",
      directions: "Jump back by yourself and tap where you land.",
      example: "Start on the first number and count your jumps back.",
      itemsPerSession: 5,
      items: [jump(20, 17, -5), jump(20, 14, -6), jump(20, 19, -8), jump(20, 11, -4), jump(20, 20, -9)],
    },
  ],
};
