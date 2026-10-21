import { z } from "zod";
import { createCapabilityRegistry, type CapabilityRegistry, type PackDefinition } from "./registry.ts";

/**
 * The JSON Schema keyword marking a boolean pack setting whose `true` value widens AI use or
 * exposes more student data. Turning one on needs district-admin approval (see `plan.ts`).
 */
export const GOVERNANCE_KEYWORD = "x-schoolos-governance";

/** What a governed setting widens. */
export type GovernanceArea = "ai" | "privacy";

/** Metadata for a boolean setting whose `true` value loosens AI or privacy governance. */
function governed(area: GovernanceArea, title: string, description: string) {
  return { title, description, [GOVERNANCE_KEYWORD]: area };
}

const ARTIFACT_TYPES = [
  "document",
  "notebook",
  "spreadsheet",
  "presentation",
  "dataset",
  "image",
  "audio",
  "video",
  "interactive",
] as const;

const coreLearning: PackDefinition = {
  manifest: {
    id: "core-learning",
    version: "1.0.0",
    description: "Terms, offerings, rosters, personal and course workspaces, and the classroom fallback "
      + "source of record for assignments, submissions and feedback.",
    dependencies: [],
    defaultsProfile: "us-k12-conservative",
    supportedScopes: ["district", "school", "offering"],
    permissionScopes: ["workspace:read", "workspace:write", "submission:create", "submission:read"],
    requiredResources: ["worker", "durable-object", "d1", "kv"],
    migrations: ["0001-academic-records"],
    probes: ["directory-readable", "workspace-durable-object-reachable"],
    estimatedCostDrivers: ["active principals", "Durable Object requests"],
  },
  config: z.strictObject({
    personalWorkspaces: z.boolean().default(true)
      .meta({ title: "Personal workspaces", description: "Give every student a private workspace outside their classes." }),
    closedCourseRetentionDays: z.int().min(30).max(3650).default(365)
      .meta({ title: "Closed course retention (days)", description: "How long a closed course workspace stays readable before it becomes eligible for deletion." }),
  }),
  supportsAdvisory: false,
};

const learningArtifacts: PackDefinition = {
  manifest: {
    id: "learning-artifacts",
    version: "1.0.0",
    description: "Versioned student and teacher work with save, history, share, submit and export.",
    dependencies: [{ id: "core-learning", versionRange: "^1.0.0" }],
    supportedScopes: ["district", "school", "offering"],
    permissionScopes: ["artifact:read", "artifact:write", "artifact:share"],
    requiredResources: ["r2", "durable-object"],
    optionalResources: ["artifacts"],
    migrations: ["0001-artifact-index"],
    probes: ["artifact-store-writable"],
    estimatedCostDrivers: ["stored gigabytes", "revision count"],
  },
  config: z.strictObject({
    storage: z.enum(["r2", "artifacts"]).default("r2")
      .meta({ title: "Versioned storage", description: "Cloudflare Artifacts keeps Git-backed history; R2 keeps snapshots." }),
    maxUploadMegabytes: z.int().min(1).max(500).default(50),
    allowedTypes: z.array(z.enum(ARTIFACT_TYPES)).min(1).default(["document", "spreadsheet", "presentation", "image"]),
  }),
  supportsAdvisory: false,
};

const learningRegistry: PackDefinition = {
  manifest: {
    id: "learning-registry",
    version: "1.1.0",
    description: "Frameworks, competencies, standards alignments and the reviewed resource catalog.",
    dependencies: [{ id: "core-learning", versionRange: "^1.0.0" }],
    supportedScopes: ["district", "school"],
    permissionScopes: ["resource:read", "resource:publish"],
    requiredResources: ["d1", "r2"],
    migrations: ["0001-frameworks", "0002-resource-releases"],
    probes: ["framework-catalog-loaded"],
    estimatedCostDrivers: ["catalog size"],
  },
  config: z.strictObject({
    alignmentReviewer: z.enum(["teacher", "curriculum-admin"]).default("curriculum-admin")
      .meta({ title: "Who confirms standards alignments", description: "AI-suggested alignments stay unconfirmed until this role reviews them." }),
    allowCustomFrameworks: z.boolean().default(false)
      .meta({ title: "District-authored frameworks", description: "Let curriculum administrators publish frameworks of their own." }),
  }),
  supportsAdvisory: false,
};

