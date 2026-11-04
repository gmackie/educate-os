// The simulated tutors' scripts (SCHO-324). The demo has no AI, so each band's tutor (SCHO-325)
// answers from a script: band-appropriate replies to its one-tap questions about each showcase
// activity, and what Hall Monitor, which screens every message on the live district, would decide
// about each message. The tutors' names, faces, greetings and manners are the bundled blueprints'
// own personas; their personal-details check is the tutor library's.
import { PERSONA as K2 } from "@gadgets/bundled-blueprints/blueprints/tutor-k2/persona";
import { PERSONA as G35 } from "@gadgets/bundled-blueprints/blueprints/tutor-3-5/persona";
import { PERSONA as G68 } from "@gadgets/bundled-blueprints/blueprints/tutor-6-8/persona";
import { PERSONA as G912 } from "@gadgets/bundled-blueprints/blueprints/tutor-9-12/persona";
import { holdsPersonalDetails, type TutorPersona } from "@gadgets/bundled-blueprints/libraries/tutor/server";
import type { GradeBand } from "../districts/index.ts";

/** Each band's tutor, as its bundled blueprint declares it. */
export const TUTORS: Readonly<Record<GradeBand, TutorPersona>> = { "K-2": K2, "3-5": G35, "6-8": G68, "9-12": G912 };

/** What Hall Monitor decided about one message, as the live district's screening would. */
export type Screening =
  /** On topic and safe: sent to the model. */
  | { verdict: "allowed" }
  /** Not for this tutor or this age: not sent; the tutor steers back kindly. */
  | { verdict: "redirected"; why: string }
  /** Holds contact details or an address: neither sent nor kept. */
  | { verdict: "held"; why: string }
  /**
   * Free text the preview's script does not cover. Nothing is screened or sent anywhere: the preview
   * only says it follows a script (SCHO-328).
   */
  | { verdict: "unscripted" };

/** One scripted exchange: what the learner taps or types, and how the tutor answers. */
export interface Exchange {
  ask: string;
  reply: string;
  screening: Screening;
}

/** A tutor's script for one activity, or its fallback for any other. */
interface Script {
  /** The tutor's first words about this activity, after its greeting. */
  opener: string;
  exchanges: readonly Exchange[];
}

const allowed: Screening = { verdict: "allowed" };
const offTopic = (why: string): Screening => ({ verdict: "redirected", why });

