// The content packs this release ships (ADR-0016), parsed strictly when the module loads, and the
// lookups a session uses to resolve a pinned activity. A pack version, once shipped, stays here
// unchanged for as long as any session may name it.
import { EducateOsError } from "@educateos/contracts";
import { Pack, type Activity, type ActivityRef, type Item, type Skill, type Track } from "./schema.ts";
import { NUMBER_SENSE } from "./math.ts";
import { READING_FOUNDATIONS } from "./reading.ts";

export * from "./schema.ts";

/** Every shipped pack version, newest last within a pack. */
export const PACKS: readonly Pack[] = [Pack.parse(READING_FOUNDATIONS), Pack.parse(NUMBER_SENSE)];

/** The newest version of each pack: what a parent adds from the library. */
export function currentPacks(packs: readonly Pack[] = PACKS): Pack[] {
  const newest = new Map<string, Pack>();
  for (const pack of packs) newest.set(pack.id, pack);
  return [...newest.values()];
}

/** The newest version of the pack for a track. */
export function currentPackFor(track: Track, packs: readonly Pack[] = PACKS): Pack {
  const pack = currentPacks(packs).find((p) => p.track === track);
  if (pack === undefined) throw new Error(`no ${track} pack is shipped`);
  return pack;
}

/** One resolved activity: its pack, the activity, and its skill. */
export interface ResolvedActivity {
  pack: Pack;
  activity: Activity;
  skill: Skill;
}

/**
 * The activity a reference pins.
 *
 * @throws EducateOsError `not-found` if no shipped pack version has it.
 */
export function resolveActivity(ref: ActivityRef, packs: readonly Pack[] = PACKS): ResolvedActivity {
  const pack = packs.find((p) => p.id === ref.pack && p.version === ref.version);
  const activity = pack?.activities.find((a) => a.key === ref.activity);
  const skill = pack?.skills.find((s) => s.id === activity?.skill);
  if (pack === undefined || activity === undefined || skill === undefined) {
    throw new EducateOsError("not-found", "That activity isn't in this installation's content.");
  }
  return { pack, activity, skill };
}

/** The item a session drew, by key. */
export function itemOf(activity: Activity, key: string): Item {
  const item = activity.items.find((i) => i.key === key);
  if (item === undefined) throw new EducateOsError("not-found", "That item isn't part of this activity.");
  return item;
}

/** A pinned reference to an activity of a pack's current version. */
export function refTo(pack: Pack, activity: string): ActivityRef {
  return { pack: pack.id, version: pack.version, activity };
}
