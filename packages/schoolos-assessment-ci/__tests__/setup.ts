import { expect } from "vitest";
import {
  ActivityId,
  DistrictId,
  OfferingId,
  PrincipalId,
  RubricId,
  type ArtifactType,
  type Caller,
  type PolicySettings,
  type RequestChannel,
} from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { AssessmentService, InMemoryAssessmentRecordStore, type SubmissionReceipt } from "@schoolos/assessment";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@schoolos/workspaces";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
  type ArtifactView,
} from "@schoolos/learning-artifacts";
import {
  AssessmentCi,
  AssessmentRuns,
  builtinRegistry,
  DETERMINISTIC_PROFILE,
  InMemoryAssessmentRunStore,
  InMemoryRubricReleaseStore,
  rubricRef,
  signRubricRelease,
  type EvaluatorRegistry,
  type ExecutionProfile,
  type RubricDraft,
  type RubricRelease,
  type RubricSigningPolicy,
} from "../src/index.ts";

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** "Now" in every test, before every due date. */
export const NOW = new Date("2026-10-20T12:00:00Z");
const now = () => NOW;

/** A caller verified as `principalId`, through `channel`. */
export function as(principalId: string, channel: RequestChannel = "http"): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") }, channel };
}

/** Well-known callers. */
export const P = {
  morgan: as("prn_nf-morgan-lee"),
  morganAgent: as("prn_nf-morgan-lee", "agent"),
  rivera: as("prn_nf-teacher-rivera"),
  riveraTool: as("prn_nf-teacher-rivera", "mcp-tool"),
  patel: as("prn_nf-teacher-patel"),
  amara: as("prn_nf-student-amara"),
  elena: as("prn_nf-student-elena"),
  chidi: as("prn_nf-student-chidi"),
};

/** Well-known offerings. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"), // Morgan teaches; Amara enrolled
  eng9: OfferingId.parse("off_nf-eng9-fall-p3"), // Rivera teaches; Amara, Elena enrolled
  math7: OfferingId.parse("off_nf-math7-fall-p1"), // Patel teaches; Chidi enrolled
};

/** The whole stack: assessment over learning artifacts and workspaces, plus Assessment CI. */
export function setup() {
  const academics = InMemoryAcademicStore.seeded(NORTHFIELD);
  const workspaceStore = new InMemoryWorkspaceStore();
  const policy = new PolicyEngine({ information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }), audit: new InMemoryPolicyAuditSink() });
  const workspaces = new WorkspaceDirectory({ workspaces: workspaceStore, directory: academics, policy, retention: { courseWorkspaceRetentionDays: 30 }, now });
  const content = new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() });
  const artifacts = new LearningArtifacts({
    records: new InMemoryArtifactRecordStore(),
    content,
    workspaces: workspaceStore,
    directory: academics,
    policy,
    approvedExternalHosts: [],
    now,
  });
  const assessment = new AssessmentService({ records: new InMemoryAssessmentRecordStore(), artifacts, content, directory: academics, policy, now });
  const rubrics = new InMemoryRubricReleaseStore();
  const runStore = new InMemoryAssessmentRunStore();
  const registry = builtinRegistry();

  /** Assessment CI over the shared stores with `registry` and `profiles`, as a district would after changing them. */
  function ciWith(options: { registry?: EvaluatorRegistry; profiles?: readonly ExecutionProfile[]; signing?: RubricSigningPolicy } = {}) {
    const runs = new AssessmentRuns({
      runs: runStore,
      rubrics,
      registry: options.registry ?? registry,
      profiles: options.profiles ?? [DETERMINISTIC_PROFILE],
      ...(options.signing === undefined ? {} : { signing: options.signing }),
      now,
    });
    return { runs, ci: new AssessmentCi({ assessment, runs }) };
  }

  /** Signs `draft` as `teacher` and stores it. */
  async function publishRubric(teacher: Caller, draft: RubricDraft, signer: EvaluatorRegistry = registry): Promise<RubricRelease> {
    const release = await signRubricRelease(draft, teacher, signer, NOW);
    await rubrics.put(release);
    return release;
  }

  /**
   * Publishes a rubric, creates an assignment in `offeringId` that uses it, and submits `work` as
   * `student` from their course workspace.
   */
  async function submitWork(spec: {
    teacher: Caller;
    student: Caller;
    offeringId: OfferingId;
    rubric: RubricDraft;
    work: { type: ArtifactType; mediaType: string; title: string; text: string }[];
  }): Promise<{ release: RubricRelease; receipt: SubmissionReceipt; artifacts: ArtifactView[]; workspaceId: string }> {
    const release = await publishRubric(spec.teacher, spec.rubric);
    const assignment = await assessment.createAssignment(spec.teacher, {
      offeringId: spec.offeringId,
      activityId: ActivityId.parse("act_assessment-ci"),
      title: spec.rubric.title,
      dueAt: "2026-10-30T23:59:00Z",
      latePolicy: { kind: "accept" },
      attemptsAllowed: 3,
      permittedArtifactTypes: [...new Set(spec.work.map((w) => w.type))],
      rubric: rubricRef(release),
      feedbackVisibility: "when-shared",
    });
    const workspace = await workspaces.ensureCourseWorkspace(spec.student, spec.offeringId);
    const created: ArtifactView[] = [];
    for (const w of spec.work) {
      created.push(await artifacts.createArtifact(spec.student, {
        workspaceId: workspace.id,
        type: w.type,
        title: w.title,
        content: { kind: "text", mediaType: w.mediaType, text: w.text },
        aiAssistance: { level: "none" },
      }));
    }
    const receipt = await assessment.submit(spec.student, assignment.id, created.map((v) => ({ artifactId: v.artifact.id, revisionId: v.head.id })));
    return { release, receipt, artifacts: created, workspaceId: workspace.id };
  }

  return { academics, policy, assessment, artifacts, workspaces, rubrics, runStore, registry, publishRubric, submitWork, ciWith, ...ciWith() };
}

