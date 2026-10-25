// The district application's HTTP contract: every route's method, path, surface and Zod schemas.
// The server validates requests with these schemas and the typed client (`@schoolos/api-client`)
// is written against the same table, so the two cannot drift.
import { z } from "zod";
import {
  AcademicTerm,
  ActivityDefinitionId,
  ActivityId,
  ArtifactId,
  ArtifactType,
  AssessmentRunId,
  AuthorityMap,
  CatalogCourse,
  CourseId,
  ConfigRevisionId,
  ConfigurationRevision,
  ContentDigest,
  ContentItemId,
  CourseOffering,
  DistrictId,
  Enrollment,
  EnrollmentId,
  OfferingId,
  PolicySettings,
  Principal,
  PrincipalId,
  PrincipalKind,
  RevisionId,
  RoleAssignment,
  School,
  SubmissionId,
  TermId,
  TermState,
  WorkspaceId,
} from "@schoolos/contracts";
import { CourseWorkspace, PersonalWorkspace, PromotionLink, WorkspaceLifecycle, type TermRolloverPreview } from "@schoolos/workspaces";
import {
  AiAssistance,
  Artifact,
  ArtifactRevision,
  RevisionContentInput,
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
  StarterMaterial,
  SubmissionItem,
  SubmissionReceipt,
  SubmissionSnapshot,
  GradebookCsvExport,
  GradebookRow,
  GradebookSettingsInput,
  GradebookView,
  GradeMarkerInput,
  StudentGradeSummary,
} from "@schoolos/assessment";
import { AlignmentInput, type ContentItem, type QueueEntry, type StudioRelease } from "@schoolos/content-studio";
import {
  ActivityContent,
  ActivityDefinition,
  ActivityInstallation,
  ContentTitle,
  CourseModule,
  CourseModuleId,
  CourseOutline,
  CoursePage,
  CoursePageId,
  ModuleItem,
  ModuleItemId,
  ModulePatch,
  NewPage,
  PagePatch,
  TemplateInput,
} from "@schoolos/curriculum";
import {
  DiscussionPost,
  DiscussionPostId,
  DiscussionSettings,
  DiscussionTopic,
  DiscussionTopicId,
  ModerationDecision,
  ModerationQueue,
  NewPost,
  NewTopic,
  PostBody,
  PostReport,
  StudentPostView,
  TopicListing,
  TopicPatch,
} from "@schoolos/discussions";
// Quizzes (SCHO-191)
import {
  ItemGradeInput,
  NewQuiz,
  Quiz,
  QuizAnswer,
  QuizAttemptId,
  QuizId,
  QuizItemId,
  QuizPatch,
  QuizResults,
  QuizSummary,
  ReleaseOutcome,
  StaffAttemptView,
  StudentAttemptResult,
  StudentAttemptView,
  StudentQuizView,
} from "@schoolos/quizzes";
import { CoursePatch, NewCourse, NewEnrollment, NewOffering, NewPrincipal, NewSchool, NewTerm, OfferingPatch, PrincipalPatch, TermPatch } from "@schoolos/academics";
import { EvidenceContract } from "@schoolos/registry";
import { AssessmentReport, IdempotencyKey, RubricDraft, RubricRelease, RunError, RunState } from "@schoolos/assessment-ci";
import { FundingPoolId, UsdNano, type AiCostSummary, type AiFundingReport, type AiProjectionReport, type UsageReport } from "@schoolos/ai-governance";
import type { ConfigProblem, ConfigurationPlan } from "@schoolos/config";
import type { oneroster } from "@schoolos/integrations";
// Guardians (ADR-0012, SCHO-188)
import { GuardianRelationship, GuardianRelationshipId, OpaqueCode, PrincipalStatus } from "@schoolos/contracts";
import { GuardianRelationshipAuditEvent, GuardianRelationshipScope } from "@schoolos/policy";
import { GuardianInvitationId, GuardianInvitationRedemption, IdentityRequestId, NewGuardianInvitation } from "@schoolos/identity-links";
// Communication (SCHO-189). Imported from the model alone, which this browser-safe module can carry.
import {
  Announcement,
  AnnouncementId,
  AnnouncementText,
  AnnouncementTitle,
  EmailPreferences,
  IsoWeek,
  Notification,
  NotificationId,
  WeeklyNote,
} from "./communication/model.ts";
import type { GuardianDigest } from "./communication/digest.ts";

/**
 * Which part of SchoolOS a route belongs to. Student routes answer only student principals,
 * teacher and admin routes only staff, and guardian routes only guardians; within a surface, every
 * decision is still the policy engine's. Onboarding routes answer a verified sign-in that may not
 * be anyone's principal yet, such as a guardian redeeming an invitation, and grant nothing.
 */
export type Surface = "me" | "student" | "teacher" | "admin" | "guardian" | "onboarding";

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

/** The file types a JSON client may upload as bytes. Text files are sent as `text` content instead. */
export const UPLOAD_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
/** An uploadable file type. */
export type UploadMediaType = (typeof UPLOAD_MEDIA_TYPES)[number];

/**
 * The largest file a JSON client may upload, in bytes. Its base64 form, about 6.7 MiB, fits the
 * district app's request body limit with room for the rest of the request.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The bytes each uploadable type starts with, so a file is stored only if it is what it claims to be. */
const UPLOAD_SIGNATURES: Record<UploadMediaType, readonly number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

/**
 * An uploaded file as a JSON client sends it: an allowed media type and its bytes as base64. It
 * parses to the `bytes` content the artifact service stores in R2, refusing a file over
 * {@link MAX_UPLOAD_BYTES} or one whose leading bytes do not match its media type.
 */
export const UploadedFileContent = z.strictObject({
  kind: z.literal("bytes"),
  mediaType: z.enum(UPLOAD_MEDIA_TYPES),
  base64: z.base64().min(1).max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4),
}).transform(({ mediaType, base64 }, ctx) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    ctx.addIssue({ code: "too_big", origin: "file", maximum: MAX_UPLOAD_BYTES, inclusive: true, path: ["base64"], message: "the file is too large" });
    return z.NEVER;
  }
  if (!UPLOAD_SIGNATURES[mediaType].every((byte, i) => bytes[i] === byte)) {
    ctx.addIssue({ code: "custom", path: ["base64"], message: "the file's contents do not match its media type" });
    return z.NEVER;
  }
  return { kind: "bytes" as const, mediaType, bytes };
});

