import { z } from "zod";
import { OfferingId, SchoolOsError } from "@schoolos/contracts";
import { AssignmentId } from "@schoolos/assessment";
import { LTI_COLLECTIONS, LtiStoredRecordError } from "./stores.ts";
import { tupleKey, type RecordTable } from "./table.ts";

const read = (value: unknown): GradeColumnBinding => {
  const parsed = GradeColumnBinding.safeParse(value);
  if (!parsed.success) throw new LtiStoredRecordError(`a ${LTI_COLLECTIONS.gradeColumns} record does not match its schema`);
  return parsed.data;
};

/**
 * Which assignment an LMS gradebook column carries. Passback names a column; the approval behind
 * it is an official grade version of this assignment.
 */
export const GradeColumnBinding = z.strictObject({
  offeringId: OfferingId,
  /** The AGS line item URL or Classroom coursework ID. */
  column: z.string().min(1).max(2048),
  assignmentId: AssignmentId,
});
/** A grade column binding. */
export type GradeColumnBinding = z.infer<typeof GradeColumnBinding>;

/** Where grade column bindings are kept. */
export interface GradeColumnStore {
  /**
   * Binds a column to an assignment. Binding it again to the same assignment is a no-op; binding it,
   * or the assignment, to anything else is `conflict`, because moving a binding would let
   * approvals of one assignment publish to another's column.
   */
  bind(binding: GradeColumnBinding): Promise<void>;
  /** The assignment a column in `offeringId` carries, or `undefined`. */
  assignmentFor(offeringId: OfferingId, column: string): Promise<AssignmentId | undefined>;
}

/** A {@link GradeColumnStore} over a record table. */
export class TableGradeColumnStore implements GradeColumnStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async bind(input: GradeColumnBinding): Promise<void> {
    const binding = GradeColumnBinding.parse(input);
    this.#table.atomically(() => {
      const bindings = this.#table.list(LTI_COLLECTIONS.gradeColumns).map(({ row }) => read(row.value));
      const sameColumn = bindings.find((b) => b.offeringId === binding.offeringId && b.column === binding.column);
      const sameAssignment = bindings.find((b) => b.offeringId === binding.offeringId && b.assignmentId === binding.assignmentId);
      if (sameColumn?.assignmentId === binding.assignmentId) return;
      if (sameColumn !== undefined || sameAssignment !== undefined) {
        throw new SchoolOsError("conflict", "That column or assignment is already bound to another.");
      }
      this.#table.put(LTI_COLLECTIONS.gradeColumns, tupleKey(binding.offeringId, binding.column), binding);
    });
  }

  async assignmentFor(offeringId: OfferingId, column: string): Promise<AssignmentId | undefined> {
    const row = this.#table.get(LTI_COLLECTIONS.gradeColumns, tupleKey(offeringId, column));
    return row === undefined ? undefined : read(row.value).assignmentId;
  }
}
