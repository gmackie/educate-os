// Grade parsing is extracted from PlayTrek packages/edtech/src/oneroster/mapping.ts
// (`parseGradeLevel`) at commit 7258e4347. PlayTrek read `IT` (infant/toddler) as kindergarten and
// pre-K as grade -1; SchoolOS grade bands cover K-12 only, so every code outside KG and 01-12 is
// left out instead. The subject tables are new.
import { GradeBand } from "@schoolos/contracts";
import type { Subject } from "@schoolos/contracts";

/**
 * Reads a OneRoster grade code (the CEDS vocabulary: `KG`, `01` ... `12`) as a number, with
 * kindergarten as 0. Returns undefined for codes a SchoolOS grade band cannot hold, such as `PK`,
 * `TK`, `UG` and `13`.
 */
export function parseGradeLevel(raw: string): number | undefined {
  const code = raw.trim().toUpperCase();
  if (code === "KG" || code === "K") return 0;
  if (!/^\d{1,2}$/.test(code)) return undefined;
  const grade = Number(code);
  return grade >= 1 && grade <= 12 ? grade : undefined;
}

/**
 * The narrowest grade band covering every grade code given, such as `9-10` for `09,10` or `K` for
 * `KG`. Returns undefined when none of the codes is a K-12 grade.
 */
export function gradeBandFor(codes: Iterable<string>): GradeBand | undefined {
  let low = Infinity;
  let high = -Infinity;
  for (const code of codes) {
    const grade = parseGradeLevel(code);
    if (grade === undefined) continue;
    low = Math.min(low, grade);
    high = Math.max(high, grade);
  }
  if (low === Infinity) return undefined;
  return GradeBand.parse(low === high ? gradeName(low) : `${gradeName(low)}-${gradeName(high)}`);
}

function gradeName(grade: number): string {
  return grade === 0 ? "K" : String(grade);
}

/**
 * Free-text OneRoster subjects SchoolOS recognises, lowercased. OneRoster leaves `subjects` to the
 * source system, so this lists the names in common use rather than guessing from substrings.
 */
export const SUBJECT_NAMES: Readonly<Record<string, Subject>> = {
  "english": "english-language-arts",
  "english language arts": "english-language-arts",
  "ela": "english-language-arts",
  "language arts": "english-language-arts",
  "reading": "english-language-arts",
  "writing": "english-language-arts",
  "literature": "english-language-arts",
  "science": "science",
  "biology": "science",
  "chemistry": "science",
  "physics": "science",
  "earth science": "science",
  "life science": "science",
  "physical science": "science",
  "environmental science": "science",
  "social studies": "history-social-studies",
  "history": "history-social-studies",
  "us history": "history-social-studies",
  "u.s. history": "history-social-studies",
  "world history": "history-social-studies",
  "government": "history-social-studies",
  "civics": "history-social-studies",
  "economics": "history-social-studies",
  "geography": "history-social-studies",
  "math": "mathematics",
  "mathematics": "mathematics",
  "algebra": "mathematics",
  "geometry": "mathematics",
  "calculus": "mathematics",
  "statistics": "mathematics",
  "art": "arts",
  "arts": "arts",
  "fine arts": "arts",
  "visual arts": "arts",
  "music": "arts",
  "theater": "arts",
  "theatre": "arts",
  "drama": "arts",
  "dance": "arts",
  "world languages": "world-languages",
  "foreign language": "world-languages",
  "spanish": "world-languages",
  "french": "world-languages",
  "german": "world-languages",
  "chinese": "world-languages",
  "mandarin": "world-languages",
  "japanese": "world-languages",
  "latin": "world-languages",
  "computer science": "computer-science",
  "computing": "computer-science",
  "programming": "computer-science",
  "health": "health-physical-education",
  "physical education": "health-physical-education",
  "pe": "health-physical-education",
  "social emotional learning": "social-emotional-learning",
  "social-emotional learning": "social-emotional-learning",
  "sel": "social-emotional-learning",
};

/**
 * SCED course subject areas (the first two digits of a `subjectCodes` entry) SchoolOS recognises.
 * Areas left out, such as 07 (religious education) and 22 (miscellaneous), map to `other`.
 */
export const SCED_SUBJECT_AREAS: Readonly<Record<string, Subject>> = {
  "01": "english-language-arts",
  "02": "mathematics",
  "03": "science",
  "04": "history-social-studies",
  "05": "arts",
  "06": "world-languages",
  "08": "health-physical-education",
  "10": "computer-science",
};

/**
 * The SchoolOS subject of a course: the first free-text subject in {@link SUBJECT_NAMES}, else the
 * first subject code whose SCED area is in {@link SCED_SUBJECT_AREAS}, else `other`.
 */
export function subjectFor(subjects: readonly string[], subjectCodes: readonly string[]): Subject {
  for (const subject of subjects) {
    const mapped = lookup(SUBJECT_NAMES, subject.trim().toLowerCase());
    if (mapped !== undefined) return mapped;
  }
  for (const code of subjectCodes) {
    const mapped = /^\d{2}/.test(code) ? lookup(SCED_SUBJECT_AREAS, code.slice(0, 2)) : undefined;
    if (mapped !== undefined) return mapped;
  }
  return "other";
}

// An own-property lookup, so that a subject named `constructor` is not read off Object.prototype.
function lookup(table: Readonly<Record<string, Subject>>, key: string): Subject | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
