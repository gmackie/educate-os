// The district application's HTTP contract: every route's method, path, surface and Zod schemas.
// The server validates requests with these schemas and the typed client (`@schoolos/api-client`)
// is written against the same table, so the two cannot drift.
import { z } from "zod";
import {
  ActivityId,
  ArtifactId,
  AssessmentRunId,
  CatalogCourse,
  ConfigRevisionId,
  ConfigurationRevision,
  CourseOffering,
  DistrictId,
  Enrollment,
  OfferingId,
  PolicySettings,
  PrincipalId,
  PrincipalKind,
  RoleAssignment,
  SubmissionId,
  TermId,
  WorkspaceId,
} from "@schoolos/contracts";
import { CourseWorkspace, PersonalWorkspace, PromotionLink, WorkspaceLifecycle, type TermRolloverPreview } from "@schoolos/workspaces";
import {
  AiAssistance,
  Artifact,
  ArtifactRevision,
  ArtifactType,
  ContentDigest,
  RevisionContentInput,
  RevisionId,
} from "@schoolos/learning-artifacts";
import {
  AssignmentBinding,
  AssignmentId,
  CriterionId,
  FeedbackAnchor,
  FeedbackComment,
  FeedbackRecord,
  GradeProposal,
  GradeProposalId,
  GradeScore,
  CriterionScore,
  LatePolicy,
  FeedbackVisibility,
  OfficialGradeVersion,
  RubricReleaseRef,
  SubmissionItem,
  SubmissionReceipt,
  SubmissionSnapshot,
} from "@schoolos/assessment";
import { AlignmentInput, ContentItemId, type ContentItem, type QueueEntry, type StudioRelease } from "@schoolos/content-studio";
import { ActivityContent, ActivityDefinition, ActivityDefinitionId, ActivityInstallation, TemplateInput } from "@schoolos/curriculum";
import { EvidenceContract } from "@schoolos/registry";
import { AssessmentReport, IdempotencyKey, RubricDraft, RubricRelease, RunError, RunState } from "@schoolos/assessment-ci";
import type { UsageReport } from "@schoolos/ai-governance";
import type { ConfigProblem, ConfigurationPlan } from "@schoolos/config";
import type { oneroster } from "@schoolos/integrations";

/**
 * Which part of SchoolOS a route belongs to. Student routes answer only student principals, and
 * teacher and admin routes only staff; within a surface, every decision is still the policy
 * engine's.
 */
export type Surface = "me" | "student" | "teacher" | "admin";

/** One route of the district API. */
export interface RouteSpec {
  /** The HTTP method. */
  readonly method: "GET" | "POST";
  /** The path, with `:name` segments for path parameters. */
  readonly path: `/api/${string}`;
  /** The surface the route belongs to. */
  readonly surface: Surface;
  /** The path parameters, one per `:name` segment. */
  readonly params?: z.ZodObject;
  /** The query string. */
  readonly query?: z.ZodObject;
  /** The JSON body. */
  readonly body?: z.ZodType;
  /** The JSON response on success. */
  readonly response: z.ZodType;
  /** The success status. Defaults to 200. */
  readonly status?: 200 | 201;
}

/** A response type the domain package declares as an interface rather than a schema. */
const declared = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null);

// Shared shapes

/** Artifact content a JSON client can send: text, or a link to an approved external document. */
export const JsonRevisionContent = z.discriminatedUnion("kind", [RevisionContentInput.options[0], RevisionContentInput.options[2]]);
/** JSON artifact content. */
export type JsonRevisionContent = z.infer<typeof JsonRevisionContent>;

/** A revision's content as the API returns it. Bytes travel as base64. */
export const RevisionContentBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("bytes"), base64: z.string() }),
  z.strictObject({ kind: z.literal("external"), url: z.string(), snapshotDigest: ContentDigest.optional() }),
]);
/** Revision content in a response. */
export type RevisionContentBody = z.infer<typeof RevisionContentBody>;

/** A workspace with its derived lifecycle. The storage handle is present only for its owner. */
export const WorkspaceViewBody = z.discriminatedUnion("kind", [
  PersonalWorkspace.extend({ lifecycle: WorkspaceLifecycle }),
  CourseWorkspace.extend({ lifecycle: WorkspaceLifecycle }),
]);
/** A workspace view. */
export type WorkspaceViewBody = z.infer<typeof WorkspaceViewBody>;

