import { z } from "zod";
import {
  SchoolOsError,
  type Action,
  type AuthorizationRequest,
  type ResourceRef,
  type SchoolOsErrorBody,
  type TermState,
} from "@schoolos/contracts";
import type { PolicyDecider } from "./engine.ts";

/** A principal the session has already verified. Tools never learn identity any other way. */
export type VerifiedSubject = AuthorizationRequest["subject"];

/** The channels a school tool is invoked through. */
export type ToolChannel = "mcp-tool" | "agent";

/** The trusted context of one tool invocation. */
export interface SchoolToolContext {
  /** The verified principal the call acts for. A principal named in the input is only a selector. */
  principal: VerifiedSubject;
  /** How the call arrived. */
  channel: ToolChannel;
  /** The correlation ID every decision and error of this invocation carries. */
  correlationId: string;
}

/** The resource a call acts on, built from stored records, with its term's state if it has one. */
export interface ToolTarget {
  /** The resource. */
  resource: ResourceRef;
  /** The state of the term it belongs to. */
  termState?: TermState;
}

/** The definition {@link defineSchoolTool} accepts. */
export interface SchoolToolDefinition<S extends z.ZodObject, R> {
  /** A snake_case name, unique within a runner. */
  name: string;
  /** What the tool does, for tool listings. */
  description: string;
  /** The arguments. Must be a strict object: unknown fields are rejected, never ignored. */
  inputSchema: S;
  /** The action every call is authorized as. */
  action: Action;
  /**
   * Resolves the target from validated input and the trusted context, by looking up stored
   * records. Returns `undefined` when there is no such resource, which the caller sees exactly as
   * a denied read.
   */
  resource(input: z.output<S>, context: SchoolToolContext): Promise<ToolTarget | undefined>;
  /** Does the work. Runs only after the engine allows the call. */
  handler(input: z.output<S>, context: SchoolToolContext): Promise<R>;
  /**
   * MCP tool annotations such as `readOnlyHint`, passed through to listings for clients. The
   * runner never reads them: `action` alone is what gets authorized.
   */
  annotations?: Readonly<Record<string, unknown>>;
}

/** A defined school tool, as a runner holds it. */
export interface SchoolTool {
  /** The tool name. */
  readonly name: string;
  /** What the tool does. */
  readonly description: string;
  /** The strict argument schema. */
  readonly inputSchema: z.ZodObject;
  /** The action every call is authorized as. */
  readonly action: Action;
  /** Resolves the target. */
  resource(input: unknown, context: SchoolToolContext): Promise<ToolTarget | undefined>;
  /** Does the work. */
  handler(input: unknown, context: SchoolToolContext): Promise<unknown>;
  /** Listing-only annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Defines a tool every call of which is validated and re-authorized by a {@link SchoolToolRunner}.
 * Throws if the name is malformed or the input schema would accept unknown fields.
 */
export function defineSchoolTool<S extends z.ZodObject, R>(definition: SchoolToolDefinition<S, R>): SchoolTool {
  if (!TOOL_NAME.test(definition.name)) throw new Error(`invalid tool name ${definition.name}`);
  if (definition.inputSchema.def.catchall?._zod.def.type !== "never") {
    throw new Error(`tool ${definition.name} must use z.strictObject for its input`);
  }
  const { name, description, inputSchema, action, annotations } = definition;
  return {
    name,
    description,
    inputSchema,
    action,
    ...(annotations === undefined ? {} : { annotations }),
    // The runner passes only what `inputSchema` produced.
    resource: (input, context) => definition.resource(input as z.output<S>, context),
    handler: (input, context) => definition.handler(input as z.output<S>, context),
  };
}

/** A tool's listing entry. */
export interface SchoolToolListing {
  /** The tool name. */
  name: string;
  /** What it does. */
  description: string;
  /** The arguments as a JSON Schema document. */
  inputSchema: Record<string, unknown>;
  /** Listing-only annotations. */
  annotations?: Readonly<Record<string, unknown>>;
}

/**
 * The outcome of one invocation. `approval-required` means the call did nothing: a human with
 * authority must confirm it first. Neither it nor an error says why the engine refused; that is in
 * the audit entry the correlation ID names.
 */
export type SchoolToolOutcome =
  | { status: "ok"; value: unknown; correlationId: string }
  | { status: "approval-required"; correlationId: string }
  | { status: "error"; error: SchoolOsErrorBody };

/** Actions a refusal of which answers `not-found`: the caller may not know the resource exists. */
const READ_LIKE: ReadonlySet<Action> = new Set<Action>(["read", "list", "export"]);

/**
 * Runs school tools for verified sessions (roadmap §8, ADR-0005). For every call it:
 *
 * 1. rejects a tool name it does not hold;
 * 2. parses the arguments with the tool's strict schema, rejecting unknown fields;
 * 3. resolves the target from stored records and asks the engine, with the session's principal as
 *    the subject — nothing in the arguments or the tool's annotations reaches the request;
 * 4. runs the handler only on `allow`.
 *
 * A refused read, or a refused write to something the caller cannot read, answers `not-found`,
 * the same as a resource that does not exist. A refused write to something the caller can read
 * answers `forbidden`.
 */
export class SchoolToolRunner {
  readonly #tools: ReadonlyMap<string, SchoolTool>;
  readonly #engine: PolicyDecider;

