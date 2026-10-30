// The teacher session's operations as tools: the same methods, called by name with JSON arguments
// checked against each tool's schema. A tool that makes a change answers `awaiting-decision` once
// the change is submitted.

import { codeOf } from "./clever-errors";
import type { SectionCore } from "./clever-sessions";
import type { CleverSection, CleverToolCallResult } from "./types";

/** What a tool runs against. */
export type ToolHandlers = {
  listSections(): Promise<CleverSection[]>;
  /** The section's operations; refuses a section the user may not reach. */
  section(sectionId: string): Promise<SectionCore>;
};

type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True for a tool that submits a change rather than reading. */
  change?: true;
  run(handlers: ToolHandlers, args: Record<string, unknown>): Promise<unknown>;
};

const SECTION_ID = { type: "string", description: "The Clever section ID, from list_sections." };
const ASSIGNMENT_ID = { type: "string", description: "The assignment ID, from list_assignments." };

function schema(properties: JsonSchema["properties"], required: string[] = []): JsonSchema {
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

const str = (args: Record<string, unknown>, key: string) => args[key] as string;
const optional = <T>(args: Record<string, unknown>, key: string) => args[key] as T | undefined;

/** The teacher session's tools. */
export const TEACHER_TOOLS: readonly Tool[] = [
  {
    name: "list_sections",
    description: "List the sections you teach, in the current and future terms.",
    inputSchema: schema({}),
    run: handlers => handlers.listSections(),
  },
  {
    name: "get_section",
    description: "Return one section's details.",
    inputSchema: schema({ sectionId: SECTION_ID }, ["sectionId"]),
    run: async (handlers, args) => (await handlers.section(str(args, "sectionId"))).getSection(),
  },
  {
    name: "get_roster",
    description: "Return a section's teachers and students: each one's ID, name and, for a student, grade level.",
    inputSchema: schema({ sectionId: SECTION_ID }, ["sectionId"]),
    run: async (handlers, args) => (await handlers.section(str(args, "sectionId"))).getRoster(),
  },
  {
    name: "list_assignments",
    description: "List a section's assignments created through this connection, including creations awaiting a decision.",
    inputSchema: schema({ sectionId: SECTION_ID }, ["sectionId"]),
    run: async (handlers, args) => (await handlers.section(str(args, "sectionId"))).listAssignments(),
  },
  {
    name: "get_assignment",
    description: "Return one assignment created through this connection.",
    inputSchema: schema({ sectionId: SECTION_ID, assignmentId: ASSIGNMENT_ID }, ["sectionId", "assignmentId"]),
    run: async (handlers, args) => (await handlers.section(str(args, "sectionId"))).getAssignment(str(args, "assignmentId")),
  },
  {
    name: "create_assignment",
    description: "Create a points assignment for every student of a section, in its learning management system.",
    inputSchema: schema({
      sectionId: SECTION_ID,
      title: { type: "string", minLength: 1, maxLength: 3000 },
      description: { type: "string", maxLength: 30000 },
      pointsPossible: { type: "number", exclusiveMinimum: 0, description: "Points it is graded out of." },
      dueDate: { type: "string", format: "date-time", description: "When it is due, as an ISO 8601 date-time." },
    }, ["sectionId", "title", "pointsPossible"]),
    change: true,
    run: async (handlers, args) => {
      const due = optional<string>(args, "dueDate");
      const description = optional<string>(args, "description");
      return (await handlers.section(str(args, "sectionId"))).createAssignment({
        title: str(args, "title"),
        pointsPossible: args.pointsPossible as number,
        ...(description === undefined ? {} : { description }),
        ...(due === undefined ? {} : { dueDate: new Date(due) }),
      });
    },
  },
  {
    name: "list_submissions",
    description: "List the submissions, with grades, for one assignment created through this connection, optionally one student's only.",
    inputSchema: schema({
      sectionId: SECTION_ID,
      assignmentId: ASSIGNMENT_ID,
      studentId: { type: "string", description: "A student's Clever user ID, from get_roster." },
    }, ["sectionId", "assignmentId"]),
    run: async (handlers, args) => {
      const studentId = optional<string>(args, "studentId");
      return (await handlers.section(str(args, "sectionId")))
        .listSubmissions(str(args, "assignmentId"), studentId === undefined ? {} : { studentId });
    },
  },
  {
    name: "set_grade",
    description: "Give one student a grade, in points from 0 to the assignment's pointsPossible, with an optional comment.",
    inputSchema: schema({
      sectionId: SECTION_ID,
      assignmentId: ASSIGNMENT_ID,
      studentId: { type: "string", description: "The student's Clever user ID, from get_roster." },
      points: { type: "number", minimum: 0 },
      comment: { type: "string", maxLength: 30000 },
    }, ["sectionId", "assignmentId", "studentId", "points"]),
    change: true,
    run: async (handlers, args) => (await handlers.section(str(args, "sectionId"))).setGrade(
      str(args, "assignmentId"), str(args, "studentId"), args.points as number, optional<string>(args, "comment")),
  },
];

/** The arguments that do not match a schema, as messages; empty when they all do. */
export function argumentProblems(inputSchema: JsonSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(inputSchema.properties, key)) problems.push(`${key} is not an argument of this tool`);
  }
  for (const key of inputSchema.required ?? []) {
    if (args[key] === undefined) problems.push(`${key} is required`);
  }
  for (const [key, property] of Object.entries(inputSchema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (property.type === "string") {
      if (typeof value !== "string") { problems.push(`${key} must be a string`); continue; }
      if (typeof property.minLength === "number" && value.trim().length < property.minLength) problems.push(`${key} must not be empty`);
      if (typeof property.maxLength === "number" && value.length > property.maxLength) problems.push(`${key} is too long`);
      if (property.format === "date-time" && Number.isNaN(Date.parse(value))) problems.push(`${key} must be an ISO 8601 date-time`);
    } else if (property.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) { problems.push(`${key} must be a number`); continue; }
      if (typeof property.minimum === "number" && value < property.minimum) problems.push(`${key} must be at least ${property.minimum}`);
      if (typeof property.exclusiveMinimum === "number" && value <= property.exclusiveMinimum) {
        problems.push(`${key} must be more than ${property.exclusiveMinimum}`);
      }
    }
  }
  return problems;
}

/** A result as JSON would carry it: dates as ISO 8601 strings. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

/** Calls the tool `name`. Never throws: a failure is an `error` result. */
export async function runTool(handlers: ToolHandlers, name: string, args: Record<string, unknown>): Promise<CleverToolCallResult> {
  const tool = TEACHER_TOOLS.find(candidate => candidate.name === name);
  if (tool === undefined) {
    return { status: "error", code: "validation-failed", message: `There is no tool named ${JSON.stringify(name)}.` };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { status: "error", code: "validation-failed", message: "The arguments must be an object." };
  }
  const problems = argumentProblems(tool.inputSchema, args);
  if (problems.length > 0) return { status: "error", code: "validation-failed", message: `${problems.join("; ")}.` };
  try {
    const value = await tool.run(handlers, args);
    return tool.change ? { status: "awaiting-decision" } : { status: "ok", value: plain(value) };
  } catch (error) {
    return { status: "error", code: codeOf(error), message: error instanceof Error ? error.message : String(error) };
  }
}