/** An artifact and its latest revision. */
export const ArtifactViewBody = z.strictObject({ artifact: Artifact, head: ArtifactRevision });
/** An artifact view. */
export type ArtifactViewBody = z.infer<typeof ArtifactViewBody>;

/** One revision of an artifact with its verified content. */
export const ArtifactReadBody = z.strictObject({ artifact: Artifact, revision: ArtifactRevision, content: RevisionContentBody });
/** A read artifact revision. */
export type ArtifactReadBody = z.infer<typeof ArtifactReadBody>;

/** An installed activity as one reader may see it: staff in full, students without teacher-only material. */
export const ActivityViewBody = z.strictObject({
  view: z.enum(["teacher", "student"]),
  installation: ActivityInstallation,
  content: ActivityContent,
  evidenceContract: EvidenceContract,
});
/** An activity view. */
export type ActivityViewBody = z.infer<typeof ActivityViewBody>;

/** An activity assigned in a class, with what the reader may see of it. */
export const AssignedActivityBody = z.strictObject({ assignment: AssignmentBinding, activity: ActivityViewBody });
/** An assigned activity. */
export type AssignedActivityBody = z.infer<typeof AssignedActivityBody>;

/**
 * A project's working tree as a JSON client sends it: text files only. The project service checks
 * each path and the tree's limits.
 */
export const ProjectFilesInput = z.array(z.strictObject({ path: z.string().min(1).max(1024), text: z.string() })).min(1).max(500);

/** One saved version of a project. No Git term appears in it. */
export const ProjectVersionBody = z.strictObject({
  revisionId: RevisionId,
  number: z.int().positive(),
  message: z.string(),
  savedAt: z.string(),
  savedBy: z.string(),
  contentDigest: ContentDigest,
  revisionDigest: ContentDigest,
  fileCount: z.int().nonnegative(),
});
/** A project version. */
export type ProjectVersionBody = z.infer<typeof ProjectVersionBody>;

/** What the signed-in principal is, from the district directory only. */
export const MeBody = z.strictObject({
  principalId: PrincipalId,
  districtId: DistrictId,
  kind: PrincipalKind,
  displayName: z.string(),
  /** The roles in force, as the policy engine sees them. */
  roles: z.array(RoleAssignment.pick({ role: true, scope: true })),
  /** Active enrollments. */
  enrollments: z.array(Enrollment.pick({ offeringId: true, role: true })),
});
/** The signed-in principal. */
export type MeBody = z.infer<typeof MeBody>;

/** An offering a teacher teaches, with its course and the teacher's role in it. */
export const TeachingOfferingBody = z.strictObject({
  offering: CourseOffering,
  course: CatalogCourse,
  role: z.enum(["teacher", "co-teacher"]),
});
/** A teaching offering. */
export type TeachingOfferingBody = z.infer<typeof TeachingOfferingBody>;

/** One roster row: an enrollment and the enrolled principal's display name. */
export const RosterEntryBody = z.strictObject({ enrollment: Enrollment, displayName: z.string() });
/** A roster entry. */
export type RosterEntryBody = z.infer<typeof RosterEntryBody>;

/** The assignment settings a teacher chooses when installing an activity into a class. */
export const AssignmentSettingsInput = z.strictObject({
  /** Defaults to the activity's title. */
  title: z.string().trim().min(1).max(200).optional(),
  /** Used when the activity has no due date of its own; defaults to the end of the term. */
  dueAt: z.iso.datetime({ offset: true }).optional(),
  latePolicy: LatePolicy.default({ kind: "accept" }),
  attemptsAllowed: z.int().min(1).max(100).default(3),
  feedbackVisibility: FeedbackVisibility.default("when-shared"),
  rubric: RubricReleaseRef.optional(),
});
/** Assignment settings. */
export type AssignmentSettingsInput = z.input<typeof AssignmentSettingsInput>;

/** An Assessment CI run as a teacher sees it, and the suggested scores it posted to the submission's feedback. */
export const CiRunBody = z.strictObject({
  run: z.strictObject({
    view: z.literal("teacher"),
    runId: AssessmentRunId,
    state: RunState,
    report: AssessmentReport.optional(),
    error: RunError.optional(),
  }),
  /** Empty unless the run completed. */
  suggestions: z.array(CriterionScore),
});
/** A CI run. */
export type CiRunBody = z.infer<typeof CiRunBody>;

