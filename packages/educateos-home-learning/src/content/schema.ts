// The shape of a home-learning content pack (ADR-0016). A pack is reviewed, versioned data: an
// ordered list of skills and the activities that practice them, each with a pool of deterministic
// items whose expected answer is part of the item. Packs ship in this package, parsed strictly when
// it loads; a published version never changes (publish a new version instead), so a practice
// session pins the version it was started from and is always read back against it.
import { z } from "zod";

/** A pack identifier, e.g. `reading-foundations`. */
export const PackId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, "expected a pack ID");
/** A pack identifier. */
export type PackId = z.infer<typeof PackId>;

/** A pack version, `MAJOR.MINOR.PATCH`. */
export const PackVersion = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, "expected a pack version");
/** A pack version. */
export type PackVersion = z.infer<typeof PackVersion>;

/** A skill identifier within its pack, e.g. `phonics.set-1.read`. */
export const SkillId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/, "expected a skill ID");
/** A skill identifier. */
export type SkillId = z.infer<typeof SkillId>;

/** An activity identifier within its pack, e.g. `build-words-set-1`. */
export const ActivityKey = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "expected an activity key");
/** An activity key. */
export type ActivityKey = z.infer<typeof ActivityKey>;

/** An item identifier within its activity. */
export const ItemKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected an item key");
/** An item key. */
export type ItemKey = z.infer<typeof ItemKey>;

/** The two tracks a family practices. Reading and math placement are independent. */
export const Track = z.enum(["reading", "math"]);
/** A track. */
export type Track = z.infer<typeof Track>;

/**
 * What part of the track a skill belongs to. Progress keeps strands apart: listening comprehension
 * is never reported as word reading, and spelling never as decoding.
 */
export const Strand = z.enum([
  "phonemic-awareness",
  "decoding",
  "spelling",
  "heart-words",
  "connected-text",
  "listening-comprehension",
  "counting",
  "comparing",
  "number-line",
  "addition",
  "subtraction",
]);
/** A strand. */
export type Strand = z.infer<typeof Strand>;

/** The grade bands a pack is written for. A grade is a starting suggestion, never a ceiling. */
export const GradeBand = z.enum(["K", "1", "2"]);
/** A grade band. */
export type GradeBand = z.infer<typeof GradeBand>;

const Text = (max: number) => z.string().trim().min(1).max(max);

/** A picture shown with an item: an emoji and the words a screen reader says for it. */
export const Picture = z.strictObject({
  emoji: z.string().min(1).max(16),
  label: Text(60),
});
/** A picture. */
export type Picture = z.infer<typeof Picture>;

/** A choice an item offers: a key, the text shown (possibly empty for a picture-only choice) and an optional picture. */
export const Choice = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  text: z.string().max(80),
  picture: Picture.optional(),
});
/** A choice. */
export type Choice = z.infer<typeof Choice>;

const Choices = z.array(Choice).min(2).max(4).refine((choices) => new Set(choices.map((c) => c.key)).size === choices.length, "choice keys must be unique");

/** Lowercase letters a word is spelled with. */
const Word = z.string().regex(/^[a-z]{1,12}$/, "expected a lowercase word");

/** A spoken sound as an adult reads it in a guide, e.g. `/m/` or `/sh/`. */
const Phoneme = z.string().regex(/^\/[a-z]{1,3}\/$/, "expected a phoneme like /m/");

const base = {
  key: ItemKey,
  /** What the child hears before answering. Never names the word a reading item asks them to read. */
  prompt: Text(300),
  /** A worked hint the child may ask for. Using it marks the response as helped. */
  hint: Text(300).optional(),
};

/**
 * One deterministic item. Every variant carries its own expected answer, and the pack tests
 * recompute it from the item (the sounds counted, the jumps made), so an authoring slip fails the
 * build rather than a child.
 */
