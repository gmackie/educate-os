import { z } from "zod";
import { SchoolOsError, type AuthorityMap } from "@schoolos/contracts";
import {
  ACADEMIC_OPERATIONS,
  AcademicDirectory,
  invokeOperation,
  type AcademicStore,
} from "@schoolos/academics";
import type { PolicyAuditSink } from "./audit.ts";
import { PolicyEngine } from "./engine.ts";
import { directoryPolicyInformation, type PolicySource } from "./information.ts";
import type { PolicyRule } from "./rules.ts";
import { defineSchoolTool, SchoolToolRunner, type SchoolTool } from "./tools.ts";

/** What {@link createAcademicsWithPolicy} is built from. */
export interface AcademicsWithPolicyOptions {
  /** Where the district's directory is kept. The engine reads its facts from the same store. */
  store: AcademicStore;
  /** The source of record for each directory record type. */
  authority: AuthorityMap;
  /** The effective policy floor per scope. */
  policy: PolicySource;
  /** Where every decision is recorded. */
  audit: PolicyAuditSink;
  /** The rule table. Defaults to `DEFAULT_POLICY_RULES`. */
  rules?: readonly PolicyRule[];
}

/**
 * The academic directory with the ABAC {@link PolicyEngine} behind its `Authorizer` seam in place
 * of A01's `RoleTableAuthorizer`, and its operations as school tools run through a
 * {@link SchoolToolRunner} that uses the same engine.
 */
export function createAcademicsWithPolicy(options: AcademicsWithPolicyOptions): {
  engine: PolicyEngine;
  directory: AcademicDirectory;
  tools: SchoolToolRunner;
} {
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(options.store, options.policy),
    audit: options.audit,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const directory = new AcademicDirectory({ store: options.store, authority: options.authority, authorizer: engine });
  return { engine, directory, tools: new SchoolToolRunner({ tools: academicSchoolTools(options.store, directory), engine }) };
}

/**
 * Each academic directory operation as a school tool. The runner authorizes `invoke-tool` on the
 * directory's district, so a principal from anywhere else is refused before the operation runs;
 * the operation then authorizes the record it touches through the directory's own authorizer.
 */
export function academicSchoolTools(store: AcademicStore, directory: AcademicDirectory): SchoolTool[] {
  return Object.values(ACADEMIC_OPERATIONS).map((operation) => {
    if (!(operation.input instanceof z.ZodObject)) throw new Error(`operation ${operation.name} input is not an object`);
    return defineSchoolTool({
      name: operation.name,
      description: operation.description,
      inputSchema: operation.input,
      action: "invoke-tool",
      resource: async () => {
        const { district } = (await store.load()).snapshot;
        return {
          resource: {
            kind: "district",
            id: district.id,
            scope: { level: "district", districtId: district.id },
            classification: "district-internal",
          },
        };
      },
      handler: async (input, context) => {
        const outcome = await invokeOperation(operation, directory, { principal: context.principal, channel: context.channel }, input);
        if (!outcome.ok) throw new SchoolOsError(outcome.error.code, outcome.error.message);
        return outcome.value;
      },
    });
  });
}