/** District health for administrators: counts and states only, never names or content. */
export const DistrictHealthBody = z.strictObject({
  districtId: DistrictId,
  directory: z.strictObject({
    schools: z.int(),
    terms: z.int(),
    offerings: z.int(),
    students: z.int(),
    staff: z.int(),
    activeEnrollments: z.int(),
  }),
  work: z.strictObject({ workspaces: z.int(), artifacts: z.int(), submissions: z.int(), installedActivities: z.int() }),
  content: z.strictObject({ awaitingReview: z.int(), releases: z.int() }),
  config: z.strictObject({ headRevisionId: ConfigRevisionId.optional(), revisions: z.int() }),
  aiRequests: z.int(),
});
/** District health. */
export type DistrictHealthBody = z.infer<typeof DistrictHealthBody>;

/** A OneRoster bulk export: file name to CSV text. */
export const RosterFilesInput = z.strictObject({
  files: z.record(z.string().regex(/^[A-Za-z]+\.csv$/, "expected a OneRoster CSV file name"), z.string().max(5 * 1024 * 1024)),
});
/** A roster import request. */
export type RosterFilesInput = z.infer<typeof RosterFilesInput>;

/** A configuration document to plan or apply. */
export const ConfigDocumentInput = z.strictObject({
  /** A `schoolos.dev/v1alpha1` district document, as JSON. */
  document: z.record(z.string(), z.unknown()),
});

/** A configuration plan, or why the document does not compile. */
export const ConfigPlanBody = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), revision: ConfigurationRevision, plan: declared<ConfigurationPlan>() }),
  z.strictObject({ ok: z.literal(false), problems: z.array(declared<ConfigProblem>()) }),
]);
/** A configuration plan. */
export type ConfigPlanBody = z.infer<typeof ConfigPlanBody>;

const params = <S extends z.core.$ZodLooseShape>(shape: S) => z.strictObject(shape);
const NoBody = z.strictObject({});

/** Defines a route, keeping its literal types. */
function route<const S extends RouteSpec>(spec: S): S {
  return spec;
}

/**
 * Every route of the district API, keyed by a stable name. Route names, not paths, are what the
 * typed client calls.
 */
