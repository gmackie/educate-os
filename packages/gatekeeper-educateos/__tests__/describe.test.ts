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

  it("shows the record, version and digest the district pinned the change to", () => {
    const digest = "a".repeat(64);
    const { fields } = describeChange({ ...read, approvalId: "a1", needs: "approval", target: { kind: "artifact", id: "art_lab", version: "3" }, digest });
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Target", value: "artifact art_lab" }),
      expect.objectContaining({ label: "Version", value: "3" }),
      expect.objectContaining({ label: "Digest", value: digest }),
    ]));
  });
});
