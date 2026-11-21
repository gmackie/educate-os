import { z } from "zod";
import { ACADEMIC_OPERATIONS, type AcademicDirectory, type AcademicStore } from "@educateos/academics";
import type { Action, ActivityDefinitionId, ActivityId, ApprovalPolicy, ContentItemId, OperationEffect, ResourceKind } from "@educateos/contracts";
import type { DistrictApp, McpToolCatalogEntry } from "@educateos/district-app";
import { ROUTES, type RouteName } from "@educateos/district-app/routes";
import { academicSchoolTools, defineSchoolTool, type SchoolTool, type SchoolToolContext, type ToolTarget } from "@educateos/policy";

/** Metadata attached alongside each SchoolTool for the Management UI catalog browser. */
export interface LmsToolDescriptor {
  tool: SchoolTool;
  domain: string;
}

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const DRAFT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** Directory operations exposed through the full LMS-lite MCP server. Identity-linking (`create_principal`) stays HTTP-only. */
const DIRECTORY_ALLOWED: ReadonlySet<string> = new Set([
  "list_schools", "get_school", "create_school", "update_school",
  "list_terms", "get_term", "create_term", "update_term", "transition_term",
  "list_courses", "get_course", "create_course", "update_course", "set_course_archived",
  "list_offerings", "get_offering", "create_offering", "update_offering", "set_offering_archived",
  "my_enrollments", "get_enrollment", "get_roster", "create_enrollment", "deactivate_enrollment",
  "update_principal", "set_principal_status", "reactivate_principal",
]);

/** Looks up an offering's scope and term state from live district storage. */
async function offeringTarget(
  store: AcademicStore,
  offeringId: string,
  kind: ResourceKind,
  classification: "course" | "teacher-only" | "district-internal" = "course",
  id?: string,
): Promise<ToolTarget | undefined> {
  const { snapshot } = await store.load();
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  if (offering === undefined) return undefined;
  const term = snapshot.terms.find((t) => t.id === offering.termId);
  return {
    resource: {
      kind,
      ...(id === undefined ? {} : { id }),
      classification,
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
    },
    ...(term === undefined ? {} : { termState: term.state }),
  };
}

/** Looks up an assignment's offering from live assessment storage. */
async function assignmentOfferingId(app: DistrictApp, assignmentId: string): Promise<string | undefined> {
  const { state } = await app.stores.assessment.load();
  return state.assignments.find((a) => a.id === assignmentId)?.offeringId;
}

/** Looks up a submission's offering from live assessment storage. */
async function submissionOfferingId(app: DistrictApp, submissionId: string): Promise<{ offeringId: string; studentId: string } | undefined> {
  const { state } = await app.stores.assessment.load();
  const submission = state.submissions.find((s) => s.id === submissionId);
  if (submission === undefined) return undefined;
  const assignment = state.assignments.find((a) => a.id === submission.assignmentId);
  if (assignment === undefined) return undefined;
  return { offeringId: assignment.offeringId, studentId: submission.studentPrincipalId };
}

/** Looks up a workspace's offering from live workspace storage. */
async function workspaceOfferingId(app: DistrictApp, workspaceId: string): Promise<string | undefined> {
  const { state } = await app.stores.workspaces.load();
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  return ws !== undefined && ws.kind === "course" ? ws.offeringId : undefined;
}

/** Builds a strict Zod input schema combining a route's params, query, and object body. */
function routeInputSchema<N extends RouteName>(name: N): z.ZodObject {
  const spec = ROUTES[name] as { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType };
  let shape: Record<string, z.ZodType> = {};
  if (spec.params instanceof z.ZodObject) shape = { ...shape, ...spec.params.shape };
  if (spec.query instanceof z.ZodObject) shape = { ...shape, ...spec.query.shape };
  if (spec.body instanceof z.ZodObject) {
    // Omit empty NoBody keys; extend with actual body fields.
    shape = { ...shape, ...spec.body.shape };
  }
  return z.strictObject(shape);
}