/**
 * Artifact content a JSON client can send: text, an uploaded file (see {@link UploadedFileContent}),
 * or a link to an approved external document.
 */
export const JsonRevisionContent = z.discriminatedUnion("kind", [RevisionContentInput.options[0], UploadedFileContent, RevisionContentInput.options[2]]);
/** JSON artifact content, as a client sends it. */
export type JsonRevisionContent = z.input<typeof JsonRevisionContent>;

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

/**
 * A change to an assignment's settings while it is open. An omitted field is unchanged. Its rubric
 * and permitted artifact types are fixed by the activity it was installed from.
 */
export const AssignmentUpdateInput = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  /** Stored in UTC. */
  dueAt: z.iso.datetime({ offset: true }).optional(),
  latePolicy: LatePolicy.optional(),
  attemptsAllowed: z.int().min(1).max(100).optional(),
  feedbackVisibility: FeedbackVisibility.optional(),
}).refine((patch) => Object.keys(patch).length > 0, "change at least one setting");
/** An assignment update. */
export type AssignmentUpdateInput = z.input<typeof AssignmentUpdateInput>;

/**
 * Starter material as the API returns it: everything but where its content is stored, which is
 * read through the starter material route.
 */
export const StarterMaterialBody = StarterMaterial.omit({ content: true });
/** Starter material in a response. */
export type StarterMaterialBody = z.infer<typeof StarterMaterialBody>;

/** An assignment with the starter material published to it. */
export const AssignmentViewBody = z.strictObject({ assignment: AssignmentBinding, starterMaterials: z.array(StarterMaterialBody) });
/** An assignment view. */
export type AssignmentViewBody = z.infer<typeof AssignmentViewBody>;

/** A class in the district, as its administrators see it: who teaches it and how many it reaches. */
export const AdminOfferingBody = z.strictObject({
  offering: CourseOffering,
  course: CatalogCourse,
  /** The display names of its actively enrolled teachers and co-teachers. */
  teachers: z.array(z.string()),
  /** Students actively enrolled. */
  students: z.int().nonnegative(),
});
/** An administrator's class row. */
export type AdminOfferingBody = z.infer<typeof AdminOfferingBody>;

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

/**
 * One revision of the district's funding pool allocations: every pool's monthly allocation after
 * the change, who made it and when. Revisions are append-only (see `FundingAllocationStore`).
 */
export const FundingAllocationRevision = z.strictObject({
  id: z.string().regex(/^far_[a-z0-9-]{1,64}$/),
  /** 1 for the district's first revision. */
  number: z.int().positive(),
  /** Each pool's monthly allocation, by pool ID. */
  allocations: z.record(FundingPoolId, UsdNano),
  actorPrincipalId: PrincipalId,
  appliedAt: z.iso.datetime(),
  previousRevisionId: z.string().optional(),
});
/** A funding allocation revision. */
export type FundingAllocationRevision = z.infer<typeof FundingAllocationRevision>;

/** The most one pool may be allocated a month, in cents: $1,000,000. */
export const MAX_POOL_ALLOCATION_CENTS = 100_000_000;

/** Where the district's funding stands this month, and the allocation revision in force. */
export const AiFundingBody = z.strictObject({
  report: declared<AiFundingReport>(),
  /** The allocation revision in force; absent while the deployment's configured allocations apply. */
  revision: FundingAllocationRevision.optional(),
});
/** The funding report. */
export type AiFundingBody = z.infer<typeof AiFundingBody>;


// Course authoring (SCHO-186): local directory records, modules and pages, Common Cartridge.

/**
 * A principal as the authoring screens list them: who they are, never their sign-in identities,
 * and whether they are a district administrator now (SCHO-212).
 */
export const AuthoringPrincipalBody = Principal.pick({ id: true, kind: true, status: true, displayName: true, email: true })
  .extend({ districtAdmin: z.boolean() });
/** An authoring principal. */
export type AuthoringPrincipalBody = z.infer<typeof AuthoringPrincipalBody>;

/**
 * The directory as an administrator authors it: which system owns each record type, and the
 * records they may read. Writes to a type another system owns are refused, naming the owner.
 */
export const AuthoringDirectoryBody = z.strictObject({
  authority: AuthorityMap,
  /** The sign-in issuers the district trusts: a local principal's identity must come from one. */
  trustedIssuers: z.array(z.string()),
  schools: z.array(School),
  terms: z.array(AcademicTerm),
  courses: z.array(CatalogCourse),
  offerings: z.array(CourseOffering),
  principals: z.array(AuthoringPrincipalBody),
});
/** The authoring directory. */
export type AuthoringDirectoryBody = z.infer<typeof AuthoringDirectoryBody>;

/** An offering's course content as one reader may see it: staff in full, students published modules only. */
export const CourseOutlineBody = z.strictObject({ view: z.enum(["teacher", "student"]), outline: CourseOutline });
/** A course outline view. */
export type CourseOutlineBody = z.infer<typeof CourseOutlineBody>;

/** The largest Common Cartridge a teacher may upload, in bytes: it travels as base64 inside the JSON body. */
export const MAX_CARTRIDGE_UPLOAD_BYTES = 5 * 1024 * 1024;

/** An uploaded `.imscc` package. */
export const CartridgeUploadInput = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  /** The package bytes, base64-encoded. */
  base64: z.base64().max(Math.ceil(MAX_CARTRIDGE_UPLOAD_BYTES / 3) * 4),
});
/** A cartridge upload. */
export type CartridgeUploadInput = z.infer<typeof CartridgeUploadInput>;

