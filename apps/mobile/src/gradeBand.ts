// How the app reads a class's grade band, such as "K", "2", "K-2" or "9-12", to present work the
// way its students read best. The same rules as the web's packages/educateos-student-ui/src/gradeBand.ts
// (SCHO-323), so a class looks the same on the phone and on a computer (SCHO-342).

/** The lowest and highest grade a band covers, kindergarten as 0. */
export type GradeRange = { low: number; high: number };

function grade(text: string): number | undefined {
  const value = text.trim().toUpperCase();
  // Pre-K and transitional kindergarten read as kindergarten: the youngest presentation there is.
  if (value === 'K' || value === 'PK' || value === 'TK' || value === 'KG') return 0;
  return /^\d{1,2}$/.test(value) ? Number(value) : undefined;
}

/**
 * The grades `band` covers, or undefined if it does not read as a band. Accepts the district's own
 * form ("K", "7", "9-12") and the looser ones teachers type ("k – 2", "1 to 3", "Grade 2").
 */
export function gradeRange(band: string | undefined): GradeRange | undefined {
  if (band === undefined) return undefined;
  const parts = band.replace(/^\s*grades?\s+/i, '').split(/\s*(?:-|–|—|to)\s*/i);
  if (parts.length > 2) return undefined;
  const low = grade(parts[0] ?? '');
  const high = parts.length === 2 ? grade(parts[1]!) : low;
  if (low === undefined || high === undefined) return undefined;
  return low <= high ? { low, high } : { low: high, high: low };
}

/**
 * Whether a band's students are young learners (K-2), who get one step at a time, large type and
 * everything read aloud. "K-3" still counts; one starting at 3, such as "3-5", reads independently.
 */
export function isYoungLearnerBand(band: string | undefined): boolean {
  const range = gradeRange(band);
  return range !== undefined && range.low <= 2 && range.high <= 3;
}

/** Whether a band includes elementary grades (K-5), where read-aloud and the drawing pad are offered. */
export function isElementaryBand(band: string | undefined): boolean {
  const range = gradeRange(band);
  return range !== undefined && range.low <= 5;
}