export const ROUTES = {
  // Me
  "me.get": route({ method: "GET", path: "/api/me", surface: "me", response: MeBody }),

  // Student: workspaces
  "student.listWorkspaces": route({ method: "GET", path: "/api/student/workspaces", surface: "student", response: z.array(WorkspaceViewBody) }),
  "student.openPersonalWorkspace": route({
    method: "POST", path: "/api/student/workspaces/personal", surface: "student", body: NoBody, response: WorkspaceViewBody,
  }),
  "student.openCourseWorkspace": route({
    method: "POST", path: "/api/student/offerings/:offeringId/workspace", surface: "student",
    params: params({ offeringId: OfferingId }), body: NoBody, response: WorkspaceViewBody,
  }),
  // Student: activities
  "student.listActivities": route({
    method: "GET", path: "/api/student/offerings/:offeringId/activities", surface: "student",
    params: params({ offeringId: OfferingId }), response: z.array(AssignedActivityBody),
  }),
  "student.getActivity": route({
    method: "GET", path: "/api/student/activities/:activityId", surface: "student",
    params: params({ activityId: ActivityId }), response: ActivityViewBody,
  }),
  // Student: artifacts
  "student.listArtifacts": route({
    method: "GET", path: "/api/student/workspaces/:workspaceId/artifacts", surface: "student",
    params: params({ workspaceId: WorkspaceId }), response: z.array(ArtifactViewBody),
  }),
  "student.createArtifact": route({
    method: "POST", path: "/api/student/artifacts", surface: "student", status: 201,
    body: z.strictObject({
      workspaceId: WorkspaceId,
      type: ArtifactType,
      title: z.string().trim().min(1).max(200),
      content: JsonRevisionContent,
      aiAssistance: AiAssistance.default({ level: "none" }),
    }),
    response: ArtifactViewBody,
  }),
  "student.saveRevision": route({
    method: "POST", path: "/api/student/artifacts/:artifactId/revisions", surface: "student", status: 201,
    params: params({ artifactId: ArtifactId }),
    body: z.strictObject({ content: JsonRevisionContent, aiAssistance: AiAssistance.default({ level: "none" }) }),
    response: ArtifactViewBody,
  }),
  "student.getArtifact": route({
    method: "GET", path: "/api/student/artifacts/:artifactId", surface: "student",
    params: params({ artifactId: ArtifactId }), query: z.strictObject({ revisionId: RevisionId.optional() }), response: ArtifactReadBody,
  }),
  "student.artifactHistory": route({
    method: "GET", path: "/api/student/artifacts/:artifactId/history", surface: "student",
    params: params({ artifactId: ArtifactId }), response: z.array(ArtifactRevision),
  }),
  "student.keepArtifact": route({
    method: "POST", path: "/api/student/workspaces/:workspaceId/artifacts/:artifactId/keep", surface: "student",
    params: params({ workspaceId: WorkspaceId, artifactId: ArtifactId }), body: NoBody, response: PromotionLink,
  }),
  // Student: multi-file projects (W03), where the district enabled them
  "student.createProject": route({
    method: "POST", path: "/api/student/projects", surface: "student", status: 201,
    body: z.strictObject({
      workspaceId: WorkspaceId,
      type: z.enum(["notebook", "dataset", "interactive"]),
      title: z.string().trim().min(1).max(200),
      files: ProjectFilesInput,
      message: z.string().trim().min(1).max(500),
      aiAssistance: AiAssistance.default({ level: "none" }),
    }),
    response: z.strictObject({ artifact: Artifact, latest: ProjectVersionBody }),
  }),
  "student.saveProject": route({
    method: "POST", path: "/api/student/projects/:artifactId/versions", surface: "student", status: 201,
    params: params({ artifactId: ArtifactId }),
    body: z.strictObject({ files: ProjectFilesInput, message: z.string().trim().min(1).max(500), aiAssistance: AiAssistance.default({ level: "none" }) }),
    response: ProjectVersionBody,
  }),
  "student.projectHistory": route({
    method: "GET", path: "/api/student/projects/:artifactId/versions", surface: "student",
    params: params({ artifactId: ArtifactId }), response: z.array(ProjectVersionBody),
  }),
  // Student: submissions and feedback
  "student.submit": route({
    method: "POST", path: "/api/student/assignments/:assignmentId/submissions", surface: "student", status: 201,
    params: params({ assignmentId: AssignmentId }),
    body: z.strictObject({ revisions: z.array(z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId })).min(1).max(50) }),
    response: SubmissionReceipt,
  }),
  "student.listSubmissions": route({
    method: "GET", path: "/api/student/assignments/:assignmentId/submissions", surface: "student",
    params: params({ assignmentId: AssignmentId }), response: z.array(SubmissionSnapshot),
  }),
  "student.getFeedback": route({
    method: "GET", path: "/api/student/submissions/:submissionId/feedback", surface: "student",
    params: params({ submissionId: SubmissionId }), response: FeedbackRecord,
  }),
  "student.officialGrades": route({
    method: "GET", path: "/api/student/assignments/:assignmentId/grades", surface: "student",
    params: params({ assignmentId: AssignmentId }), response: z.array(OfficialGradeVersion),
  }),

  // Teacher: classes
  "teacher.listOfferings": route({ method: "GET", path: "/api/teacher/offerings", surface: "teacher", response: z.array(TeachingOfferingBody) }),
  "teacher.roster": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/roster", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(RosterEntryBody),
  }),
  "teacher.listWorkspaces": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/workspaces", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(WorkspaceViewBody),
  }),
  "teacher.listWorkspaceArtifacts": route({
    method: "GET", path: "/api/teacher/workspaces/:workspaceId/artifacts", surface: "teacher",
    params: params({ workspaceId: WorkspaceId }), response: z.array(ArtifactViewBody),
  }),
  // Teacher: resources
  "teacher.importResource": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/resources", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: z.strictObject({ url: z.string().min(1).max(2048) }), response: declared<ContentItem>(),
  }),
  "teacher.reviewQueue": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/resources/queue", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(declared<QueueEntry>()),
  }),
  "teacher.listReleases": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/resources/releases", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(declared<StudioRelease>()),
  }),
  "teacher.resourceReport": route({
    method: "GET", path: "/api/teacher/resources/:itemId", surface: "teacher",
    params: params({ itemId: ContentItemId }), response: declared<ContentItem>(),
  }),
  "teacher.approveResource": route({
    method: "POST", path: "/api/teacher/resources/:itemId/approve", surface: "teacher",
    params: params({ itemId: ContentItemId }), body: z.strictObject({ alignments: z.array(AlignmentInput).max(50).default([]) }),
    response: declared<StudioRelease>(),
  }),
  // Teacher: activities
  "teacher.createActivity": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/activities", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: z.strictObject({ activity: TemplateInput }), response: ActivityDefinition,
  }),
  "teacher.publishActivity": route({
    method: "POST", path: "/api/teacher/activity-definitions/:definitionId/publish", surface: "teacher",
    params: params({ definitionId: ActivityDefinitionId }), body: NoBody, response: ActivityDefinition,
  }),
  "teacher.installActivity": route({
    method: "POST", path: "/api/teacher/activity-definitions/:definitionId/install", surface: "teacher", status: 201,
    params: params({ definitionId: ActivityDefinitionId }),
    body: z.strictObject({ offeringId: OfferingId, version: z.int().positive().optional(), assignment: AssignmentSettingsInput.prefault({}) }),
    response: z.strictObject({ installation: ActivityInstallation, assignment: AssignmentBinding }),
  }),
  "teacher.listAssignments": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/assignments", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(AssignmentBinding),
  }),
  "teacher.getActivity": route({
    method: "GET", path: "/api/teacher/activities/:activityId", surface: "teacher",
    params: params({ activityId: ActivityId }), response: ActivityViewBody,
  }),
  // Teacher: submissions, feedback and grades
  "teacher.listSubmissions": route({
    method: "GET", path: "/api/teacher/assignments/:assignmentId/submissions", surface: "teacher",
    params: params({ assignmentId: AssignmentId }), response: z.array(SubmissionSnapshot),
  }),
  "teacher.submittedContent": route({
    method: "GET", path: "/api/teacher/submissions/:submissionId/artifacts/:artifactId", surface: "teacher",
    params: params({ submissionId: SubmissionId, artifactId: ArtifactId }),
    response: z.strictObject({ item: SubmissionItem, content: RevisionContentBody }),
  }),
  "teacher.getFeedback": route({
    method: "GET", path: "/api/teacher/submissions/:submissionId/feedback", surface: "teacher",
    params: params({ submissionId: SubmissionId }), response: FeedbackRecord,
  }),
  "teacher.addComment": route({
    method: "POST", path: "/api/teacher/submissions/:submissionId/comments", surface: "teacher", status: 201,
    params: params({ submissionId: SubmissionId }),
    body: z.strictObject({ anchor: FeedbackAnchor.optional(), body: z.string().trim().min(1).max(5000) }),
    response: FeedbackComment,
  }),
  "teacher.scoreCriterion": route({
    method: "POST", path: "/api/teacher/submissions/:submissionId/scores", surface: "teacher",
    params: params({ submissionId: SubmissionId }),
    body: z.strictObject({ criterionId: CriterionId, points: z.number().nonnegative().max(1000), maxPoints: z.number().positive().max(1000).optional() }),
    response: CriterionScore,
  }),
  "teacher.releaseFeedback": route({
    method: "POST", path: "/api/teacher/submissions/:submissionId/feedback/release", surface: "teacher",
    params: params({ submissionId: SubmissionId }), body: z.strictObject({ state: z.enum(["shared-with-student", "final"]) }),
    response: FeedbackRecord,
  }),
  "teacher.signRubric": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/rubrics", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: z.strictObject({ rubric: RubricDraft }), response: RubricRelease,
  }),
  "teacher.runCi": route({
    method: "POST", path: "/api/teacher/submissions/:submissionId/ci", surface: "teacher",
    params: params({ submissionId: SubmissionId }),
    body: z.strictObject({
      /** Retrying with the same key returns the same run. Defaults to one run per submission and rubric release. */
      idempotencyKey: IdempotencyKey.default("teacher-ci"),
    }),
    response: CiRunBody,
  }),
  "teacher.recordGrade": route({
    method: "POST", path: "/api/teacher/submissions/:submissionId/grade", surface: "teacher",
    params: params({ submissionId: SubmissionId }), body: z.strictObject({ score: GradeScore }),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("official"), version: OfficialGradeVersion }),
      z.strictObject({ status: z.literal("pending-approval"), proposal: GradeProposal }),
    ]),
  }),
  "teacher.pendingGrades": route({
    method: "GET", path: "/api/teacher/assignments/:assignmentId/grade-proposals", surface: "teacher",
    params: params({ assignmentId: AssignmentId }), response: z.array(GradeProposal),
  }),
  "teacher.approveGrade": route({
    method: "POST", path: "/api/teacher/grade-proposals/:proposalId/approve", surface: "teacher",
    params: params({ proposalId: GradeProposalId }), body: NoBody, response: OfficialGradeVersion,
  }),

  // Admin
  "admin.health": route({ method: "GET", path: "/api/admin/health", surface: "admin", response: DistrictHealthBody }),
  "admin.previewRoster": route({
    method: "POST", path: "/api/admin/roster/preview", surface: "admin", body: RosterFilesInput, response: declared<oneroster.OneRosterPreview>(),
  }),
  "admin.applyRoster": route({
    method: "POST", path: "/api/admin/roster/apply", surface: "admin", body: RosterFilesInput,
    response: z.strictObject({ applied: z.boolean(), preview: declared<oneroster.OneRosterPreview>(), grantsRevoked: z.int().nonnegative() }),
  }),
  "admin.getConfig": route({
    method: "GET", path: "/api/admin/config", surface: "admin",
    response: z.strictObject({ head: ConfigurationRevision.optional(), revisions: z.int(), districtPolicy: PolicySettings }),
  }),
  "admin.planConfig": route({ method: "POST", path: "/api/admin/config/plan", surface: "admin", body: ConfigDocumentInput, response: ConfigPlanBody }),
  "admin.applyConfig": route({
    method: "POST", path: "/api/admin/config/apply", surface: "admin",
    body: ConfigDocumentInput.extend({
      /** The head the plan was made against; the apply is refused if another revision landed since. */
      expectedHeadRevisionId: ConfigRevisionId.optional(),
      /** That the administrator reviewed the approvals the plan requires. */
      acknowledgeApprovals: z.boolean().default(false),
    }),
    response: ConfigurationRevision,
  }),
  "admin.aiUsage": route({ method: "GET", path: "/api/admin/ai/usage", surface: "admin", response: declared<UsageReport>() }),
  "admin.termRollover": route({
    method: "GET", path: "/api/admin/terms/:termId/rollover", surface: "admin",
    params: params({ termId: TermId }), response: declared<TermRolloverPreview>(),
  }),
  "admin.closeTerm": route({
    method: "POST", path: "/api/admin/terms/:termId/close", surface: "admin",
    params: params({ termId: TermId }), body: NoBody,
    response: z.strictObject({ retained: z.int(), grantsRevoked: z.int(), fundingCancellations: z.int() }),
  }),
} as const satisfies Record<string, RouteSpec>;