export const Item = z.discriminatedUnion("type", [
  /** Phonemic awareness, oral: hear a word, tap one counter per sound. */
  z.strictObject({ ...base, type: z.literal("count-sounds"), word: Word, picture: Picture, phonemes: z.array(Phoneme).min(1).max(6), answer: z.int().min(1).max(6) }),
  /**
   * Phonemic awareness, oral: the adult says the sounds from the guide, the child picks the word
   * they make. Its evidence is adult-presented: the sounds came from the adult, not a recording.
   */
  z.strictObject({ ...base, type: z.literal("blend-sounds"), phonemes: z.array(Phoneme).min(2).max(6), choices: Choices, answer: z.string() }),
  /** Spelling: hear a word, build it from letter tiles. */
  z.strictObject({ ...base, type: z.literal("build-word"), word: Word, picture: Picture.optional(), tiles: z.array(z.string().regex(/^[a-z]{1,2}$/)).min(2).max(8), answer: Word }),
  /** Decoding: read a printed word (never spoken to the child) and pick its picture. */
  z.strictObject({ ...base, type: z.literal("read-word"), word: Word, choices: Choices, answer: z.string() }),
  /** Heart words: hear a word and pick it from printed words. */
  z.strictObject({ ...base, type: z.literal("find-word"), word: z.string().regex(/^[a-zA-Z]{1,12}$/), choices: Choices, answer: z.string() }),
  /** Connected text: read a decodable sentence (never spoken to the child) and pick the picture that shows it. */
  z.strictObject({ ...base, type: z.literal("read-sentence"), sentence: Text(120), choices: Choices, answer: z.string() }),
  /** Connected text, adult-observed: the child reads a sentence aloud and the adult records how it went. */
  z.strictObject({ ...base, type: z.literal("read-aloud"), sentence: Text(120) }),
  /** Listening comprehension: hear a short passage read aloud and answer a question about it. */
  z.strictObject({ ...base, type: z.literal("listen-and-answer"), passage: Text(600), question: Text(200), choices: Choices, answer: z.string() }),
  /** Counting: count pictured objects and pick the number. */
  z.strictObject({ ...base, type: z.literal("count-objects"), picture: Picture, count: z.int().min(0).max(20), choices: z.array(z.int().min(0).max(20)).min(2).max(4), answer: z.int().min(0).max(20) }),
  /** Comparing: two groups; pick the one with more, or fewer. */
  z.strictObject({ ...base, type: z.literal("compare-groups"), picture: Picture, left: z.int().min(0).max(10), right: z.int().min(0).max(10), ask: z.enum(["more", "fewer"]), answer: z.enum(["left", "right"]) }),
  /** One more, one less: a number shown as dots; pick the number one more or one less. */
  z.strictObject({ ...base, type: z.literal("one-more-less"), start: z.int().min(0).max(20), change: z.union([z.literal(1), z.literal(-1)]), choices: z.array(z.int().min(0).max(21)).min(2).max(4), answer: z.int().min(0).max(20) }),
  /** Number line: tap where a number goes on a line from 0 to `max`. */
  z.strictObject({ ...base, type: z.literal("place-on-line"), max: z.union([z.literal(10), z.literal(20)]), target: z.int().min(0).max(20), answer: z.int().min(0).max(20) }),
  /** Number line: start on a number and make jumps forward (`change` > 0) or back; land on the answer. */
  z.strictObject({ ...base, type: z.literal("number-line-jump"), max: z.union([z.literal(10), z.literal(20)]), start: z.int().min(0).max(20), change: z.int().min(-10).max(10).refine((n) => n !== 0), answer: z.int().min(0).max(20) }),
]);
/** An item. */
export type Item = z.infer<typeof Item>;
/** An item's type. */
export type ItemType = Item["type"];

/**
 * How an activity is used. `practice` teaches and allows hints and a second try; `check` is a fresh
 * set of items with no hints and one try, whose responses are the independent evidence progress
 * reads first.
 */
export const ActivityMode = z.enum(["practice", "check"]);
/** An activity mode. */
export type ActivityMode = z.infer<typeof ActivityMode>;

