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
