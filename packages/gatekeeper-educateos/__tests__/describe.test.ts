import { describe, expect, it } from "vitest";
import { describeChange, describeRead } from "../src/describe.ts";

const read = { tool: "list_student_work", args: { offeringId: "off_bio" }, correlationId: "c1" };

describe("describeRead", () => {
  it("marks every school read as restricted data, so the workspace can no longer send it out", () => {
    expect(describeRead(read)).toMatchObject({
      title: "Read school records (list_student_work)",
      containsRestrictedData: true,
    });
  });
});

describe("describeChange", () => {
  it("describes a change without claiming it can be reverted", () => {
    expect(describeChange({ ...read, approvalId: "a1", needs: "confirmation" }))
      .toMatchObject({ title: "Change school records (list_student_work)", implementsRevert: false });
  });
});