const teacherStudio: PackDefinition = {
  manifest: {
    id: "teacher-studio",
    version: "1.0.0",
    description: "Lesson and assignment authoring for teachers, with rubric design and class setup.",
    dependencies: [
      { id: "core-learning", versionRange: "^1.0.0" },
      { id: "learning-artifacts", versionRange: "^1.0.0" },
    ],
    supportedScopes: ["district", "school", "offering"],
    permissionScopes: ["activity:create", "activity:publish", "rubric:write"],
    requiredResources: ["worker", "durable-object"],
    optionalResources: ["ai-gateway"],
    migrations: [],
    probes: ["studio-reachable"],
    estimatedCostDrivers: ["AI drafting requests"],
  },
  config: z.strictObject({
    aiLessonDrafting: z.boolean().default(false)
      .meta(governed("ai", "AI lesson drafting", "Let teachers draft lessons with the district's AI providers.")),
    requireDraftReview: z.boolean().default(true)
      .meta({ title: "Review AI drafts before publishing", description: "Teachers confirm each AI-drafted activity before students see it." }),
  }),
  supportsAdvisory: false,
};

const contentStudio: PackDefinition = {
  manifest: {
    id: "content-studio",
    version: "1.0.0",
    description: "Quarantined import, review and approval of outside content into the resource registry.",
    dependencies: [
      { id: "learning-registry", versionRange: "^1.1.0" },
      { id: "learning-artifacts", versionRange: "^1.0.0" },
    ],
    supportedScopes: ["district", "school"],
    permissionScopes: ["resource:import", "resource:approve"],
    requiredResources: ["worker", "queue", "r2", "workflow"],
    migrations: ["0001-import-quarantine"],
    probes: ["quarantine-bucket-writable"],
    estimatedCostDrivers: ["imports per month", "review AI requests"],
  },
  config: z.strictObject({
    importAdapters: z.array(z.enum(["url", "upload", "thin-common-cartridge", "case"])).min(1).default(["url", "upload"]),
    approver: z.enum(["teacher", "curriculum-admin", "district-admin"]).default("curriculum-admin")
      .meta({ title: "Who approves imports", description: "The role that must approve an import before it is released." }),
    aiReview: z.boolean().default(false)
      .meta(governed("ai", "AI review of imports", "Send imported content to the district's AI providers for a review report.")),
  }),
  supportsAdvisory: false,
};

const assessmentCi: PackDefinition = {
  manifest: {
    id: "assessment-ci",
    version: "0.9.0",
    description: "Cross-subject checks on submitted work, run against a pinned rubric and evaluator release.",
    dependencies: [
      { id: "core-learning", versionRange: "^1.0.0" },
      { id: "learning-artifacts", versionRange: "^1.0.0" },
    ],
    supportedScopes: ["district", "school", "offering", "activity"],
    permissionScopes: ["assessment-run:create", "assessment-run:read", "submission:read"],
    requiredResources: ["worker", "queue", "d1"],
    optionalResources: ["ci-sandbox", "ai-gateway"],
    migrations: ["0001-assessment-runs"],
    probes: ["evaluator-queue-reachable"],
    estimatedCostDrivers: ["runs per submission", "sandbox minutes"],
  },
  config: z.strictObject({
    evaluators: z.array(z.enum(["presence", "structure", "citation-format", "spreadsheet-assertions", "dataset-structure"]))
      .min(1).default(["presence", "structure"]),
    aiFeedback: z.boolean().default(false)
      .meta(governed("ai", "AI writing feedback", "Add AI feedback with excerpt-level evidence that a teacher can override.")),
    sandboxExecution: z.boolean().default(false)
      .meta({ title: "Sandboxed code execution", description: "Run executable checks in isolated CI with restricted egress." }),
    maxRunSeconds: z.int().min(5).max(600).default(60),
  }),
  supportsAdvisory: true,
};

