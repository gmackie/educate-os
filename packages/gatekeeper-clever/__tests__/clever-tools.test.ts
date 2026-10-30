// The tools' argument checking, apart from any session: unknown and missing arguments, types,
// bounds, and that every tool's schema refuses fields it does not list.

import { describe, expect, it } from "vitest";
import { TEACHER_TOOLS, argumentProblems } from "../src/clever-tools";

const tool = (name: string) => TEACHER_TOOLS.find(candidate => candidate.name === name)!;

describe("tool arguments", () => {
  it("every tool's schema is closed", () => {
    for (const { inputSchema } of TEACHER_TOOLS) expect(inputSchema.additionalProperties).toBe(false);
  });

  it("names each wrong argument", () => {
    expect(argumentProblems(tool("set_grade").inputSchema, { sectionId: 1, points: -2, comment: "ok", other: true })).toEqual([
      "other is not an argument of this tool",
      "assignmentId is required",
      "studentId is required",
      "sectionId must be a string",
      "points must be at least 0",
    ]);
    expect(argumentProblems(tool("create_assignment").inputSchema, {
      sectionId: "s", title: " ", pointsPossible: 0, dueDate: "someday",
    })).toEqual([
      "title must not be empty",
      "pointsPossible must be more than 0",
      "dueDate must be an ISO 8601 date-time",
    ]);
  });

  it("accepts arguments that match", () => {
    expect(argumentProblems(tool("list_submissions").inputSchema, { sectionId: "s", assignmentId: "a" })).toEqual([]);
    expect(argumentProblems(tool("list_sections").inputSchema, {})).toEqual([]);
  });
});