/** Splits a merged tool input object back into `{ params, query, body }` for `app.callForTool`. */
function splitRouteInput<N extends RouteName>(name: N, input: Record<string, unknown>) {
  const spec = ROUTES[name] as { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType };
  const paramKeys = spec.params instanceof z.ZodObject ? new Set(Object.keys(spec.params.shape)) : new Set<string>();
  const queryKeys = spec.query instanceof z.ZodObject ? new Set(Object.keys(spec.query.shape)) : new Set<string>();
  const bodyKeys = spec.body instanceof z.ZodObject ? new Set(Object.keys(spec.body.shape)) : new Set<string>();
  const params: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (paramKeys.has(k)) params[k] = v;
    else if (queryKeys.has(k)) query[k] = v;
    else if (bodyKeys.has(k)) body[k] = v;
  }
  return {
    ...(paramKeys.size > 0 ? { params } : {}),
    ...(queryKeys.size > 0 ? { query } : {}),
    ...(spec.body !== undefined ? { body } : {}),
  };
}

/** Builds a SchoolTool backed by one typed `DistrictApp` route, preserving delegation + channel + correlationId. */
function routeTool<N extends RouteName>(
  app: DistrictApp,
  config: {
    name: string;
    domain: string;
    description: string;
    route: N;
    action: Action;
    effect: OperationEffect;
    approval?: ApprovalPolicy;
    inputSchema?: z.ZodObject;
    mapInput?: (input: Record<string, unknown>) => { params?: unknown; query?: unknown; body?: unknown };
    resource: (input: Record<string, unknown>, context: SchoolToolContext) => Promise<ToolTarget | undefined>;
  },
): LmsToolDescriptor {
  const inputSchema = config.inputSchema ?? routeInputSchema(config.route);
  const annotations = config.effect === "read"
    ? READ_ANNOTATIONS
    : config.effect === "draft"
      ? DRAFT_ANNOTATIONS
      : WRITE_ANNOTATIONS;
  const tool = defineSchoolTool({
    name: config.name,
    description: config.description,
    inputSchema,
    action: config.action,
    effect: config.effect,
    ...(config.approval === undefined ? {} : { approval: config.approval }),
    annotations,
    resource: (input, context) => config.resource(input as Record<string, unknown>, context),
    handler: async (input, context) => {
      const mapped = config.mapInput
        ? config.mapInput(input as Record<string, unknown>)
        : splitRouteInput(config.route, input as Record<string, unknown>);
      return await app.callForTool(config.route, mapped, {
        principal: context.principal,
        channel: context.channel,
        correlationId: context.correlationId,
      });
    },
  });
  return { tool, domain: config.domain };
}

/**
 * Full School LMS-Lite MCP toolset over one district's live `DistrictApp` and stores.
 *
 * Every tool resolves its target from live stored records, authorizes through `PolicyEngine`
 * under the caller's live directory standing and delegation ceiling, and invokes the district's
 * real domain services. Sensitive human-only operations (official grade approval/release,
 * identity links, district-admin grants, delegations, IEP/504 accommodations, audit logs,
 * bulk exports) are deliberately excluded and stay HTTP-only.
 */