  constructor(options: { tools: readonly SchoolTool[]; engine: PolicyDecider }) {
    const tools = new Map<string, SchoolTool>();
    for (const tool of options.tools) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
      tools.set(tool.name, tool);
    }
    this.#tools = tools;
    this.#engine = options.engine;
  }

  /** The tools, for an MCP `tools/list` response. */
  list(): SchoolToolListing[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }));
  }

  /**
   * Invokes one tool. `session` must come from verified authentication; `name` and `args` are
   * untrusted model or client output.
   */
  async invoke(session: { principal: VerifiedSubject; channel: ToolChannel }, name: unknown, args: unknown): Promise<SchoolToolOutcome> {
    const correlationId = crypto.randomUUID();
    const tool = typeof name === "string" ? this.#tools.get(name) : undefined;
    if (tool === undefined) {
      return failure("not-found", "There is no such tool.", correlationId);
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return failure("validation-failed", describeIssues(parsed.error), correlationId);
    }
    const context: SchoolToolContext = { principal: session.principal, channel: session.channel, correlationId };
    try {
      const target = await tool.resource(parsed.data, context);
      if (target === undefined) return failure("not-found", "The requested resource was not found.", correlationId);

      const { decision } = await this.#engine.decide(requestFor(context, tool.action, target), { correlationId });
      if (decision.effect === "require-approval") return { status: "approval-required", correlationId };
      if (decision.effect === "deny") {
        if (READ_LIKE.has(tool.action) || !(await this.#mayRead(context, target))) {
          return failure("not-found", "The requested resource was not found.", correlationId);
        }
        return failure("forbidden", `You may not ${tool.action} this ${target.resource.kind}.`, correlationId);
      }
      return { status: "ok", value: await tool.handler(parsed.data, context), correlationId };
    } catch (error) {
      if (error instanceof SchoolOsError) return { status: "error", error: { ...error.toBody(), correlationId } };
      // The caller gets nothing internal, so this line is the only record of what went wrong.
      console.error("school tool failed", { tool: tool.name, correlationId, error });
      return failure("unavailable", "The tool could not complete the request.", correlationId);
    }
  }

  async #mayRead(context: SchoolToolContext, target: ToolTarget): Promise<boolean> {
    const { decision } = await this.#engine.decide(requestFor(context, "read", target), { correlationId: context.correlationId });
    return decision.effect === "allow";
  }
}

function requestFor(context: SchoolToolContext, action: Action, target: ToolTarget): AuthorizationRequest {
  return {
    subject: context.principal,
    action,
    resource: target.resource,
    context: {
      channel: context.channel,
      ...(target.termState === undefined ? {} : { termState: target.termState }),
    },
  };
}

function failure(code: SchoolOsErrorBody["code"], message: string, correlationId: string): SchoolToolOutcome {
  return { status: "error", error: { code, message, correlationId } };
}

/** Names each invalid field and why, without echoing any submitted value. */
function describeIssues(error: z.ZodError): string {
  const issues = error.issues.map((issue) =>
    issue.code === "unrecognized_keys"
      ? `unknown field(s) ${issue.keys.join(", ")}`
      : `${issue.path.join(".") || "(arguments)"}: ${issue.code}`
  );
  return `The tool arguments are invalid: ${issues.join("; ")}`.slice(0, 1000);
}