/** Expects a promise to reject with a SchoolOS error code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

// The three subjects of the E02 acceptance test.

/** An English 9 literary essay, in MLA. */
export const ESSAY = `# Silence and Witness in Night

## Introduction
Elie Wiesel's memoir Night asks what it means to bear witness when words fail. The narrator learns that silence can protect, but it can also betray the people who most need to be heard.

## Analysis
Early in the book the townspeople refuse to believe Moishe the Beadle, and their silence lets fear grow unchecked (Wiesel 7). Later, Eliezer describes a night of silence in the camp that marks the end of his faith (Wiesel 34). Critics note that this silence is a choice the author makes on purpose (Smith 112). One reader called it a refusal to explain (Lee, 2019).

## Conclusion
Wiesel shows that remembering aloud is a duty, and that silence in the face of cruelty is never neutral.

## Works Cited
- Wiesel, Elie. Night. Translated by Marion Wiesel, Hill and Wang, 2006.
- Smith, Jordan. Reading Memoir in the Classroom. Northfield Press, 2019.
- Lee (2019) lecture notes
`;

/** The English rubric: structure and citations visible to the student, required content teacher-only. */
export function essayRubric(version = 1): RubricDraft {
  return {
    rubricId: RubricId.parse("rbr_eng9-night-essay"),
    version,
    title: "Night: literary essay",
    criteria: [
      {
        id: "structure",
        title: "Organization and length",
        levels: [{ id: "beginning", label: "Beginning", points: 0 }, { id: "developing", label: "Developing", points: 2 }, { id: "proficient", label: "Proficient", points: 4 }],
        checks: [{
          id: "essay-shape",
          evaluatorId: "writing.structure",
          visibility: "student-visible",
          config: { minWords: 80, maxWords: 800, countExcludes: ["Works Cited"], requiredSections: ["Introduction", "Analysis", "Conclusion"] },
        }],
      },
      {
        id: "citations",
        title: "MLA citations",
        levels: [{ id: "none", label: "Missing", points: 0 }, { id: "partial", label: "Partial", points: 1 }, { id: "mostly", label: "Mostly correct", points: 2 }, { id: "correct", label: "Correct", points: 3 }],
        checks: [{ id: "mla", evaluatorId: "citation.format", visibility: "student-visible", config: { style: "mla", minInText: 2, referenceSection: "Works Cited", minReferences: 2 } }],
      },
      {
        id: "content",
        title: "Engages the text",
        levels: [{ id: "no", label: "Not yet", points: 0 }, { id: "yes", label: "Yes", points: 2 }],
        checks: [{
          id: "themes",
          evaluatorId: "content.required",
          visibility: "teacher-only",
          config: { items: [{ label: "Names the author", anyOf: ["Wiesel"] }, { label: "Discusses silence", anyOf: ["silence"], section: "Analysis" }] },
        }],
      },
    ],
  };
}

