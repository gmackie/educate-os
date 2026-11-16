/**
 * What makes one tutor gadget different from another: who it is for, how it talks, and how its page
 * looks. A blueprint declares one {@link TutorPersona} in its `lib/persona.ts`, which both its
 * Durable Object (for the prompt) and its page (for the look) import.
 */

/** The grade bands a tutor is written for, youngest first. */
export const TUTOR_GRADE_BANDS = ["K-2", "3-5", "6-8", "9-12"] as const;
/** A tutor's grade band. */
export type TutorGradeBand = (typeof TUTOR_GRADE_BANDS)[number];

/** One tutor. */
export interface TutorPersona {
  /** The tutor's name, as the learner sees it and the model plays it. */
  name: string;
  /** The band it is written for. Its blueprint's `LLM` binding declares the same band. */
  band: TutorGradeBand;
  /** One line under the name: what it helps with. */
  tagline: string;
  /** A single emoji the page shows as the tutor's face. */
  avatar: string;
  /** The tutor's first message, shown before anything is asked. */
  greeting: string;
  /** What the tutor sticks to, in a phrase ("the story we are reading"); used in its refusals. */
  focus: string;
  /** The tutor's job, in a few sentences, for the model. */
  role: string;
  /** How to write for this age: reading level, sentence length, vocabulary. */
  readingLevel: string;
  /** The longest reply the model is asked for, in words. */
  maxReplyWords: number;
  /** Rules particular to this tutor, each one sentence, for the model. */
  rules: readonly string[];
  /** What the tutor says, without asking the model, when a learner shares something private. */
  privacyReply: string;
  /** The label of the optional "what are we working on" field. */
  topicLabel: string;
  /** Its placeholder: an example of a topic or assignment. */
  topicPlaceholder: string;
  /** The message box's placeholder. */
  inputPlaceholder: string;
  /** One-tap replies shown under the conversation (younger learners may not type much). */
  quickReplies: readonly string[];
  /** The note at the foot of the page, pointing to a person who can help. */
  helpNote: string;
  /** Whether each reply is read aloud as it arrives (every reply can be read aloud on request). */
  readAloud: boolean;
  /** The page's look. */
  theme: {
    /** The accent colour: buttons and the tutor's bubbles. */
    accent: string;
    /** Text on the accent colour. */
    onAccent: string;
    /** The page background. */
    background: string;
    /** Base font size in pixels; bigger for younger readers. */
    fontSize: number;
  };
}
