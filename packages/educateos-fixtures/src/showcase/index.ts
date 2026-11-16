// The Northfield showcase (SCHO-322): fully built-out classes for each grade band, as pure data
// keyed by the Northfield fixture's offering and principal IDs. `seedShowcase` in
// `@educateos/harness` makes it through the district API.
import { G35_COURSES } from "./g35.ts";
import { G68_COURSES } from "./g68.ts";
import { G912_COURSES } from "./g912.ts";
import { K2_COURSES } from "./k2.ts";
import { SHOWCASE_RESOURCES } from "./resources.ts";
import type { Showcase } from "./types.ts";

export { rubricMaxPoints } from "./rubrics.ts";
export { SHOWCASE_RESOURCES, showcaseResourceHtml } from "./resources.ts";
export { SHOWCASE_BANDS, SHOWCASE_STAGES } from "./types.ts";
export { base64Of, drawingPng, recordingWav, type Drawing } from "./media.ts";
export type * from "./types.ts";

/**
 * Northfield's showcase: three classes in each of the K-2, 3-5, 6-8 and 9-12 bands, each with two
 * published modules (an intro page and placed work), standards-aligned activities with rubrics,
 * quizzes, discussions in 6-8 and 9-12, announcements, a weekly family note, and every student's
 * work at a scripted stage, from not started to graded and released.
 */
export const NORTHFIELD_SHOWCASE: Showcase = {
  districtId: "dst_northfield",
  courses: [...K2_COURSES, ...G35_COURSES, ...G68_COURSES, ...G912_COURSES],
  resources: SHOWCASE_RESOURCES,
};

/**
 * The educateos.io sample courses (SCHO-329) whose first units are a Northfield showcase class's
 * modules, by course package ID: the showcase offering each continues. A district teaching the
 * showcase class installs only the units after them (SCHO-334), and `pnpm curriculum:check` holds
 * each course's first units to its class's modules.
 */
export const NORTHFIELD_COURSE_CLASSES: Readonly<Record<string, string>> = {
  "educateos.io/grade-1-reading-foundations": "off_nf-g1read-fall-r7",
  "educateos.io/kindergarten-science-weather-watchers": "off_nf-ksci-fall-r4",
  "educateos.io/grade-1-mathematics": "off_nf-g1math-fall-r7",
  "educateos.io/mathematics-7": "off_nf-math7-fall-p1",
  "educateos.io/english-8": "off_nf-eng8-fall-p2",
  "educateos.io/world-history-7": "off_nf-whist7-fall-p4",
  "educateos.io/biology-1": "off_nf-bio-fall-p2",
  "educateos.io/english-9": "off_nf-eng9-fall-p3",
  "educateos.io/united-states-history": "off_nf-ushist-fall-p5",
  "educateos.io/grade-4-english-language-arts": "off_nf-g4ela-fall-r12",
  "educateos.io/grade-4-mathematics": "off_nf-g4math-fall-r12",
  "educateos.io/grade-5-science": "off_nf-g5sci-fall-lab",
};
