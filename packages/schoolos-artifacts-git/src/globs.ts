import { z } from "zod";

/**
 * A path pattern an assignment configures to name teacher-only files, such as `answers/**` or
 * `**\/*.key.ipynb`: `*` matches within one path segment, `**` any number of whole segments, `?` one
 * character. Matching is case-insensitive, so `Answer-Key.md` cannot dodge `answer-key.*`.
 */
export const TeacherOnlyGlob = z.string().min(1).max(256).refine((g) => !g.startsWith("/"), "a pattern is relative to the project root");
/** A teacher-only glob. */
export type TeacherOnlyGlob = z.infer<typeof TeacherOnlyGlob>;

/** What an assignment says is teacher-only in its baseline, beyond files marked so when saved. */
export const TeacherOnlyRules = z.strictObject({
  answerKeyGlobs: z.array(TeacherOnlyGlob).max(100),
});
/** Teacher-only rules. */
export type TeacherOnlyRules = z.infer<typeof TeacherOnlyRules>;

/** A matcher for one glob. */
export function globMatcher(glob: TeacherOnlyGlob): (path: string) => boolean {
  const pattern = new RegExp(`^${globSource(glob)}$`, "iu");
  return (path) => pattern.test(path);
}

function globSource(glob: string): string {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      const followedBySlash = glob[i + 2] === "/";
      if (atSegmentStart && followedBySlash) {
        source += "(?:[^/]+/)*";
        i += 2;
      } else if (atSegmentStart && i + 2 === glob.length) {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}