/** What importing a cartridge would add: modules of pages and links, and what it would leave behind. Nothing is stored. */
export const CartridgePreviewBody = z.strictObject({
  packageDigest: z.string(),
  title: z.string(),
  modules: z.array(z.strictObject({
    title: z.string(),
    items: z.array(z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("page"), title: z.string(), characters: z.int().nonnegative() }),
      z.strictObject({ kind: z.literal("link"), title: z.string(), url: z.string() }),
    ])),
    /** The discussion topics that would be opened in the module, drafts with it (SCHO-190). */
    discussions: z.array(z.strictObject({ title: z.string(), characters: z.int().nonnegative() })).optional(),
    /** The quizzes, from QTI assessments, that would be added to the module as drafts (SCHO-191). */
    quizzes: z.array(z.strictObject({ title: z.string(), questions: z.int().nonnegative() })).optional(),
  })),
  /** Placements not carried, with why: tools, refused links, other resource types, unacceptable text. */
  skipped: z.array(z.strictObject({ identifier: z.string(), reason: z.string(), type: z.string().optional() })),
  /** Nested modules whose items were flattened into their top-level module. */
  flattened: z.array(z.string()),
  /** Pages cut to the page length limit. */
  truncated: z.array(z.string()),
});
/** A cartridge preview. */
export type CartridgePreviewBody = z.infer<typeof CartridgePreviewBody>;

/** A course exported as a Common Cartridge 1.3 package, and what it could not carry. */
export const CartridgeExportBody = z.strictObject({
  fileName: z.string(),
  base64: z.string(),
  /** Items a cartridge cannot carry, such as SchoolOS activities, by module and item. */
  losses: z.array(z.strictObject({ kind: z.enum(["activity", "quiz"]), module: z.string(), item: z.string() })),
});
/** A cartridge export. */
export type CartridgeExportBody = z.infer<typeof CartridgeExportBody>;
// Guardians (ADR-0012, SCHO-188): shapes

/** One of a guardian's children, through a relationship in force. */
export const GuardianChildBody = z.strictObject({ studentPrincipalId: PrincipalId, displayName: z.string() });
/** A guardian's child. */
export type GuardianChildBody = z.infer<typeof GuardianChildBody>;

/** One of a child's classes, as their guardian may see it, with its term (a completed term's class is past). */
export const GuardianOfferingBody = z.strictObject({ offering: CourseOffering, course: CatalogCourse, term: AcademicTerm });
/** A child's class. */
export type GuardianOfferingBody = z.infer<typeof GuardianOfferingBody>;

/**
 * One assignment in a child's class, with what the child has been given on it: the feedback
 * released to the child, as the child sees it, and their official grades. Never the submission.
 */
export const GuardianAssignmentBody = z.strictObject({
  assignment: z.strictObject({ id: AssignmentId, offeringId: OfferingId, title: z.string(), dueAt: z.string() }),
  feedback: z.array(FeedbackRecord),
  grades: z.array(OfficialGradeVersion),
});
/** A child's assignment. */
export type GuardianAssignmentBody = z.infer<typeof GuardianAssignmentBody>;

/** A child's class with its assignments. */
export const GuardianCourseBody = GuardianOfferingBody.extend({ assignments: z.array(GuardianAssignmentBody) });
/** A child's class in full. */
export type GuardianCourseBody = z.infer<typeof GuardianCourseBody>;

/** A guardian invitation as an administrator reviews it: never its token. */
export const GuardianInvitationBody = z.strictObject({
  id: GuardianInvitationId,
  districtId: DistrictId,
  studentPrincipalId: PrincipalId,
  relationshipId: GuardianRelationshipId,
  reservedGuardianPrincipalId: PrincipalId,
  guardianDisplayName: z.string(),
  created: z.strictObject({ by: PrincipalId, at: z.string() }),
  expiresAt: z.string(),
  redeemed: GuardianInvitationRedemption.optional(),
});
/** A guardian invitation. */
export type GuardianInvitationBody = z.infer<typeof GuardianInvitationBody>;

/** A student's guardians, invitations and waiting sign-ins, for a district administrator. */
export const StudentGuardiansBody = z.strictObject({
  student: z.strictObject({ principalId: PrincipalId, displayName: z.string() }),
  relationships: z.array(z.strictObject({
    relationship: GuardianRelationship,
    /** The guardian's name, once their sign-in has been approved. */
    guardianDisplayName: z.string().optional(),
    /** Whether the guardian's principal exists and is active, which confirming needs. */
    guardianActive: z.boolean(),
    history: z.array(GuardianRelationshipAuditEvent),
  })),
  invitations: z.array(GuardianInvitationBody),
  /** Redeemed invitations' sign-ins awaiting a district admin's approval. */
  pendingSignIns: z.array(z.strictObject({ requestId: IdentityRequestId, invitationId: GuardianInvitationId, guardianDisplayName: z.string() })),
});
/** A student's guardians. */
export type StudentGuardiansBody = z.infer<typeof StudentGuardiansBody>;

// Communication (SCHO-189): announcements, weekly notes, calendar, notifications, email preferences,
// and the family digest preview.

/** An announcement with the course it was posted to, and whether students can see it yet. */
export const AnnouncementBody = z.strictObject({ announcement: Announcement, courseLabel: z.string(), published: z.boolean() });
/** An announcement in a response. */
export type AnnouncementBody = z.infer<typeof AnnouncementBody>;

/** A new announcement. Without `publishAt` it is published at once; a time in the past means now. */
export const AnnouncementInput = z.strictObject({
  title: AnnouncementTitle,
  body: AnnouncementText,
  publishAt: z.iso.datetime({ offset: true }).optional(),
});

/** A change to an announcement. `publishAt` reschedules one that is not yet published. */
export const AnnouncementPatchInput = z.strictObject({
  title: AnnouncementTitle.optional(),
  body: AnnouncementText.optional(),
  publishAt: z.iso.datetime({ offset: true }).optional(),
}).refine((patch) => Object.keys(patch).length > 0, "change at least one field");

/** An offering's weekly note to families for one week; `note` is null when there is none. */
export const WeeklyNoteBody = z.strictObject({ week: IsoWeek, note: WeeklyNote.nullable() });
/** A weekly note in a response. */
export type WeeklyNoteBody = z.infer<typeof WeeklyNoteBody>;

/** One calendar event. Term dates are all-day `YYYY-MM-DD`; everything else is a UTC timestamp. */
export const CalendarEventBody = z.strictObject({
  uid: z.string(),
  kind: z.enum(["assignment-due", "announcement", "term-start", "term-end"]),
  title: z.string(),
  start: z.string(),
  allDay: z.boolean(),
  offeringId: OfferingId.optional(),
  assignmentId: AssignmentId.optional(),
  announcementId: AnnouncementId.optional(),
});
/** A calendar event. */
export type CalendarEventBody = z.infer<typeof CalendarEventBody>;

