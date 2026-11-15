// Progress derived from saved practice (ADR-0016). Nothing here is stored: every state, count and
// note is recomputed from a child's sessions, so a correction or a deleted session changes what a
// parent sees and nothing else has to be kept in step.
//
// The parent-facing states describe practice, not mastery:
//
// - `not-tried`: no assessed response for the skill yet.
// - `practicing-with-help`: tried, but the rule below isn't met yet.
// - `practicing-independently`: at least INDEPENDENT_OF of the most recent INDEPENDENT_WINDOW
//   assessed responses were right on the first try with no hint and no adult help, and those
//   responses span at least INDEPENDENT_DAYS different days.
// - `ready-to-revisit`: was practicing independently, but nothing has been practiced for
//   REVISIT_AFTER_DAYS days.
//
// No state claims a skill is "secure" or "mastered"; that needs an educator-reviewed rule.
import { resolveActivity, type Activity, type ActivityRef, type Pack, type Skill, type Strand, type Track } from "./content/index.ts";
import type { EvidenceCorrection, Learner, PracticeSession, QueueEntry } from "./model.ts";
import type { ErrorPattern, EvidenceSource, ScoredResponse } from "./scoring.ts";

/** Responses the "independently" rule looks at. */
export const INDEPENDENT_WINDOW = 6;
/** How many of them must be independent and right. */
export const INDEPENDENT_OF = 5;
/** How many different days they must span. */
export const INDEPENDENT_DAYS = 2;
/** Days without practice after which an independent skill is ready to revisit. */
export const REVISIT_AFTER_DAYS = 21;

/** A parent-facing progress state. */
export type SkillState = "not-tried" | "practicing-with-help" | "practicing-independently" | "ready-to-revisit";

/** One response as progress reads it: after the latest correction, with where it came from. */
export interface Evidence {
  sessionId: string;
  ref: ActivityRef;
  mode: Activity["mode"];
  item: string;
  at: string;
  correct: boolean;
  independent: boolean;
  hintUsed: boolean;
  adultHelped: boolean;
  evidence: EvidenceSource;
  pattern?: ErrorPattern;
  /** The adult's latest correction, if any. */
  corrected?: EvidenceCorrection["verdict"];
}

/** Applies the latest correction to a response; undefined if the adult excluded it. */
function effective(session: PracticeSession, response: ScoredResponse): Evidence | undefined {
  const correction = session.corrections.filter((c) => c.item === response.item).at(-1);
  if (correction?.verdict === "exclude") return undefined;
  const base: Evidence = {
    sessionId: session.id, ref: session.ref, mode: session.mode, item: response.item, at: response.savedAt,
    correct: response.correct, independent: response.independent && response.correct,
    hintUsed: response.hintUsed, adultHelped: response.adultHelped, evidence: response.evidence,
    ...(response.pattern === undefined ? {} : { pattern: response.pattern }),
  };
  if (correction === undefined) return base;
  return {
    ...base,
    corrected: correction.verdict,
    correct: correction.verdict !== "incorrect",
    independent: correction.verdict === "independent",
  };
}

/** Every effective response in some sessions, oldest first. */
export function evidenceOf(sessions: readonly PracticeSession[]): Evidence[] {
  return sessions
    .flatMap((s) => s.responses.map((r) => effective(s, r)).filter((e): e is Evidence => e !== undefined))
    .toSorted((a, b) => a.at.localeCompare(b.at));
}

const day = (iso: string) => iso.slice(0, 10);

/** The state of one skill, from that skill's evidence, oldest first. */
export function skillState(evidence: readonly Evidence[], now: Date): SkillState {
  if (evidence.length === 0) return "not-tried";
  const recent = evidence.slice(-INDEPENDENT_WINDOW);
  const met = recent.length >= INDEPENDENT_WINDOW
    && recent.filter((e) => e.independent).length >= INDEPENDENT_OF
    && new Set(recent.map((e) => day(e.at))).size >= INDEPENDENT_DAYS;
  if (!met) return "practicing-with-help";
  const idleDays = (now.getTime() - Date.parse(evidence.at(-1)!.at)) / 86_400_000;
  return idleDays >= REVISIT_AFTER_DAYS ? "ready-to-revisit" : "practicing-independently";
}

/** One skill's progress, as a parent sees it. */
export interface SkillProgress {
  skill: Skill;
  track: Track;
  strand: Strand;
  state: SkillState;
  /** Responses counted (after corrections and exclusions). */
  responses: number;
  /** Right on the first try with no help. */
  independent: number;
  /** Used a hint or an adult's help. */
  helped: number;
  /** From check activities. */
  fromChecks: number;
  /** Recorded by an adult listening (oral reading). */
  adultObserved: number;
  /** Answered after an adult spoke the sounds. */
  adultPresented: number;
  /** Different sessions it was practiced in. */
  sessions: number;
  lastPracticedAt?: string;
  /** A mistake seen more than once in the recent window, worth naming. */
  pattern?: ErrorPattern;
}

