import type { AcademicStore, AcademicDirectory } from "@educateos/academics";
import type { Action } from "@educateos/contracts";
import { academicSchoolTools, type SchoolTool, type ToolTarget } from "@educateos/policy";
import { z } from "zod";

// Only server-owned definitions enter this registry. No annotation, prefix heuristic or body
// field decides an action. A missing classification is conservative and requires confirmation.
const REGISTRY: Readonly<Record<string, Action | undefined>> = Object.freeze({
  list_schools: "list", get_school: "read", list_terms: "list", get_term: "read",
  list_courses: "list", get_course: "read", list_offerings: "list", get_offering: "read",
  my_enrollments: "list", get_enrollment: "read", get_roster: "list", update_course: "update",
});

/** Trusted classification only. An unmapped server operation must wait for human confirmation. */
export function externalOperationAction(name: string): Action {
  return Object.hasOwn(REGISTRY, name) ? REGISTRY[name] ?? "invoke-tool" : "invoke-tool";
}

/**
 * Curated academic definitions with trusted actions and record targets loaded from storage.
 * Existing academic handlers still authorize every returned/changed record; collection checks
 * here never authorize their individual contents. No client metadata participates in this mapping.
 */
export function externalSchoolTools(store: AcademicStore, directory: AcademicDirectory): SchoolTool[] {
  return academicSchoolTools(store, directory).filter((tool) => Object.hasOwn(REGISTRY, tool.name)).map((tool) => ({
    ...tool,
    action: externalOperationAction(tool.name),
    async resource(input, context): Promise<ToolTarget | undefined> {
      const action = externalOperationAction(tool.name);
      if (action === "invoke-tool") return tool.resource(input, context);
      const { snapshot } = await store.load();
      const districtScope = { level: "district" as const, districtId: snapshot.district.id };
      const ids = z.object({ schoolId: z.string().optional(), termId: z.string().optional(),
        courseId: z.string().optional(), offeringId: z.string().optional(), enrollmentId: z.string().optional(),
      }).parse(input);
      const district = (kind: "school" | "term" | "course" | "offering" | "enrollment"): ToolTarget => ({
        resource: { kind, scope: districtScope, classification: "district-internal",
          ...(tool.name === "my_enrollments" ? { ownerPrincipalId: context.principal.principalId } : {}),
        },
      });
      switch (tool.name) {
        case "list_schools": return district("school");
        case "list_terms": return district("term");
        case "list_courses": return district("course");
        case "list_offerings": return district("offering");
        case "my_enrollments": return district("enrollment");
        case "get_school": {
          const row = snapshot.schools.find((s) => s.id === ids.schoolId);
          return row && { resource: { kind: "school", id: row.id, classification: "district-internal",
            scope: { level: "school", districtId: row.districtId, schoolId: row.id } } };
        }
        case "get_term": {
          const row = snapshot.terms.find((t) => t.id === ids.termId);
          return row && { resource: { kind: "term", id: row.id, classification: "district-internal", scope: districtScope } };
        }
        case "get_course":
        case "update_course": {
          const row = snapshot.courses.find((c) => c.id === ids.courseId);
          return row && { resource: { kind: "course", id: row.id, classification: "district-internal", scope: districtScope } };
        }
        case "get_offering":
        case "get_roster":
        case "get_enrollment": {
          const enrollment = tool.name === "get_enrollment" ? snapshot.enrollments.find((e) => e.id === ids.enrollmentId) : undefined;
          const offering = snapshot.offerings.find((o) => o.id === (enrollment?.offeringId ?? ids.offeringId));
          if (!offering || (tool.name === "get_enrollment" && !enrollment)) return undefined;
          const term = snapshot.terms.find((t) => t.id === offering.termId);
          return {
            resource: {
              kind: tool.name === "get_offering" ? "offering" : "enrollment",
              ...(enrollment ? { id: enrollment.id, ownerPrincipalId: enrollment.principalId } : tool.name === "get_offering" ? { id: offering.id } : {}),
              classification: tool.name === "get_offering" ? "district-internal" : "course",
              scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
            },
            ...(term ? { termState: term.state } : {}),
          };
        }
        default: return tool.resource(input, context);
      }
    },
  }));
}