const classroomCodex: PackDefinition = {
  manifest: {
    id: "classroom-codex",
    version: "1.0.0",
    description: "The course AI assistant, grounded in the offering's approved resources.",
    dependencies: [
      { id: "core-learning", versionRange: "^1.0.0" },
      { id: "learning-registry", versionRange: "~1.1.0" },
    ],
    supportedScopes: ["district", "school", "offering", "activity"],
    permissionScopes: ["conversation:create", "resource:read"],
    requiredResources: ["worker", "durable-object", "ai-gateway"],
    migrations: [],
    probes: ["ai-gateway-reachable"],
    estimatedCostDrivers: ["AI tokens per principal"],
  },
  config: z.strictObject({
    assistantStyle: z.enum(["socratic", "explanatory"]).default("socratic"),
    groundToApprovedResources: z.boolean().default(true),
    shareConversationsWithTeacher: z.boolean().default(false)
      .meta(governed("privacy", "Share course conversations with the teacher", "Teachers can read students' course-assistant conversations.")),
  }),
  supportsAdvisory: false,
};

const schoolosLti: PackDefinition = {
  manifest: {
    id: "schoolos-lti",
    version: "0.3.0",
    description: "Optional. LTI 1.3 launches from the district's LMS into SchoolOS activities.",
    dependencies: [{ id: "core-learning", versionRange: "^1.0.0" }],
    supportedScopes: ["district", "school"],
    permissionScopes: ["activity:launch"],
    requiredResources: ["worker", "kv"],
    migrations: ["0001-lti-registrations"],
    probes: ["platform-jwks-reachable"],
    estimatedCostDrivers: ["launches per month"],
  },
  config: z.strictObject({
    // Registration identifiers only. The tool's private key is a Worker secret, never config.
    platforms: z.array(z.strictObject({
      issuer: z.url({ protocol: /^https$/ }),
      clientId: z.string().min(1).max(255),
      deploymentId: z.string().min(1).max(255),
    })).default([]).meta({ title: "LMS platforms" }),
  }),
  supportsAdvisory: false,
};

const playtrek: PackDefinition = {
  manifest: {
    id: "playtrek",
    version: "0.4.0",
    description: "Optional. PlayTrek interactive learning experiences aligned to the learning registry.",
    dependencies: [
      { id: "learning-registry", versionRange: "^1.0.0" },
      { id: "learning-artifacts", versionRange: "^1.0.0" },
    ],
    supportedScopes: ["district", "school", "offering"],
    permissionScopes: ["activity:launch", "resource:read"],
    requiredResources: ["worker", "durable-object"],
    migrations: [],
    probes: ["experience-catalog-loaded"],
    estimatedCostDrivers: ["interactive sessions"],
  },
  config: z.strictObject({
    gradeBands: z.array(z.enum(["K-2", "3-5", "6-8", "9-12"])).min(1).default(["6-8"]),
  }),
  supportsAdvisory: false,
};

const studentPortability: PackDefinition = {
  manifest: {
    id: "student-portability",
    version: "0.1.0",
    description: "Students export their own work and records when they leave or graduate.",
    dependencies: [
      { id: "core-learning", versionRange: "^1.0.0" },
      { id: "learning-artifacts", versionRange: "^1.0.0" },
    ],
    supportedScopes: ["district"],
    permissionScopes: ["artifact:export"],
    requiredResources: ["worker", "workflow", "r2"],
    migrations: [],
    probes: ["export-workflow-reachable"],
    estimatedCostDrivers: ["export archive gigabytes"],
  },
  config: z.strictObject({
    exportFormats: z.array(z.enum(["zip", "open-badges"])).min(1).default(["zip"]),
    exportLinkDays: z.int().min(1).max(30).default(7),
  }),
  supportsAdvisory: false,
};

/** The packs SchoolOS ships, as data. */
export const SHIPPED_PACK_DEFINITIONS: readonly PackDefinition[] = [
  coreLearning,
  learningArtifacts,
  learningRegistry,
  teacherStudio,
  contentStudio,
  assessmentCi,
  classroomCodex,
  schoolosLti,
  playtrek,
  studentPortability,
];

function shippedRegistry(): CapabilityRegistry {
  const result = createCapabilityRegistry(SHIPPED_PACK_DEFINITIONS);
  if (!result.ok) throw new Error(`shipped capability packs are invalid: ${JSON.stringify(result.problems)}`);
  return result.registry;
}

/** The registry of shipped packs. Built at import, so an invalid shipped manifest fails loudly. */
export const SHIPPED_REGISTRY: CapabilityRegistry = shippedRegistry();