/** Progress on every skill of some packs, from a child's sessions. */
export function progressOf(packs: readonly Pack[], sessions: readonly PracticeSession[], now: Date): SkillProgress[] {
  const all = evidenceOf(sessions);
  const result: SkillProgress[] = [];
  const seen = new Set<string>();
  for (const pack of packs) {
    for (const skill of pack.skills) {
      const key = `${pack.id}:${skill.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = all.filter((e) => e.ref.pack === pack.id && skillOf(e.ref) === skill.id);
      const recent = evidence.slice(-INDEPENDENT_WINDOW);
      const patterns = recent.flatMap((e) => (e.pattern === undefined ? [] : [e.pattern]));
      const repeated = patterns.find((p, i) => patterns.indexOf(p) !== i);
      result.push({
        skill, track: pack.track, strand: skill.strand,
        state: skillState(evidence, now),
        responses: evidence.length,
        independent: evidence.filter((e) => e.independent).length,
        helped: evidence.filter((e) => e.hintUsed || e.adultHelped || e.corrected === "with-help").length,
        fromChecks: evidence.filter((e) => e.mode === "check").length,
        adultObserved: evidence.filter((e) => e.evidence === "adult-observed").length,
        adultPresented: evidence.filter((e) => e.evidence === "adult-presented").length,
        sessions: new Set(evidence.map((e) => e.sessionId)).size,
        ...(evidence.length === 0 ? {} : { lastPracticedAt: evidence.at(-1)!.at }),
        ...(repeated === undefined ? {} : { pattern: repeated }),
      });
    }
  }
  return result;
}

function skillOf(ref: ActivityRef): string | undefined {
  try {
    return resolveActivity(ref).activity.skill;
  } catch {
    return undefined;
  }
}

/** What to suggest next on a track: the first activity from the child's start whose skill isn't yet independent and isn't queued. */
export function suggestionFor(pack: Pack, learner: Learner, progress: readonly SkillProgress[], queue: readonly QueueEntry[]): Activity | undefined {
  const start = pack.activities.findIndex((a) => a.key === learner.starts[pack.track]);
  const queued = new Set(queue.filter((e) => e.ref.pack === pack.id).map((e) => e.ref.activity));
  const independent = new Set(progress.filter((p) => p.state === "practicing-independently").map((p) => p.skill.id));
  return pack.activities.slice(Math.max(start, 0)).find((a) => !queued.has(a.key) && !independent.has(a.skill));
}

/** What comes after an activity: the next one in the pack whose skill isn't yet practiced independently. */
export function nextAfter(pack: Pack, activityKey: string, progress: readonly SkillProgress[]): Activity | undefined {
  const index = pack.activities.findIndex((a) => a.key === activityKey);
  const independent = new Set(progress.filter((p) => p.state === "practicing-independently").map((p) => p.skill.id));
  return pack.activities.slice(index + 1).find((a) => !independent.has(a.skill));
}

const PATTERN_ADVICE: Record<ErrorPattern, string> = {
  "counted-start-mark": "counted the starting number as a jump. Try putting a finger on the start and saying \"zero\" before the first jump.",
  "jumped-wrong-way": "jumped the wrong way. Talk about whether the answer should be bigger or smaller.",
  "letters-out-of-order": "had the right letters in the wrong order. Say the word slowly together and build it sound by sound.",
};

/** A short, plain note about one finished session for the parent, and the next step it suggests. */
export function sessionNote(learner: Learner, session: PracticeSession, next: Activity | undefined): string {
  const { activity } = resolveActivity(session.ref);
  const evidence = evidenceOf([session]);
  const name = learner.displayName;
  if (evidence.length === 0) return `${name} started "${activity.title}" but no answers were saved.`;
  const total = evidence.length;
  const independent = evidence.filter((e) => e.independent).length;
  const hinted = evidence.filter((e) => e.hintUsed).length;
  const adult = evidence.filter((e) => e.adultHelped).length;
  const parts: string[] = [];
  if (activity.items[0]?.type === "read-aloud") {
    parts.push(`${name} read ${independent} of ${total} ${total === 1 ? "sentence" : "sentences"} aloud on their own, as you recorded.`);
  } else {
    parts.push(`${name} worked on "${activity.title}": ${independent} of ${total} right on the first try without help.`);
  }
  if (hinted > 0) parts.push(`${hinted} needed a hint.`);
  if (adult > 0) parts.push(`${adult} had your help.`);
  const pattern = evidence.find((e) => e.pattern !== undefined)?.pattern;
  if (pattern !== undefined) parts.push(`Once or more, ${name} ${PATTERN_ADVICE[pattern]}`);
  if (session.completedAt === undefined) parts.push("This session isn't finished.");
  else if (independent / total < 0.8) parts.push(`Next time: try "${activity.title}" again before moving on.`);
  else if (next !== undefined) parts.push(`Next time: try "${next.title}".`);
  return parts.join(" ");
}
