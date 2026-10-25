import type { VerifiedPrincipal } from "@educateos/contracts";
import { z } from "zod";
import type { AcademicDirectory } from "./directory.ts";
import { ACADEMIC_OPERATIONS, invokeOperation, type OperationOutcome } from "./operations.ts";

/**
 * An MCP-style tool over one directory operation. The handler takes the session's verified
 * principal separately from the arguments, so a model cannot name who it acts as; the arguments
 * are validated and authorized exactly as the matching HTTP route's are.
 */
export interface AcademicTool {
  /** The tool name, the same as the operation name. */
  name: string;
  /** What the tool does. */
  description: string;
  /** The arguments, as a JSON Schema document. */
  inputSchema: Record<string, unknown>;
  /** Runs the tool for a verified principal with untrusted arguments. */
  handler(principal: VerifiedPrincipal, args: unknown): Promise<OperationOutcome>;
}

/** One tool per entry in `ACADEMIC_OPERATIONS`, all calling the given directory. */
export function createAcademicTools(directory: AcademicDirectory): AcademicTool[] {
  return Object.values(ACADEMIC_OPERATIONS).map((operation) => ({
    name: operation.name,
    description: operation.description,
    inputSchema: z.toJSONSchema(operation.input) as Record<string, unknown>,
    handler: (principal, args) => invokeOperation(operation, directory, { principal, channel: "mcp-tool" }, args),
  }));
}