/** The scripts, by band and by activity title; `*` is the band's script for any other activity. */
const SCRIPTS: Readonly<Record<GradeBand, Readonly<Record<string, Script>>>> = {
  "K-2": {
    "Retell The Little Seed": {
      opener: "Let's read The Little Seed! Tap \"Read it again\" to hear it. 🌱",
      exchanges: [
        { ask: "Read it again", reply: "A little seed fell into the dirt. First, the rain came. Next, the sun came. Last, a sprout popped up! Who helped the seed?", screening: allowed },
        { ask: "What happened first?", reply: "Something fell from the clouds. It gave the seed a drink. What was it?", screening: allowed },
        { ask: "Give me a hint", reply: "It is wet. It makes puddles. It starts with r-r-r. What is it?", screening: allowed },
        { ask: "It was the rain!", reply: "Yes! You remembered! The rain came first. Now, what kept the seed warm?", screening: allowed },
        { ask: "Tell me a scary story", reply: "Let's keep our story cozy today! Our seed is waiting. What happened last?", screening: offTopic("not about this story, and not for grades K–2") },
        { ask: "I'm done!", reply: "You did it! You sounded like a real storyteller. Now tap the microphone and tell it your way!", screening: allowed },
      ],
    },
    "Word Builders": {
      opener: "Let's build words! Say each sound with me. 🧱",
      exchanges: [
        { ask: "Give me a hint", reply: "Say pig slowly. p-i-g. Now change p to b. b-i-g. What word did you make?", screening: allowed },
        { ask: "Is it big?", reply: "Yes! Big! You changed one sound and made a new word!", screening: allowed },
        { ask: "Tell me a scary story", reply: "Let's stick with our words today! Try this one: cat. Change c to h. What is it?", screening: offTopic("not about this activity, and not for grades K–2") },
        { ask: "I'm done!", reply: "Great building! Now write your new words in the boxes.", screening: allowed },
      ],
    },
    "*": {
      opener: "I can read with you, or help with a tricky word. 📖",
      exchanges: [
        { ask: "Read it again", reply: "Let's look at the words together. Point to each word as we go!", screening: allowed },
        { ask: "Give me a hint", reply: "Look at the first sound. What sound does it make?", screening: allowed },
        { ask: "Tell me a scary story", reply: "Let's keep it happy! What is your story about?", screening: offTopic("not about this activity, and not for grades K–2") },
        { ask: "I'm done!", reply: "You worked so hard! Show your teacher what you did.", screening: allowed },
      ],
    },
  },
  "3-5": {
    "Should Recess Be Longer?": {
      opener: "Your job is an opinion piece. Let's plan it one step at a time.",
      exchanges: [
        { ask: "What's the first step?", reply: "Step 1: decide your opinion. Should recess be longer, or not? Write one sentence that says it, like \"I think ___.\" What will yours be?", screening: allowed },
        { ask: "I think recess should be longer", reply: "Great, that's a clear opinion! Step 2: give a reason. Why should it be longer? Think about how you feel after you play.", screening: allowed },
        { ask: "Give me a hint", reply: "Try a starter: \"One reason is ___.\" Then add \"For example, ___.\" Can you think of something that happens at recess that helps you learn?", screening: allowed },
        { ask: "Can you check my answer?", reply: "Read me your reason. I'll check two things: does it say why, and does it give an example? Then you can fix it yourself.", screening: allowed },
        { ask: "Just write it for me", reply: "I can't write it for you, but I know you can do it! Let's do the next sentence together. What's one reason recess helps?", screening: offTopic("asks the tutor to do the graded work") },
      ],
    },
    "*": {
      opener: "Tell me the question and what you've tried so far.",
      exchanges: [
        { ask: "Explain the question", reply: "Let's read it together. What is the question asking you to find or do? Put it in your own words.", screening: allowed },
        { ask: "What's the first step?", reply: "Look for the important numbers or words first. Which ones do you need?", screening: allowed },
        { ask: "Give me a hint", reply: "Try drawing it. A picture can help you see the problem. What would you draw?", screening: allowed },
        { ask: "Just give me the answer", reply: "I won't give the answer, but I'll help you find it! Tell me the first step you'd try.", screening: offTopic("asks the tutor to do the graded work") },
      ],
    },
  },
  "6-8": {
    "Ideas on the Move": {
      opener: "Paste a part of your draft, and say what you want feedback on.",
      exchanges: [
        { ask: "Give me feedback on my draft", reply: "Strength: your claim, that paper changed the world more than silk, is clear and arguable. Next steps: (1) add one piece of evidence from the reading for how paper travelled; (2) explain why that matters today. Which will you try first?", screening: allowed },
        { ask: "Why does this work?", reply: "A claim with evidence persuades because the reader can check it. Look at your second paragraph: which sentence is evidence, and which is your explanation of it?", screening: allowed },
        { ask: "I'm stuck on the next step", reply: "Ask yourself: who carried paper along the Silk Roads, and what did people do with it when it arrived? Your answer is your next paragraph's topic.", screening: allowed },
        { ask: "Can you write my paragraph?", reply: "That has to be your writing, since it's graded. I can help you plan it: what's the one idea the paragraph should prove?", screening: offTopic("asks the tutor to write graded work") },
      ],
    },
    "What Do Hammurabi's Laws Tell Us?": {
      opener: "Let's look at how you used the source.",
      exchanges: [
        { ask: "Can you check my reasoning?", reply: "You said the laws show a society with classes of people. Which law shows that? Quote it, then explain how it shows classes.", screening: allowed },
        { ask: "Why does this work?", reply: "Sourcing means asking who made a document, when, and why. Why might a king carve laws in stone where everyone could see them?", screening: allowed },
        { ask: "Can you write my paragraph?", reply: "I won't write it, but let's plan it. What's your claim about what the laws tell us?", screening: offTopic("asks the tutor to write graded work") },
      ],
    },
    "*": {
      opener: "Share the problem or the part of your draft you're on. What have you tried?",
      exchanges: [
        { ask: "I'm stuck on the next step", reply: "What do you know, and what are you trying to find? Write both down, then look for what connects them.", screening: allowed },
        { ask: "Can you check my reasoning?", reply: "Walk me through your steps. For each one, say why it's allowed. Where are you least sure?", screening: allowed },
        { ask: "Why does this work?", reply: "Try a simpler example first: what happens with smaller numbers? Then see if the same idea works for yours.", screening: allowed },
        { ask: "Can you write my paragraph?", reply: "That has to be your work. Tell me your main idea, and I'll ask questions that help you write it.", screening: offTopic("asks the tutor to write graded work") },
      ],
    },
  },
  "9-12": {
    "What Changes a Character?": {
      opener: "Tell me your thesis, or the question you're answering, and we'll test it.",
      exchanges: [
        { ask: "Is my thesis arguable?", reply: "Say it in one sentence first. An arguable thesis is a claim someone could reasonably disagree with, about what changes the character and why. \"She grows up\" is a fact; \"loss, not success, is what makes her grow up\" is arguable. Which is yours closer to?", screening: allowed },
        { ask: "Does this evidence support my claim?", reply: "Check it: does the quotation show the change, or only the event? For each quote, write one sentence of reasoning that connects it to your claim. If you can't, look for a better quote.", screening: allowed },
        { ask: "What's a counterargument?", reply: "The strongest objection to your claim. Someone might say the character never really changes, only her circumstances do. How would you answer that, with evidence from the text?", screening: allowed },
        { ask: "Write my conclusion for me", reply: "That has to be your own writing, and your teacher's AI rules apply. I can show you the shape: \"Although [opposing view], [your claim] because [reason].\" What would you put in each part?", screening: offTopic("asks the tutor to write graded work") },
      ],
    },
    "Should Community Service Be Required to Graduate?": {
      opener: "Your teacher's feedback asked you to quote the source directly. Let's make your evidence stronger.",
      exchanges: [
        { ask: "Does this evidence support my claim?", reply: "Find the sentence where you paraphrase the brief. Which exact words in the source prove your point? Quote them, cite them, then add one sentence of your own explaining why they matter.", screening: allowed },
        { ask: "What's a counterargument?", reply: "The best case against your position. If you argue for required service, the strongest objection might be that students with jobs or family duties have less time. What's your answer to that?", screening: allowed },
        { ask: "Check my citation", reply: "Tell me the source, the style (MLA, APA or Chicago) and the citation you wrote. I can't open links, so check every detail against the source itself.", screening: allowed },
        { ask: "Find me a statistic to cite", reply: "I won't invent sources or numbers. Search your school library's databases, and judge each source by its author, date, purpose and evidence. Then I can check how you cite it.", screening: offTopic("asks for a source the tutor cannot verify") },
      ],
    },
    "*": {
      opener: "Tell me the assignment and your thesis, or paste a paragraph to strengthen.",
      exchanges: [
        { ask: "Is my thesis arguable?", reply: "Could a reasonable person disagree with it? If not, it's a fact or a topic. Add a \"because\" and a position, then tell me what you've got.", screening: allowed },
        { ask: "Does this evidence support my claim?", reply: "For each piece of evidence, write the sentence that explains how it proves your claim. Where that sentence is hard to write, the evidence is weak.", screening: allowed },
        { ask: "Write my conclusion for me", reply: "That has to be your writing. Tell me your claim and your strongest reason, and I'll help you shape the ending.", screening: offTopic("asks the tutor to write graded work") },
      ],
    },
  },
};

/** The script a band's tutor follows for an activity: its own, or the band's general one. */
export const scriptFor = (band: GradeBand, activityTitle: string): Script => SCRIPTS[band][activityTitle] ?? SCRIPTS[band]["*"]!;

/**
 * How the simulated tutor answers what the learner sent: the scripted exchange it matches, the
 * tutor's own privacy reply to a message holding contact details or an address (which the live
 * tutor neither sends nor keeps), or a note that this preview only follows its script, marked
 * `unscripted` because nothing screened or sent it.
 */
export function answer(band: GradeBand, activityTitle: string, message: string): Exchange {
  const tutor = TUTORS[band];
  if (holdsPersonalDetails(message)) {
    return { ask: message, reply: tutor.privacyReply, screening: { verdict: "held", why: "looks like contact details or an address" } };
  }
  const wanted = message.trim().toLowerCase();
  const scripted = scriptFor(band, activityTitle).exchanges.find((e) => e.ask.toLowerCase() === wanted);
  if (scripted !== undefined) return scripted;
  return {
    ask: message,
    reply: `This preview follows a script, so try one of the buttons. On the AI district, ${tutor.name} answers anything about your work, screened by Hall Monitor first.`,
    screening: { verdict: "unscripted" },
  };
}
