// Where home learning's parent pages live (ADR-0016). All sit under /family, so a guardian's
// audience gate admits them and a student's refuses them.

/** Today: each child's next activities and suggestions. */
export const HOME_PATH = "/family/home";
/** The content library. */
export const LIBRARY_PATH = "/family/library";
/** The family's resource shelf. */
export const SHELF_PATH = "/family/shelf";
/** Children, PIN, export and deletion. */
export const HOME_SETTINGS_PATH = "/family/home-settings";
/** Progress, for whichever child comes first. */
export const PROGRESS_PATH = "/family/progress";

const learner = (learnerId: string) => `/family/learners/${encodeURIComponent(learnerId)}`;

/** One child's practice plan. */
export const queuePath = (learnerId: string): string => `${learner(learnerId)}/plan`;
/** One child's progress. */
export const progressPath = (learnerId: string): string => `${learner(learnerId)}/progress`;
/** One practice session, item by item. */
export const sessionPath = (learnerId: string, sessionId: string): string => `${learner(learnerId)}/sessions/${encodeURIComponent(sessionId)}`;