/** A Biology lab's measurements. The mean mass is 5.175 g. */
export const LAB_CSV = `Trial,Temperature (°C),Mass (g),Time (s)
1,20,5.2,30
2,20,5.0,31
3,20,5.4,29
4,20,5.1,30
`;

/** The Biology lab rubric: data quality visible to the student; the computed mean, a fixture, teacher-only. */
export function labRubric(expectedMean = 5.175): RubricDraft {
  return {
    rubricId: RubricId.parse("rbr_bio-osmosis-lab"),
    version: 1,
    title: "Osmosis lab data",
    criteria: [
      {
        id: "data-quality",
        title: "Data recorded with units",
        levels: [{ id: "incomplete", label: "Incomplete", points: 0 }, { id: "partial", label: "Partial", points: 2 }, { id: "complete", label: "Complete", points: 4 }],
        checks: [
          {
            id: "columns",
            evaluatorId: "spreadsheet.assertions",
            visibility: "student-visible",
            config: { columns: [{ name: "Temperature", unit: "°C", min: 0, max: 100 }, { name: "Mass", unit: "g", min: 0, max: 50 }, { name: "Time", unit: "s" }] },
          },
          { id: "shape", evaluatorId: "dataset.structure", visibility: "student-visible", config: { minRows: 3, keyColumn: "Trial", numericColumns: ["Mass", "Time"] } },
        ],
      },
      {
        id: "analysis",
        title: "Computed the mean mass",
        levels: [{ id: "incorrect", label: "Incorrect", points: 0 }, { id: "correct", label: "Correct", points: 2 }],
        checks: [{
          id: "mean-mass",
          evaluatorId: "spreadsheet.computed-value",
          visibility: "teacher-only",
          config: { column: "Mass", unit: "g", aggregate: "mean", expected: expectedMean, tolerance: 0.01 },
        }],
      },
    ],
  };
}

/** A Math 7 problem set. Problem 4 is wrong and problem 5 is not an answer at all. */
export const PROBLEM_SET = `Problem Set 3
1. 3/4
2. x = 2^3 - 1
3) 0.333
4. 4
5. process.exit(1)
`;

/** The answer key, a teacher-only fixture. */
export const ANSWER_KEY = [
  { id: "1", answer: "0.75", tolerance: 0 },
  { id: "2", answer: "7", tolerance: 0 },
  { id: "3", answer: "1/3", tolerance: 0.001 },
  { id: "4", answer: "17/4", tolerance: 0 },
  { id: "5", answer: "12", tolerance: 0 },
];

/** The Math 7 rubric: one criterion, scored by the answer key. */
export function mathRubric(): RubricDraft {
  return {
    rubricId: RubricId.parse("rbr_math7-ps3"),
    version: 1,
    title: "Problem set 3",
    criteria: [{
      id: "answers",
      title: "Correct answers",
      levels: [0, 1, 2, 3, 4, 5].map((points) => ({ id: `p${points}`, label: `${points} correct`, points })),
      checks: [{ id: "key", evaluatorId: "math.answers", visibility: "teacher-only", config: { problems: ANSWER_KEY } }],
    }],
  };
}

/** Submits the essay, the lab and the problem set in one environment. */
export async function threeSubjects() {
  const env = setup();
  const essay = await env.submitWork({ teacher: P.rivera, student: P.amara, offeringId: O.eng9, rubric: essayRubric(), work: [{ type: "document", mediaType: "text/markdown", title: "Night essay", text: ESSAY }] });
  const lab = await env.submitWork({ teacher: P.morgan, student: P.amara, offeringId: O.bioFall, rubric: labRubric(), work: [{ type: "dataset", mediaType: "text/csv", title: "Osmosis data", text: LAB_CSV }] });
  const math = await env.submitWork({ teacher: P.patel, student: P.chidi, offeringId: O.math7, rubric: mathRubric(), work: [{ type: "document", mediaType: "text/plain", title: "Problem set 3", text: PROBLEM_SET }] });
  return { ...env, essay, lab, math };
}