/** One activity: what the parent previews, what the child hears, and its pool of items. */
export const Activity = z.strictObject({
  key: ActivityKey,
  title: Text(80),
  skill: SkillId,
  mode: ActivityMode,
  /** Activities that should come first, by key. The library shows them; nothing blocks a parent's choice. */
  after: z.array(ActivityKey).max(4).default([]),
  /** About how long it takes, in minutes. A design default, not a dose. */
  minutes: z.int().min(2).max(15),
  /** What a parent reads before choosing it. */
  preview: Text(400),
  /** Notes for the adult sitting with the child: how to say a sound, what to watch for. */
  adultGuide: Text(800).optional(),
  /** Spoken to the child when the activity opens. */
  directions: Text(300),
  /** A worked example spoken and shown before the first item. */
  example: Text(400),
  /**
   * The letters and patterns taught by the time this activity runs (reading only). Every word a
   * child is asked to read or build must be spelled with these, or be a taught heart word.
   */
  taught: z.array(z.string().regex(/^[a-z]{1,3}$/)).max(60).optional(),
  /** Heart words taught by now: read as wholes, with their irregular part named in the adult guide. */
  heartWords: z.array(z.string().regex(/^[a-zA-Z]{1,12}$/)).max(40).optional(),
  /** How many items one session draws from the pool. */
  itemsPerSession: z.int().min(1).max(10),
  items: z.array(Item).min(1).max(30),
}).refine((a) => a.items.length >= a.itemsPerSession, "the pool must hold at least one session's items")
  .refine((a) => new Set(a.items.map((i) => i.key)).size === a.items.length, "item keys must be unique");
/** An activity. */
export type Activity = z.infer<typeof Activity>;

/** One skill: what progress is reported against. */
export const Skill = z.strictObject({
  id: SkillId,
  strand: Strand,
  title: Text(80),
  /** How a parent would describe it. */
  description: Text(300),
  /** Standards it aligns to, as short codes (e.g. `CCSS.ELA-LITERACY.RF.K.2.D`). */
  standards: z.array(z.string().regex(/^[A-Z][A-Za-z0-9.-]{2,60}$/)).max(6),
});
/** A skill. */
export type Skill = z.infer<typeof Skill>;

/** Who reviewed a pack version, and for what. Published packs name their review, never an unreviewed claim. */
export const PackReview = z.strictObject({
  status: z.enum(["draft", "reviewed"]),
  /** What the review covered, e.g. "decodability and phoneme guide". */
  scope: Text(300),
  /** The reviewer's role, never a personal name in the shipped data. */
  reviewer: Text(80).optional(),
  reviewedOn: z.iso.date().optional(),
}).refine((r) => r.status === "draft" || (r.reviewer !== undefined && r.reviewedOn !== undefined), "a reviewed pack names its reviewer role and date");
/** A pack review. */
export type PackReview = z.infer<typeof PackReview>;

/** A content pack. */
export const Pack = z.strictObject({
  id: PackId,
  version: PackVersion,
  track: Track,
  title: Text(80),
  summary: Text(400),
  gradeBands: z.array(GradeBand).min(1),
  language: z.literal("en"),
  review: PackReview,
  skills: z.array(Skill).min(1).max(60),
  /** The teaching order. A learner's starting point is a position in it. */
  activities: z.array(Activity).min(1).max(80),
  /** Where a learner of each grade band starts, by activity key. A parent may change it. */
  startFor: z.record(GradeBand, ActivityKey),
}).superRefine((pack, ctx) => {
  const skills = new Set(pack.skills.map((s) => s.id));
  if (skills.size !== pack.skills.length) ctx.addIssue({ code: "custom", message: "skill IDs must be unique" });
  const keys = new Set<string>();
  for (const activity of pack.activities) {
    if (keys.has(activity.key)) ctx.addIssue({ code: "custom", message: `duplicate activity ${activity.key}` });
    if (!skills.has(activity.skill)) ctx.addIssue({ code: "custom", message: `activity ${activity.key} names unknown skill ${activity.skill}` });
    for (const before of activity.after) {
      if (!keys.has(before)) ctx.addIssue({ code: "custom", message: `activity ${activity.key} comes after ${before}, which is not earlier in the pack` });
    }
    keys.add(activity.key);
  }
  for (const [band, key] of Object.entries(pack.startFor)) {
    if (!keys.has(key)) ctx.addIssue({ code: "custom", message: `start for ${band} names unknown activity ${key}` });
  }
});
/** A content pack. */
export type Pack = z.infer<typeof Pack>;

/** A pinned reference to one activity of one pack version. */
export const ActivityRef = z.strictObject({
  pack: PackId,
  version: PackVersion,
  activity: ActivityKey,
});
/** An activity reference. */
export type ActivityRef = z.infer<typeof ActivityRef>;