/** The routes. */
export type Routes = typeof ROUTES;
/** A route name. */
export type RouteName = keyof Routes;

type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : undefined;
/** A part the caller may omit when every one of its fields is optional. */
type Part<K extends string, S extends z.ZodType> = {} extends z.input<S> ? { [P in K]?: z.input<S> } : { [P in K]: z.input<S> };

/**
 * What a caller sends to a route: its path parameters, query and body, each as the schema accepts
 * it. A query or body whose fields are all optional may be omitted.
 */
export type RouteInput<N extends RouteName> =
  & (Routes[N] extends { params: infer P extends z.ZodType } ? { params: z.input<P> } : {})
  & (Routes[N] extends { query: infer Q extends z.ZodType } ? Part<"query", Q> : {})
  & (Routes[N] extends { body: infer B extends z.ZodType } ? Part<"body", B> : {});

/** What a route handler receives: the same parts, after parsing. */
export type ParsedRouteInput<N extends RouteName> = {
  [K in "params" | "query" | "body"]: Routes[N] extends Record<K, z.ZodType> ? SchemaOutput<Routes[N][K]> : undefined;
};

/** What a route returns on success. */
export type RouteResponse<N extends RouteName> = z.output<Routes[N]["response"]>;

/** The status a route answers on success. */
export function successStatus(spec: RouteSpec): number {
  return spec.status ?? 200;
}

/** The `:name` segments of a path, in order. */
export function pathParameterNames(path: string): string[] {
  return path.split("/").filter((segment) => segment.startsWith(":")).map((segment) => segment.slice(1));
}

/**
 * The path for a route with its parameters filled in, each encoded as one segment. Throws if a
 * parameter is missing.
 */
export function routePath(path: string, values: Readonly<Record<string, string>> = {}): string {
  return path.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    const value = values[segment.slice(1)];
    if (value === undefined) throw new Error(`missing path parameter ${segment.slice(1)}`);
    return encodeURIComponent(value);
  }).join("/");
}