/** A principal's calendar feed, without its token, which is shown only when it is made. */
export const CalendarFeedBody = z.strictObject({ active: z.boolean(), createdAt: z.iso.datetime().optional() });

/** The path a calendar feed token is subscribed at. The token is its only authority. */
export const calendarFeedPath = (token: string): `/api/calendar/${string}.ics` => `/api/calendar/${token}.ics`;

/** The principal's email preferences, whether the district has an address for them, and whether it sends email at all. */
export const PreferencesBody = z.strictObject({ email: EmailPreferences, hasEmailAddress: z.boolean(), emailEnabled: z.boolean() });
/** Email preferences in a response. */
export type PreferencesBody = z.infer<typeof PreferencesBody>;

/** A guardian's digest for the coming week, as it would be emailed. */
export const DigestPreviewBody = z.strictObject({
  digest: declared<GuardianDigest>(),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  /** Whether the weekly job would skip it for having nothing to say. */
  empty: z.boolean(),
});
/** A digest preview. */
export type DigestPreviewBody = z.infer<typeof DigestPreviewBody>;


// Discussions (SCHO-190): topics, threaded posts and their moderation.

/** The display name of each author a thread names, so a reader sees who wrote what. */
export const DiscussionAuthorsBody = z.array(z.strictObject({ principalId: PrincipalId, displayName: z.string() }));
/** Discussion authors. */
export type DiscussionAuthorsBody = z.infer<typeof DiscussionAuthorsBody>;

/** A topic and its posts as a student reads them, with their authors' names. */
export const StudentThreadBody = z.strictObject({ topic: DiscussionTopic, posts: z.array(StudentPostView), authors: DiscussionAuthorsBody });
/** A student thread. */
export type StudentThreadBody = z.infer<typeof StudentThreadBody>;

/** A topic and every post in it as its staff read them, flags and moderation status included, with their authors' names. */
export const StaffThreadBody = z.strictObject({ topic: DiscussionTopic, posts: z.array(DiscussionPost), authors: DiscussionAuthorsBody });
/** A staff thread. */
export type StaffThreadBody = z.infer<typeof StaffThreadBody>;

/** A teacher's moderation queue, with the names of the authors it lists. */
export const ModerationQueueBody = ModerationQueue.extend({ authors: DiscussionAuthorsBody });
/** A moderation queue body. */
export type ModerationQueueBody = z.infer<typeof ModerationQueueBody>;

/** One student's posts in the topics graded under an assignment, for the teacher grading it. */
export const DiscussionParticipationBody = z.strictObject({ topics: z.array(DiscussionTopic), posts: z.array(DiscussionPost) });
/** Discussion participation. */
export type DiscussionParticipationBody = z.infer<typeof DiscussionParticipationBody>;


// Quizzes (SCHO-191): quizzes, attempts on the server's clock, grading and score release.

/** An offering's quizzes as its staff see them. */
export const StaffQuizListingBody = z.strictObject({ canManage: z.boolean(), quizzes: z.array(QuizSummary) });
/** A staff quiz listing. */
export type StaffQuizListingBody = z.infer<typeof StaffQuizListingBody>;

/** Answers a student saves or submits; each replaces any earlier answer to the same question. */
export const QuizAnswersInput = z.strictObject({ answers: z.array(QuizAnswer).max(500) });
/** Quiz answers. */
export type QuizAnswersInput = z.infer<typeof QuizAnswersInput>;

/** What saving answers did, with the server's clock so the student's timer stays honest. */
export const QuizSaveBody = z.strictObject({ savedAt: z.string(), deadline: z.string().optional(), serverNow: z.string() });
/** A quiz save. */
export type QuizSaveBody = z.infer<typeof QuizSaveBody>;

/** The display name of each student a quiz's results name. */
export const QuizStudentsBody = z.array(z.strictObject({ principalId: PrincipalId, displayName: z.string() }));

/** A quiz's results, with its students' names. */
export const QuizResultsBody = QuizResults.extend({ names: QuizStudentsBody });
/** Quiz results. */
export type QuizResultsBody = z.infer<typeof QuizResultsBody>;