export function lmsSchoolToolDescriptors(
  app: DistrictApp,
  store: AcademicStore,
  directory: AcademicDirectory,
): LmsToolDescriptor[] {
  const districtRead = async (kind: ResourceKind, ownerPrincipalId?: string): Promise<ToolTarget> => {
    const { snapshot } = await store.load();
    return {
      resource: {
        kind,
        classification: "district-internal",
        scope: { level: "district", districtId: snapshot.district.id },
        ...(ownerPrincipalId === undefined ? {} : { ownerPrincipalId: ownerPrincipalId as never }),
      },
    };
  };

  // 1. Academic directory tools (schools, terms, courses, offerings, enrollments, principals)
  const directoryTools: LmsToolDescriptor[] = academicSchoolTools(store, directory)
    .filter((tool) => DIRECTORY_ALLOWED.has(tool.name))
    .map((tool) => {
      const op = ACADEMIC_OPERATIONS[tool.name as keyof typeof ACADEMIC_OPERATIONS];
      const action: Action = op?.action ?? "invoke-tool";
      const effect: OperationEffect = op?.effect ?? "write";
      const isRead = effect === "read";
      const wrapped: SchoolTool = {
        ...tool,
        action,
        effect,
        readOnly: isRead,
        annotations: isRead ? READ_ANNOTATIONS : WRITE_ANNOTATIONS,
        async resource(input, context): Promise<ToolTarget | undefined> {
          const { snapshot } = await store.load();
          const districtScope = { level: "district" as const, districtId: snapshot.district.id };
          const ids = input as Record<string, string | undefined>;
          switch (tool.name) {
            case "list_schools":
            case "create_school":
              return { resource: { kind: "school", classification: "district-internal", scope: districtScope } };
            case "get_school":
            case "update_school": {
              const row = snapshot.schools.find((s) => s.id === ids.schoolId);
              return row && { resource: { kind: "school", id: row.id, classification: "district-internal", scope: { level: "school", districtId: row.districtId, schoolId: row.id } } };
            }
            case "list_terms":
            case "create_term":
              return { resource: { kind: "term", classification: "district-internal", scope: districtScope } };
            case "get_term":
            case "update_term":
            case "transition_term": {
              const row = snapshot.terms.find((t) => t.id === ids.termId);
              return row && { resource: { kind: "term", id: row.id, classification: "district-internal", scope: districtScope } };
            }
            case "list_courses":
            case "create_course":
              return { resource: { kind: "course", classification: "district-internal", scope: districtScope } };
            case "get_course":
            case "update_course":
            case "set_course_archived": {
              const row = snapshot.courses.find((c) => c.id === ids.courseId);
              return row && { resource: { kind: "course", id: row.id, classification: "district-internal", scope: districtScope } };
            }
            case "list_offerings":
              return { resource: { kind: "offering", classification: "district-internal", scope: districtScope } };
            case "create_offering": {
              const school = snapshot.schools.find((s) => s.id === ids.schoolId);
              return school && { resource: { kind: "offering", classification: "district-internal", scope: { level: "school", districtId: school.districtId, schoolId: school.id } } };
            }
            case "get_offering":
            case "update_offering":
            case "set_offering_archived":
              return ids.offeringId ? offeringTarget(store, ids.offeringId, "offering", "district-internal", ids.offeringId) : undefined;
            case "my_enrollments":
              return districtRead("enrollment", context.principal.principalId);
            case "get_roster":
            case "create_enrollment":
              return ids.offeringId ? offeringTarget(store, ids.offeringId, "enrollment", "course") : undefined;
            case "get_enrollment":
            case "deactivate_enrollment": {
              const enrollment = snapshot.enrollments.find((e) => e.id === ids.enrollmentId);
              if (!enrollment) return undefined;
              const offering = snapshot.offerings.find((o) => o.id === enrollment.offeringId);
              if (!offering) return undefined;
              const term = snapshot.terms.find((t) => t.id === offering.termId);
              return {
                resource: {
                  kind: "enrollment",
                  id: enrollment.id,
                  ownerPrincipalId: enrollment.principalId,
                  classification: "course",
                  scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
                },
                ...(term ? { termState: term.state } : {}),
              };
            }
            case "update_principal":
            case "set_principal_status":
            case "reactivate_principal": {
              const principal = snapshot.principals.find((p) => p.id === ids.principalId);
              return principal && { resource: { kind: "principal", id: principal.id, classification: "district-internal", scope: districtScope } };
            }
            default:
              return tool.resource(input, context);
          }
        },
      };
      return { tool: wrapped, domain: "Directory" };
    });

  // 2. Self & schedule
  const selfTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "get_my_profile",
      domain: "Profile & Schedule",
      description: "Get the signed-in staff member's profile, roles, and active offerings.",
      route: "me.get",
      action: "invoke-tool",
      effect: "read",
      resource: () => districtRead("district"),
    }),
    routeTool(app, {
      name: "get_my_calendar",
      domain: "Profile & Schedule",
      description: "Get upcoming class deadlines, quiz windows, and schedule events.",
      route: "me.calendar",
      action: "invoke-tool",
      effect: "read",
      resource: () => districtRead("district"),
    }),
    routeTool(app, {
      name: "list_my_notifications",
      domain: "Profile & Schedule",
      description: "List the signed-in person's recent LMS notifications.",
      route: "me.notifications",
      action: "invoke-tool",
      effect: "read",
      resource: () => districtRead("district"),
    }),
    routeTool(app, {
      name: "list_my_teaching_offerings",
      domain: "Directory",
      description: "List the class offerings you actively teach or administer.",
      route: "teacher.listOfferings",
      action: "invoke-tool",
      effect: "read",
      resource: () => districtRead("district"),
    }),
    {
      domain: "Directory",
      tool: defineSchoolTool({
        name: "list_principals",
        description: "List student and staff principals in the district directory (display info only, never sign-in credentials).",
        inputSchema: z.strictObject({ kind: z.enum(["student", "staff", "guardian"]).optional(), status: z.enum(["active", "inactive"]).optional() }),
        action: "list",
        effect: "read",
        annotations: READ_ANNOTATIONS,
        resource: () => districtRead("principal"),
        handler: async (input) => {
          const { snapshot } = await store.load();
          return snapshot.principals
            .filter((p) => (input.kind === undefined || p.kind === input.kind) && (input.status === undefined || p.status === input.status))
            .map((p) => ({
              id: p.id,
              districtId: p.districtId,
              kind: p.kind,
              status: p.status,
              displayName: p.displayName,
            }));
        },
      }),
    },
  ];

  // 3. Course modules & pages (LMS-lite course authoring)
  const moduleTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_modules",
      domain: "Modules & Pages",
      description: "List a class offering's course outline: modules, pages, and placed activities.",
      route: "teacher.listModules",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "teacher-only"),
    }),
    routeTool(app, {
      name: "create_module",
      domain: "Modules & Pages",
      description: "Create a new draft module in a class offering.",
      route: "teacher.createModule",
      action: "create",
      effect: "draft",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "teacher-only"),
    }),
    routeTool(app, {
      name: "update_module",
      domain: "Modules & Pages",
      description: "Rename, publish, or unpublish a module in a class offering.",
      route: "teacher.updateModule",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "course", String(i.moduleId)),
    }),
    routeTool(app, {
      name: "add_course_page",
      domain: "Modules & Pages",
      description: "Add a new content page inside a course module.",
      route: "teacher.addPage",
      action: "create",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "teacher-only", String(i.moduleId)),
    }),
    routeTool(app, {
      name: "update_course_page",
      domain: "Modules & Pages",
      description: "Update the title or markdown body of a course page.",
      route: "teacher.updatePage",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "teacher-only", String(i.pageId)),
    }),
    routeTool(app, {
      name: "place_module_activity",
      domain: "Modules & Pages",
      description: "Place an installed class activity inside a course module.",
      route: "teacher.placeActivity",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-content", "course", String(i.moduleId)),
    }),
  ];

  // 4. Curriculum, activities & course library
  const curriculumTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_learning_goals",
      domain: "Curriculum & Activities",
      description: "List approved learning standards and goals aligned to a class offering's grade band.",
      route: "teacher.learningGoals",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "offering", "course", String(i.offeringId)),
    }),
    routeTool(app, {
      name: "create_activity",
      domain: "Curriculum & Activities",
      description: "Create a draft learning activity definition (writing task, science investigation, primary-source analysis, or problem set).",
      route: "teacher.createActivity",
      action: "create",
      effect: "draft",
      resource: (i) => offeringTarget(store, String(i.offeringId), "activity", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_activity",
      domain: "Curriculum & Activities",
      description: "Read an installed class activity and its instructions.",
      route: "teacher.getActivity",
      action: "read",
      effect: "read",
      resource: async (i) => {
        const inst = await app.stores.curriculum.getInstallation(String(i.activityId) as ActivityId);
        return inst ? offeringTarget(store, inst.scope.offeringId, "activity", "course", inst.id) : undefined;
      },
    }),
    routeTool(app, {
      name: "publish_activity",
      domain: "Curriculum & Activities",
      description: "Publish a draft activity definition so it can be installed into classes (requires confirmation).",
      route: "teacher.publishActivity",
      action: "update",
      effect: "publish",
      resource: async (i) => {
        const versions = await app.stores.curriculum.listVersions(String(i.definitionId) as ActivityDefinitionId);
        const def = versions.at(-1);
        const offeringId = def?.scope.level === "offering" ? def.scope.offeringId : undefined;
        return offeringId ? offeringTarget(store, offeringId, "activity", "teacher-only", def!.id) : districtRead("activity");
      },
    }),
    routeTool(app, {
      name: "install_activity",
      domain: "Curriculum & Activities",
      description: "Install a published activity definition into a class offering as an assignment (requires confirmation).",
      route: "teacher.installActivity",
      action: "create",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "activity", "teacher-only", String(i.definitionId)),
    }),
    routeTool(app, {
      name: "list_course_library",
      domain: "Curriculum & Activities",
      description: "Browse imported courses in the district course library suitable for a class offering.",
      route: "teacher.libraryCourses",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "offering", "course", String(i.offeringId)),
    }),
  ];

  // 5. Assignments, submissions, feedback & gradebook
  const assessmentTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_assignments",
      domain: "Assignments & Gradebook",
      description: "List assignments in a class offering.",
      route: "teacher.listAssignments",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "activity", "course"),
    }),
    routeTool(app, {
      name: "get_assignment",
      domain: "Assignments & Gradebook",
      description: "Get one assignment's full settings, due date, late policy, and starter materials.",
      route: "teacher.getAssignment",
      action: "read",
      effect: "read",
      resource: async (i) => {
        const offeringId = await assignmentOfferingId(app, String(i.assignmentId));
        return offeringId ? offeringTarget(store, offeringId, "activity", "course", String(i.assignmentId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "update_assignment",
      domain: "Assignments & Gradebook",
      description: "Update an assignment's title, instructions, due date, points, or late policy (requires confirmation).",
      route: "teacher.updateAssignment",
      action: "update",
      effect: "write",
      resource: async (i) => {
        const offeringId = await assignmentOfferingId(app, String(i.assignmentId));
        return offeringId ? offeringTarget(store, offeringId, "activity", "course", String(i.assignmentId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "list_submissions",
      domain: "Assignments & Gradebook",
      description: "List student submissions for an assignment.",
      route: "teacher.listSubmissions",
      action: "list",
      effect: "read",
      resource: async (i) => {
        const offeringId = await assignmentOfferingId(app, String(i.assignmentId));
        return offeringId ? offeringTarget(store, offeringId, "submission", "course") : undefined;
      },
    }),
    routeTool(app, {
      name: "get_submission_feedback",
      domain: "Assignments & Gradebook",
      description: "Read teacher comments and rubric criterion scores on a student submission.",
      route: "teacher.getFeedback",
      action: "read",
      effect: "read",
      resource: async (i) => {
        const sub = await submissionOfferingId(app, String(i.submissionId));
        return sub ? offeringTarget(store, sub.offeringId, "feedback", "course", String(i.submissionId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "add_feedback_comment",
      domain: "Assignments & Gradebook",
      description: "Add a draft teacher feedback comment to a student submission.",
      route: "teacher.addComment",
      action: "create",
      effect: "draft",
      resource: async (i) => {
        const sub = await submissionOfferingId(app, String(i.submissionId));
        return sub ? offeringTarget(store, sub.offeringId, "feedback", "teacher-only", String(i.submissionId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "score_submission_criterion",
      domain: "Assignments & Gradebook",
      description: "Record a draft rubric criterion score on a student submission.",
      route: "teacher.scoreCriterion",
      action: "update",
      effect: "draft",
      resource: async (i) => {
        const sub = await submissionOfferingId(app, String(i.submissionId));
        return sub ? offeringTarget(store, sub.offeringId, "feedback", "teacher-only", String(i.submissionId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "release_feedback",
      domain: "Assignments & Gradebook",
      description: "Release drafted feedback to a student (requires human confirmation).",
      route: "teacher.releaseFeedback",
      action: "update",
      effect: "publish",
      resource: async (i) => {
        const sub = await submissionOfferingId(app, String(i.submissionId));
        return sub ? offeringTarget(store, sub.offeringId, "feedback", "course", String(i.submissionId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "propose_grade",
      domain: "Assignments & Gradebook",
      description: "Propose a grade for a student submission. Always waits for a teacher to approve directly in EducateOS before becoming official.",
      route: "teacher.recordGrade",
      action: "review",
      effect: "write",
      approval: "approver",
      resource: async (i) => {
        const sub = await submissionOfferingId(app, String(i.submissionId));
        return sub ? offeringTarget(store, sub.offeringId, "submission", "course", String(i.submissionId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "list_pending_grades",
      domain: "Assignments & Gradebook",
      description: "List pending grade proposals awaiting teacher approval for an assignment.",
      route: "teacher.pendingGrades",
      action: "list",
      effect: "read",
      resource: async (i) => {
        const offeringId = await assignmentOfferingId(app, String(i.assignmentId));
        return offeringId ? offeringTarget(store, offeringId, "gradebook", "teacher-only") : undefined;
      },
    }),
    routeTool(app, {
      name: "get_gradebook",
      domain: "Assignments & Gradebook",
      description: "Read a class offering's computed gradebook grid (official grades and assignment columns).",
      route: "teacher.gradebook",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "gradebook", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_classroom_grades",
      domain: "Google Classroom & Sync",
      description: "Read live Google Classroom coursework and student grades mapped to a class offering (read-only; returns not-connected if the class is not synced from Google Classroom).",
      route: "teacher.classroomGrades",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "gradebook", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_roster_sync_status",
      domain: "Google Classroom & Sync",
      description: "Read the district's roster sync status and recent sync runs (Google Classroom or Clever).",
      route: "admin.rosterSyncStatus",
      action: "read",
      effect: "read",
      resource: () => districtRead("district"),
    }),
    routeTool(app, {
      name: "run_roster_sync",
      domain: "Google Classroom & Sync",
      description: "Trigger a Google Classroom or Clever roster sync run for the district (requires confirmation).",
      route: "admin.runRosterSync",
      action: "update",
      effect: "write",
      resource: () => districtRead("enrollment"),
    }),
  ];

  // 6. Quizzes
  const quizTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_quizzes",
      domain: "Quizzes",
      description: "List quizzes in a class offering.",
      route: "teacher.listQuizzes",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_quiz",
      domain: "Quizzes",
      description: "Get one quiz's full definition and questions (staff view).",
      route: "teacher.getQuiz",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz", "teacher-only", String(i.quizId)),
    }),
    routeTool(app, {
      name: "create_quiz",
      domain: "Quizzes",
      description: "Create a draft quiz (multiple choice, multiple select, true/false, numeric, short answer, essay).",
      route: "teacher.createQuiz",
      action: "create",
      effect: "draft",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz", "teacher-only"),
    }),
    routeTool(app, {
      name: "update_quiz",
      domain: "Quizzes",
      description: "Edit a quiz's title, instructions, time limit, or questions.",
      route: "teacher.updateQuiz",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz", "teacher-only", String(i.quizId)),
    }),
    routeTool(app, {
      name: "publish_quiz",
      domain: "Quizzes",
      description: "Publish or unpublish a quiz for students (requires confirmation).",
      route: "teacher.publishQuiz",
      action: "update",
      effect: "publish",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz", "course", String(i.quizId)),
    }),
    routeTool(app, {
      name: "get_quiz_results",
      domain: "Quizzes",
      description: "Read quiz attempt results and summary statistics for a class quiz.",
      route: "teacher.quizResults",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz-attempt", "teacher-only", String(i.quizId)),
    }),
    routeTool(app, {
      name: "get_quiz_attempt",
      domain: "Quizzes",
      description: "Inspect one student's quiz attempt answers and item scores.",
      route: "teacher.quizAttempt",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz-attempt", "course", String(i.attemptId)),
    }),
    routeTool(app, {
      name: "grade_quiz_item",
      domain: "Quizzes",
      description: "Score an essay or rescore an item on a student's quiz attempt (remains a proposal until released in EducateOS).",
      route: "teacher.gradeQuizItem",
      action: "review",
      effect: "draft",
      resource: (i) => offeringTarget(store, String(i.offeringId), "quiz-attempt", "course", String(i.attemptId)),
    }),
  ];

  // 7. Discussions
  const discussionTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_discussions",
      domain: "Discussions",
      description: "List discussion topics in a class offering.",
      route: "teacher.listDiscussions",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-topic", "course"),
    }),
    routeTool(app, {
      name: "get_discussion_thread",
      domain: "Discussions",
      description: "Read a discussion topic and its threaded posts.",
      route: "teacher.discussionThread",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-post", "course", String(i.topicId)),
    }),
    routeTool(app, {
      name: "create_discussion_topic",
      domain: "Discussions",
      description: "Create a new discussion topic in a class offering.",
      route: "teacher.createTopic",
      action: "create",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-topic", "course"),
    }),
    routeTool(app, {
      name: "update_discussion_topic",
      domain: "Discussions",
      description: "Edit, lock, unlock, pin, or unpin a discussion topic (requires confirmation).",
      route: "teacher.updateTopic",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-topic", "course", String(i.topicId)),
    }),
    routeTool(app, {
      name: "create_discussion_post",
      domain: "Discussions",
      description: "Post a staff reply inside a class discussion topic (requires confirmation).",
      route: "teacher.createPost",
      action: "create",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-post", "course", String(i.topicId)),
    }),
    routeTool(app, {
      name: "get_moderation_queue",
      domain: "Discussions",
      description: "List held or flagged student discussion posts awaiting teacher moderation.",
      route: "teacher.moderationQueue",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-post", "teacher-only"),
    }),
    routeTool(app, {
      name: "moderate_discussion_post",
      domain: "Discussions",
      description: "Approve, hide, restore, or remove a discussion post (requires confirmation).",
      route: "teacher.moderatePost",
      action: "review",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "discussion-post", "teacher-only", String(i.postId)),
    }),
  ];

  // 8. Announcements & family communication
  const communicationTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_announcements",
      domain: "Announcements",
      description: "List announcements for a class offering.",
      route: "teacher.listAnnouncements",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "announcement", "course"),
    }),
    routeTool(app, {
      name: "create_announcement",
      domain: "Announcements",
      description: "Post an announcement to a class offering (requires confirmation).",
      route: "teacher.createAnnouncement",
      action: "create",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "announcement", "course"),
    }),
    routeTool(app, {
      name: "get_weekly_note",
      domain: "Announcements",
      description: "Read the weekly family digest note for a class offering.",
      route: "teacher.weeklyNote",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "announcement", "course"),
    }),
    routeTool(app, {
      name: "set_weekly_note",
      domain: "Announcements",
      description: "Draft or update the weekly family digest note for a class offering.",
      route: "teacher.setWeeklyNote",
      action: "update",
      effect: "write",
      resource: (i) => offeringTarget(store, String(i.offeringId), "announcement", "course"),
    }),
  ];

  // 9. Content Studio & resources
  const resourceTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_resource_releases",
      domain: "Resources",
      description: "List approved learning resource releases available to a class offering.",
      route: "teacher.listReleases",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "learning-resource", "teacher-only"),
    }),
    routeTool(app, {
      name: "list_resource_review_queue",
      domain: "Resources",
      description: "List imported learning resources waiting in Content Studio quarantine review.",
      route: "teacher.reviewQueue",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "learning-resource", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_resource_report",
      domain: "Resources",
      description: "Read a Content Studio item's deterministic and review report.",
      route: "teacher.resourceReport",
      action: "read",
      effect: "read",
      resource: async (i) => {
        const item = await app.stores.contentStudio.getItem(String(i.itemId) as ContentItemId);
        if (!item) return undefined;
        return item.targetScope.level === "offering"
          ? offeringTarget(store, item.targetScope.offeringId, "learning-resource", "teacher-only", item.id)
          : districtRead("learning-resource");
      },
    }),
  ];

  // 10. Workspaces, learning planner, guidance & recipes
  const learningTools: LmsToolDescriptor[] = [
    routeTool(app, {
      name: "list_class_workspaces",
      domain: "Workspaces & Planner",
      description: "List course workspaces in a class offering.",
      route: "teacher.listWorkspaces",
      action: "list",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "course-workspace", "course"),
    }),
    routeTool(app, {
      name: "list_workspace_artifacts",
      domain: "Workspaces & Planner",
      description: "List artifacts stored in a course workspace.",
      route: "teacher.listWorkspaceArtifacts",
      action: "list",
      effect: "read",
      resource: async (i) => {
        const offeringId = await workspaceOfferingId(app, String(i.workspaceId));
        return offeringId ? offeringTarget(store, offeringId, "artifact", "course", String(i.workspaceId)) : undefined;
      },
    }),
    routeTool(app, {
      name: "get_class_planner",
      domain: "Workspaces & Planner",
      description: "View students' shared personalized learning plans in a class offering.",
      route: "teacher.planner",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "rubric", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_class_guidance",
      domain: "Workspaces & Planner",
      description: "View a class offering's guidance agenda, standards evidence overview, and family suggestions.",
      route: "teacher.guidance",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "learning-guidance", "teacher-only"),
    }),
    routeTool(app, {
      name: "get_class_recipes",
      domain: "Workspaces & Planner",
      description: "View learning recipes and approval status for a class offering.",
      route: "teacher.recipes",
      action: "read",
      effect: "read",
      resource: (i) => offeringTarget(store, String(i.offeringId), "learning-guidance", "teacher-only"),
    }),
  ];

  return [
    ...selfTools,
    ...directoryTools,
    ...moduleTools,
    ...curriculumTools,
    ...assessmentTools,
    ...quizTools,
    ...discussionTools,
    ...communicationTools,
    ...resourceTools,
    ...learningTools,
  ];
}

/** Convenience helper returning only the `SchoolTool[]` array for `SchoolToolRunner`. */
export function lmsSchoolTools(app: DistrictApp, store: AcademicStore, directory: AcademicDirectory): SchoolTool[] {
  return lmsSchoolToolDescriptors(app, store, directory).map((d) => d.tool);
}

/** Produces UI-ready catalog metadata describing every exposed LMS-lite tool and whether it queues for approval. */
export function describeMcpCatalog(descriptors: readonly LmsToolDescriptor[], allowDrafts: boolean): McpToolCatalogEntry[] {
  return descriptors.map(({ tool, domain }) => {
    const effect: OperationEffect = tool.effect ?? (tool.readOnly ? "read" : "write");
    const requiresApproval = tool.approval === "approver"
      || (effect !== "read" && !(allowDrafts && effect === "draft"));
    return {
      name: tool.name,
      description: tool.description,
      domain,
      action: tool.action,
      effect,
      requiresApproval,
    };
  });
}
