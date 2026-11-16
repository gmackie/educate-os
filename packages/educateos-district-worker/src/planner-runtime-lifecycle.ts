import type { StudentLearningRuntimePersistence } from "@educateos/district-app";
import type { RecordTable } from "@educateos/lti-district";

/** The content-free runtime quota collection, separate from financial records. */
export const PLANNER_RUNTIME_COLLECTION = "planner-ai-runtime";

/** Attach operational quota erasure to the existing lifecycle transaction, never billing records. */
export function plannerRuntimeLifecycle(table: RecordTable): StudentLearningRuntimePersistence {
  // Initialize lazy SQLite migrations before entering the lifecycle's transaction.
  table.get(PLANNER_RUNTIME_COLLECTION, "breaker");
  return {
    count: (id) => table.get(PLANNER_RUNTIME_COLLECTION, `student:${id}`) === undefined ? 0 : 1,
    erase: (id) => { table.delete(PLANNER_RUNTIME_COLLECTION, `student:${id}`); },
  };
}