/** A student's attempt as staff grade it, with the student's name. */
export const StaffAttemptBody = StaffAttemptView.extend({ studentName: z.string() });
/** A staff attempt. */
export type StaffAttemptBody = z.infer<typeof StaffAttemptBody>;

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
  "student.getAssignment": route({
    method: "GET", path: "/api/student/assignments/:assignmentId", surface: "student",
    params: params({ assignmentId: AssignmentId }), response: AssignmentViewBody,
  }),
  "student.readStarterMaterial": route({
    method: "GET", path: "/api/student/assignments/:assignmentId/starter-materials/:materialId", surface: "student",
    params: params({ assignmentId: AssignmentId, materialId: ArtifactId }),
    response: z.strictObject({ material: StarterMaterialBody, content: RevisionContentBody }),
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
  "student.withdrawSubmission": route({
    method: "POST", path: "/api/student/submissions/:submissionId/withdraw", surface: "student",
    params: params({ submissionId: SubmissionId }), body: NoBody, response: SubmissionSnapshot,
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
  "teacher.getAssignment": route({
    method: "GET", path: "/api/teacher/assignments/:assignmentId", surface: "teacher",
    params: params({ assignmentId: AssignmentId }), response: AssignmentViewBody,
  }),
  "teacher.updateAssignment": route({
    method: "POST", path: "/api/teacher/assignments/:assignmentId", surface: "teacher",
    params: params({ assignmentId: AssignmentId }), body: AssignmentUpdateInput, response: AssignmentBinding,
  }),
  "teacher.publishStarterMaterial": route({
    method: "POST", path: "/api/teacher/assignments/:assignmentId/starter-materials", surface: "teacher", status: 201,
    params: params({ assignmentId: AssignmentId }),
    body: z.strictObject({ title: z.string().trim().min(1).max(200), content: JsonRevisionContent }),
    response: StarterMaterialBody,
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
  "teacher.declineGradeProposal": route({
    method: "POST", path: "/api/teacher/grade-proposals/:proposalId/decline", surface: "teacher",
    params: params({ proposalId: GradeProposalId }), body: z.strictObject({ reason: z.string().trim().min(1).max(1000) }), response: GradeProposal,
  }),

  // Admin
  "admin.health": route({ method: "GET", path: "/api/admin/health", surface: "admin", response: DistrictHealthBody }),
  "admin.listOfferings": route({ method: "GET", path: "/api/admin/offerings", surface: "admin", response: z.array(AdminOfferingBody) }),
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
  "admin.aiFunding": route({ method: "GET", path: "/api/admin/ai/funding", surface: "admin", response: AiFundingBody }),
  "admin.aiCostSummary": route({ method: "GET", path: "/api/admin/ai/cost-summary", surface: "admin", response: declared<AiCostSummary>() }),
  "admin.aiProjection": route({ method: "GET", path: "/api/admin/ai/projection", surface: "admin", response: declared<AiProjectionReport>() }),
  "admin.updateFundingPools": route({
    method: "POST", path: "/api/admin/ai/funding", surface: "admin",
    body: z.strictObject({
      /** The pools to change. A pool not listed keeps its allocation. */
      allocations: z.array(z.strictObject({
        poolId: FundingPoolId,
        monthlyAllocationCents: z.int().nonnegative().max(MAX_POOL_ALLOCATION_CENTS),
      })).min(1).max(100),
      /** The revision the administrator reviewed; the change is refused if another landed since. */
      expectedRevisionId: z.string().optional(),
    }),
    response: AiFundingBody.extend({
      /** Whether a new revision was recorded; false when nothing changed. */
      changed: z.boolean(),
      /** Advisories the change was accepted with, such as a safety reserve below its recommendation. */
      warnings: z.array(z.string()),
    }),
  }),
  "admin.termRollover": route({
    method: "GET", path: "/api/admin/terms/:termId/rollover", surface: "admin",
    params: params({ termId: TermId }), response: declared<TermRolloverPreview>(),
  }),
  "admin.closeTerm": route({
    method: "POST", path: "/api/admin/terms/:termId/close", surface: "admin",
    params: params({ termId: TermId }), body: NoBody,
    response: z.strictObject({ retained: z.int(), grantsRevoked: z.int(), fundingCancellations: z.int() }),
  }),

  // Course authoring (SCHO-186). Kept in one block, apart from the routes above.
  "student.listModules": route({
    method: "GET", path: "/api/student/offerings/:offeringId/modules", surface: "student",
    params: params({ offeringId: OfferingId }), response: CourseOutlineBody,
  }),
  "teacher.listModules": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/modules", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: CourseOutlineBody,
  }),
  "teacher.createModule": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: z.strictObject({ title: ContentTitle }), response: CourseModule,
  }),
  "teacher.updateModule": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId", surface: "teacher",
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId }), body: ModulePatch, response: CourseModule,
  }),
  "teacher.deleteModule": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId/delete", surface: "teacher",
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "teacher.reorderModules": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/module-order", surface: "teacher",
    params: params({ offeringId: OfferingId }), body: z.strictObject({ moduleIds: z.array(CourseModuleId).max(100) }), response: CourseOutline,
  }),
  "teacher.addPage": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId/pages", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId }), body: NewPage,
    response: z.strictObject({ page: CoursePage, item: ModuleItem }),
  }),
  "teacher.updatePage": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/pages/:pageId", surface: "teacher",
    params: params({ offeringId: OfferingId, pageId: CoursePageId }), body: PagePatch, response: CoursePage,
  }),
  "teacher.placeActivity": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId/activities", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId }), body: z.strictObject({ activityId: ActivityId }), response: ModuleItem,
  }),
  "teacher.removeModuleItem": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId/items/:itemId/remove", surface: "teacher",
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId, itemId: ModuleItemId }), body: NoBody,
    response: z.strictObject({ removed: z.literal(true) }),
  }),
  "teacher.reorderModuleItems": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/modules/:moduleId/item-order", surface: "teacher",
    params: params({ offeringId: OfferingId, moduleId: CourseModuleId }), body: z.strictObject({ itemIds: z.array(ModuleItemId).max(100) }),
    response: CourseModule,
  }),
  "teacher.previewCartridge": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/cartridge/preview", surface: "teacher",
    params: params({ offeringId: OfferingId }), body: CartridgeUploadInput, response: CartridgePreviewBody,
  }),
  "teacher.importCartridge": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/cartridge/import", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }),
    body: CartridgeUploadInput.extend({
      /** The digest the preview reported; the import is refused if the package is not the one previewed. */
      packageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
    response: z.strictObject({
      modules: z.array(CourseModule),
      /** The discussion topics opened in the imported modules (SCHO-190). */
      topics: z.array(DiscussionTopic).optional(),
      /** The draft quizzes added to the imported modules, from their QTI assessments (SCHO-191). */
      quizzes: z.array(Quiz).optional(),
      preview: CartridgePreviewBody,
    }),
  }),
  "teacher.exportCartridge": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/cartridge/export", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: CartridgeExportBody,
  }),
  "admin.authoring": route({ method: "GET", path: "/api/admin/authoring", surface: "admin", response: AuthoringDirectoryBody }),
  "admin.createSchool": route({ method: "POST", path: "/api/admin/schools", surface: "admin", status: 201, body: NewSchool, response: School }),
  "admin.createTerm": route({ method: "POST", path: "/api/admin/terms", surface: "admin", status: 201, body: NewTerm, response: AcademicTerm }),
  "admin.updateTerm": route({
    method: "POST", path: "/api/admin/terms/:termId", surface: "admin", params: params({ termId: TermId }), body: TermPatch, response: AcademicTerm,
  }),
  "admin.transitionTerm": route({
    method: "POST", path: "/api/admin/terms/:termId/transition", surface: "admin",
    params: params({ termId: TermId }), body: z.strictObject({ to: TermState }), response: AcademicTerm,
  }),
  "admin.createCourse": route({ method: "POST", path: "/api/admin/courses", surface: "admin", status: 201, body: NewCourse, response: CatalogCourse }),
  "admin.updateCourse": route({
    method: "POST", path: "/api/admin/courses/:courseId", surface: "admin", params: params({ courseId: CourseId }), body: CoursePatch, response: CatalogCourse,
  }),
  "admin.archiveCourse": route({
    method: "POST", path: "/api/admin/courses/:courseId/archived", surface: "admin",
    params: params({ courseId: CourseId }), body: z.strictObject({ archived: z.boolean() }), response: CatalogCourse,
  }),
  "admin.createOffering": route({ method: "POST", path: "/api/admin/offerings", surface: "admin", status: 201, body: NewOffering, response: CourseOffering }),
  "admin.updateOffering": route({
    method: "POST", path: "/api/admin/offerings/:offeringId", surface: "admin",
    params: params({ offeringId: OfferingId }), body: OfferingPatch, response: CourseOffering,
  }),
  "admin.archiveOffering": route({
    method: "POST", path: "/api/admin/offerings/:offeringId/archived", surface: "admin",
    params: params({ offeringId: OfferingId }), body: z.strictObject({ archived: z.boolean() }), response: CourseOffering,
  }),
  "admin.offeringRoster": route({
    method: "GET", path: "/api/admin/offerings/:offeringId/roster", surface: "admin",
    params: params({ offeringId: OfferingId }), response: z.array(RosterEntryBody),
  }),
  "admin.enroll": route({
    method: "POST", path: "/api/admin/offerings/:offeringId/enrollments", surface: "admin", status: 201,
    params: params({ offeringId: OfferingId }), body: NewEnrollment.omit({ offeringId: true }), response: Enrollment,
  }),
  "admin.unenroll": route({
    method: "POST", path: "/api/admin/enrollments/:enrollmentId/deactivate", surface: "admin",
    params: params({ enrollmentId: EnrollmentId }), body: NoBody,
    response: z.strictObject({ enrollment: Enrollment, grantsRevoked: z.int().nonnegative() }),
  }),
  "admin.createPrincipal": route({
    method: "POST", path: "/api/admin/principals", surface: "admin", status: 201, body: NewPrincipal, response: AuthoringPrincipalBody,
  }),
  // Managing people (SCHO-212). Each returns the person as the authoring screens list them.
  "admin.updatePrincipal": route({
    method: "POST", path: "/api/admin/principals/:principalId", surface: "admin",
    params: params({ principalId: PrincipalId }), body: PrincipalPatch, response: AuthoringPrincipalBody,
  }),
  "admin.setPrincipalStatus": route({
    method: "POST", path: "/api/admin/principals/:principalId/status", surface: "admin",
    params: params({ principalId: PrincipalId }), body: z.strictObject({ status: PrincipalStatus }),
    response: z.strictObject({ principal: AuthoringPrincipalBody, grantsRevoked: z.int().nonnegative() }),
  }),
  "admin.grantDistrictAdmin": route({
    method: "POST", path: "/api/admin/principals/:principalId/district-admin", surface: "admin",
    params: params({ principalId: PrincipalId }), body: NoBody, response: AuthoringPrincipalBody,
  }),
  "admin.revokeDistrictAdmin": route({
    method: "POST", path: "/api/admin/principals/:principalId/district-admin/revoke", surface: "admin",
    params: params({ principalId: PrincipalId }), body: NoBody, response: AuthoringPrincipalBody,
  }),
  // Guardians (ADR-0012, SCHO-188). Guardian routes are read-only; every read is decided by the
  // policy engine with the guardian as subject, and built from the child's own view.
  "guardian.listChildren": route({ method: "GET", path: "/api/guardian/children", surface: "guardian", response: z.array(GuardianChildBody) }),
  "guardian.childOfferings": route({
    method: "GET", path: "/api/guardian/children/:studentId/offerings", surface: "guardian",
    params: params({ studentId: PrincipalId }), response: z.array(GuardianOfferingBody),
  }),
  "guardian.childCourse": route({
    method: "GET", path: "/api/guardian/children/:studentId/offerings/:offeringId", surface: "guardian",
    params: params({ studentId: PrincipalId, offeringId: OfferingId }), response: GuardianCourseBody,
  }),
  "onboarding.redeemGuardianInvitation": route({
    method: "POST", path: "/api/onboarding/guardian-invitations/redeem", surface: "onboarding",
    body: z.strictObject({ token: z.string().min(1).max(100) }),
    response: z.strictObject({ outcome: GuardianInvitationRedemption.shape.outcome }),
  }),
  "admin.guardianStudents": route({
    method: "GET", path: "/api/admin/guardians/students", surface: "admin",
    response: z.array(z.strictObject({ principalId: PrincipalId, displayName: z.string(), status: PrincipalStatus })),
  }),
  "admin.studentGuardians": route({
    method: "GET", path: "/api/admin/students/:studentId/guardians", surface: "admin",
    params: params({ studentId: PrincipalId }), response: StudentGuardiansBody,
  }),
  "admin.inviteGuardian": route({
    method: "POST", path: "/api/admin/students/:studentId/guardians/invitations", surface: "admin", status: 201,
    params: params({ studentId: PrincipalId }), body: NewGuardianInvitation.omit({ studentPrincipalId: true }),
    response: z.strictObject({
      invitation: GuardianInvitationBody,
      relationship: GuardianRelationship,
      /** The single-use link to hand the guardian. It is shown once and never stored. */
      invitationUrl: z.string(),
      /**
       * How the link reaches the guardian: `share-link`, the administrator hands it over. Email
       * delivery (L5) will add a value.
       */
      delivery: z.literal("share-link"),
    }),
  }),
  "admin.confirmGuardian": route({
    method: "POST", path: "/api/admin/guardian-relationships/:relationshipId/confirm", surface: "admin",
    params: params({ relationshipId: GuardianRelationshipId }), body: NoBody, response: GuardianRelationship,
  }),
  "admin.updateGuardianScope": route({
    method: "POST", path: "/api/admin/guardian-relationships/:relationshipId/scope", surface: "admin",
    params: params({ relationshipId: GuardianRelationshipId }), body: GuardianRelationshipScope, response: GuardianRelationship,
  }),
  "admin.suspendGuardian": route({
    method: "POST", path: "/api/admin/guardian-relationships/:relationshipId/suspend", surface: "admin",
    params: params({ relationshipId: GuardianRelationshipId }), body: z.strictObject({ reason: OpaqueCode }), response: GuardianRelationship,
  }),
  "admin.resumeGuardian": route({
    method: "POST", path: "/api/admin/guardian-relationships/:relationshipId/resume", surface: "admin",
    params: params({ relationshipId: GuardianRelationshipId }), body: NoBody, response: GuardianRelationship,
  }),
  "admin.revokeGuardian": route({
    method: "POST", path: "/api/admin/guardian-relationships/:relationshipId/revoke", surface: "admin",
    params: params({ relationshipId: GuardianRelationshipId }), body: NoBody, response: GuardianRelationship,
  }),
  "admin.approveIdentityRequest": route({
    method: "POST", path: "/api/admin/identity-requests/:requestId/approve", surface: "admin",
    params: params({ requestId: IdentityRequestId }), body: NoBody,
    response: z.strictObject({ requestId: IdentityRequestId, status: z.enum(["approved", "rejected"]) }),
  }),
  "admin.rejectIdentityRequest": route({
    method: "POST", path: "/api/admin/identity-requests/:requestId/reject", surface: "admin",
    params: params({ requestId: IdentityRequestId }), body: NoBody,
    response: z.strictObject({ requestId: IdentityRequestId, status: z.enum(["approved", "rejected"]) }),
  }),
  // End guardians.

  // Gradebook (SCHO-187). Kept in one block, apart from the routes above.
  "teacher.gradebook": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/gradebook", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: GradebookView,
  }),
  "teacher.updateGradebookSettings": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/gradebook/settings", surface: "teacher",
    params: params({ offeringId: OfferingId }), body: GradebookSettingsInput, response: GradebookView,
  }),
  "teacher.setGradeMarker": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/gradebook/markers", surface: "teacher",
    params: params({ offeringId: OfferingId }), body: GradeMarkerInput, response: GradebookRow,
  }),
  /** The grid as CSV text, in a JSON envelope like every other route. */
  "teacher.exportGradebookCsv": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/gradebook/export", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: GradebookCsvExport,
  }),
  "student.gradeSummary": route({
    method: "GET", path: "/api/student/offerings/:offeringId/grade-summary", surface: "student",
    params: params({ offeringId: OfferingId }), response: StudentGradeSummary,
  }),

  // Communication (SCHO-189). Kept in one block, apart from the routes above.
  "student.announcements": route({
    method: "GET", path: "/api/student/announcements", surface: "student", response: z.array(AnnouncementBody),
  }),
  "student.courseAnnouncements": route({
    method: "GET", path: "/api/student/offerings/:offeringId/announcements", surface: "student",
    params: params({ offeringId: OfferingId }), response: z.array(AnnouncementBody),
  }),
  "teacher.listAnnouncements": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/announcements", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: z.array(AnnouncementBody),
  }),
  "teacher.createAnnouncement": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/announcements", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: AnnouncementInput, response: AnnouncementBody,
  }),
  "teacher.updateAnnouncement": route({
    method: "POST", path: "/api/teacher/announcements/:announcementId", surface: "teacher",
    params: params({ announcementId: AnnouncementId }), body: AnnouncementPatchInput, response: AnnouncementBody,
  }),
  "teacher.deleteAnnouncement": route({
    method: "POST", path: "/api/teacher/announcements/:announcementId/delete", surface: "teacher",
    params: params({ announcementId: AnnouncementId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "teacher.weeklyNote": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/weekly-note", surface: "teacher",
    params: params({ offeringId: OfferingId }),
    /** Defaults to the week the next family digest covers. */
    query: z.strictObject({ week: IsoWeek.optional() }),
    response: WeeklyNoteBody,
  }),
  "teacher.setWeeklyNote": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/weekly-note", surface: "teacher",
    params: params({ offeringId: OfferingId }),
    /** Empty text removes the note. `week` defaults to the week the next family digest covers. */
    body: z.strictObject({ week: IsoWeek.optional(), text: z.string().max(2_000) }),
    response: WeeklyNoteBody,
  }),
  "me.calendar": route({
    method: "GET", path: "/api/me/calendar", surface: "me",
    /** Defaults to the week before now through eight weeks after. */
    query: z.strictObject({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }),
    response: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), events: z.array(CalendarEventBody) }),
  }),
  "me.calendarFeed": route({ method: "GET", path: "/api/me/calendar-feed", surface: "me", response: CalendarFeedBody }),
  "me.rotateCalendarFeed": route({
    method: "POST", path: "/api/me/calendar-feed/rotate", surface: "me", body: NoBody,
    /** The token and its path, shown this once. Any earlier feed URL stops working. */
    response: z.strictObject({ token: z.string(), path: z.string(), createdAt: z.iso.datetime() }),
  }),
  "me.revokeCalendarFeed": route({
    method: "POST", path: "/api/me/calendar-feed/revoke", surface: "me", body: NoBody, response: CalendarFeedBody,
  }),
  "me.notifications": route({
    method: "GET", path: "/api/me/notifications", surface: "me",
    response: z.strictObject({ notifications: z.array(Notification), unread: z.int().nonnegative() }),
  }),
  "me.markNotificationsRead": route({
    method: "POST", path: "/api/me/notifications/read", surface: "me",
    body: z.strictObject({ ids: z.array(NotificationId).max(200).optional(), all: z.boolean().optional() })
      .refine((body) => body.all === true || (body.ids?.length ?? 0) > 0, "name notifications or set all"),
    response: z.strictObject({ unread: z.int().nonnegative() }),
  }),
  "me.preferences": route({ method: "GET", path: "/api/me/preferences", surface: "me", response: PreferencesBody }),
  "me.updatePreferences": route({
    method: "POST", path: "/api/me/preferences", surface: "me",
    body: z.strictObject({ email: EmailPreferences.partial() }).refine((body) => Object.keys(body.email).length > 0, "change at least one preference"),
    response: PreferencesBody,
  }),
  "admin.previewDigest": route({
    method: "GET", path: "/api/admin/guardians/:guardianPrincipalId/digest-preview", surface: "admin",
    params: params({ guardianPrincipalId: PrincipalId }), response: DigestPreviewBody,
  }),

  // Discussions (SCHO-190). Kept in one block, apart from the routes above.
  "student.listDiscussions": route({
    method: "GET", path: "/api/student/offerings/:offeringId/discussions", surface: "student",
    params: params({ offeringId: OfferingId }), response: TopicListing,
  }),
  "student.discussionThread": route({
    method: "GET", path: "/api/student/offerings/:offeringId/discussions/:topicId", surface: "student",
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), response: StudentThreadBody,
  }),
  "student.createPost": route({
    method: "POST", path: "/api/student/offerings/:offeringId/discussions/:topicId/posts", surface: "student", status: 201,
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), body: NewPost, response: StudentPostView,
  }),
  "student.editPost": route({
    method: "POST", path: "/api/student/offerings/:offeringId/posts/:postId", surface: "student",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: z.strictObject({ body: PostBody }), response: StudentPostView,
  }),
  "student.deletePost": route({
    method: "POST", path: "/api/student/offerings/:offeringId/posts/:postId/delete", surface: "student",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "student.reportPost": route({
    method: "POST", path: "/api/student/offerings/:offeringId/posts/:postId/report", surface: "student",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: PostReport, response: z.strictObject({ reported: z.literal(true) }),
  }),
  "teacher.listDiscussions": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/discussions", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: TopicListing,
  }),
  "teacher.discussionThread": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/discussions/:topicId", surface: "teacher",
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), response: StaffThreadBody,
  }),
  "teacher.createTopic": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/discussions", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: NewTopic, response: DiscussionTopic,
  }),
  "teacher.updateTopic": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/discussions/:topicId", surface: "teacher",
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), body: TopicPatch, response: DiscussionTopic,
  }),
  "teacher.deleteTopic": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/discussions/:topicId/delete", surface: "teacher",
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "teacher.createPost": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/discussions/:topicId/posts", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId, topicId: DiscussionTopicId }), body: NewPost, response: DiscussionPost,
  }),
  "teacher.editPost": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/posts/:postId", surface: "teacher",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: z.strictObject({ body: PostBody }), response: DiscussionPost,
  }),
  "teacher.deletePost": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/posts/:postId/delete", surface: "teacher",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "teacher.moderatePost": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/posts/:postId/moderation", surface: "teacher",
    params: params({ offeringId: OfferingId, postId: DiscussionPostId }), body: z.strictObject({ decision: ModerationDecision }), response: DiscussionPost,
  }),
  "teacher.moderationQueue": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/discussion-moderation", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: ModerationQueueBody,
  }),
  "teacher.discussionSettings": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/discussion-settings", surface: "teacher",
    params: params({ offeringId: OfferingId }), body: DiscussionSettings, response: DiscussionSettings,
  }),
  "teacher.discussionParticipation": route({
    method: "GET", path: "/api/teacher/assignments/:assignmentId/discussion-posts/:principalId", surface: "teacher",
    params: params({ assignmentId: AssignmentId, principalId: PrincipalId }), response: DiscussionParticipationBody,
  }),

  // Quizzes (SCHO-191). Kept in one block, apart from the routes above.
  "student.listQuizzes": route({
    method: "GET", path: "/api/student/offerings/:offeringId/quizzes", surface: "student",
    params: params({ offeringId: OfferingId }), response: z.array(StudentQuizView),
  }),
  "student.getQuiz": route({
    method: "GET", path: "/api/student/offerings/:offeringId/quizzes/:quizId", surface: "student",
    params: params({ offeringId: OfferingId, quizId: QuizId }), response: StudentQuizView,
  }),
  "student.startQuizAttempt": route({
    method: "POST", path: "/api/student/offerings/:offeringId/quizzes/:quizId/attempts", surface: "student", status: 201,
    params: params({ offeringId: OfferingId, quizId: QuizId }), body: NoBody, response: StudentAttemptView,
  }),
  "student.quizAttempt": route({
    method: "GET", path: "/api/student/offerings/:offeringId/quiz-attempts/:attemptId", surface: "student",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId }), response: StudentAttemptView,
  }),
  "student.saveQuizAnswers": route({
    method: "POST", path: "/api/student/offerings/:offeringId/quiz-attempts/:attemptId/answers", surface: "student",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId }), body: QuizAnswersInput, response: QuizSaveBody,
  }),
  "student.submitQuizAttempt": route({
    method: "POST", path: "/api/student/offerings/:offeringId/quiz-attempts/:attemptId/submit", surface: "student",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId }), body: QuizAnswersInput, response: StudentAttemptResult,
  }),
  "student.quizAttemptResult": route({
    method: "GET", path: "/api/student/offerings/:offeringId/quiz-attempts/:attemptId/result", surface: "student",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId }), response: StudentAttemptResult,
  }),
  "teacher.listQuizzes": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/quizzes", surface: "teacher",
    params: params({ offeringId: OfferingId }), response: StaffQuizListingBody,
  }),
  "teacher.getQuiz": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), response: Quiz,
  }),
  "teacher.createQuiz": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quizzes", surface: "teacher", status: 201,
    params: params({ offeringId: OfferingId }), body: NewQuiz, response: Quiz,
  }),
  "teacher.updateQuiz": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), body: QuizPatch, response: Quiz,
  }),
  "teacher.publishQuiz": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId/publish", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), body: z.strictObject({ published: z.boolean() }), response: Quiz,
  }),
  "teacher.deleteQuiz": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId/delete", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), body: NoBody, response: z.strictObject({ deleted: z.literal(true) }),
  }),
  "teacher.quizResults": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId/results", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), response: QuizResultsBody,
  }),
  "teacher.releaseQuizScores": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quizzes/:quizId/release", surface: "teacher",
    params: params({ offeringId: OfferingId, quizId: QuizId }), body: NoBody, response: ReleaseOutcome,
  }),
  "teacher.quizAttempt": route({
    method: "GET", path: "/api/teacher/offerings/:offeringId/quiz-attempts/:attemptId", surface: "teacher",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId }), response: StaffAttemptBody,
  }),
  "teacher.gradeQuizItem": route({
    method: "POST", path: "/api/teacher/offerings/:offeringId/quiz-attempts/:attemptId/items/:itemId/grade", surface: "teacher",
    params: params({ offeringId: OfferingId, attemptId: QuizAttemptId, itemId: QuizItemId }), body: ItemGradeInput, response: StaffAttemptBody,
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
