// A fake district behind the typed API client, for the Teacher Studio tests. It keeps just enough
// state to follow a class from importing a resource to an official grade, records every call, and
// can be told to fail a route. Synthetic data only.
import { DistrictApiError, type DistrictApiClient, type RouteName } from "@educateos/api-client";

type EducateOsErrorBody = ConstructorParameters<typeof DistrictApiError>[1];

type Body = Record<string, unknown>;
type Input = { params?: Record<string, string>; query?: Record<string, string>; body?: Body };

/** One call the UI made. */
export interface RecordedCall {
  name: RouteName;
  input: Input;
}

const NOW = "2026-10-20T15:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** Northfield-style identifiers the tests use. */
export const IDS = {
  district: "dst_northfield",
  offering: "off_nf-eng9-fall-p3",
  teacher: "prn_nf-teacher-rivera",
  amara: "prn_nf-student-amara",
  elena: "prn_nf-student-elena",
  noah: "prn_nf-student-noah",
  existingAssignment: "asg_persuasive-paragraph",
  existingActivity: "act_persuasive-paragraph",
} as const;

/** The learning goal the class's existing activity uses. */
export const GOAL = { frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:W.9-10.1" };
/** The goals the district's approved releases offer English 9 (SCHO-220). */
export const GOALS = [
  { ...GOAL, code: "W.9-10.1", statement: "Write arguments to support claims in an analysis of substantive topics or texts." },
  { frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:W.9-10.2", code: "W.9-10.2", statement: "Write informative/explanatory texts to examine and convey complex ideas." },
];

const OFFERING = {
  offering: { id: IDS.offering, districtId: IDS.district, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-english-9", sectionName: "Period 3" },
  course: { id: "crs_nf-english-9", districtId: IDS.district, title: "English 9", subject: "english-language-arts", gradeBand: "9" },
  role: "teacher",
};

const enrollment = (principalId: string, role: string, status = "active") => ({
  enrollment: { id: `enr_${principalId.slice(4)}`, districtId: IDS.district, offeringId: IDS.offering, principalId, role, status },
});

const ROSTER = [
  { ...enrollment(IDS.teacher, "teacher"), displayName: "Sam Rivera" },
  { ...enrollment(IDS.amara, "student"), displayName: "Amara Okafor" },
  { ...enrollment(IDS.elena, "student", "inactive"), displayName: "Elena Petrova" },
];

const assignment = (id: string, activityId: string, title: string, rubric?: { rubricId: string; version: number }, dueAt = "2026-11-03T23:59:00.000Z") => ({
  id,
  districtId: IDS.district,
  offeringId: IDS.offering,
  activityId,
  title,
  dueAt,
  latePolicy: { kind: "accept" },
  attemptsAllowed: 3,
  permittedArtifactTypes: ["document"],
  ...(rubric === undefined ? {} : { rubric }),
  feedbackVisibility: "when-shared",
  createdBy: IDS.teacher,
  createdAt: NOW,
  updatedAt: NOW,
});

/** The resource report for a page the teacher imports: licensed CC BY-NC, so excerpts at most. */
const resourceItem = (id: string, url: string) => ({
  id,
  districtId: IDS.district,
  resourceId: `res_${id.slice(4)}`,
  revision: 1,
  state: "reviewed",
  targetScope: { level: "offering", districtId: IDS.district, offeringId: IDS.offering },
  submittedBy: IDS.teacher,
  submittedAt: NOW,
  source: { kind: "url", submittedUrl: url, finalUrl: url, hops: [] },
  contentType: "text/html",
  snapshotDigest: DIGEST,
  byteLength: 2048,
  scan: undefined,
  title: "Persuasive Writing Models",
  canonicalUrl: url,
  lang: "en",
  license: { status: "recognized", license: { name: "CC BY-NC 4.0", uri: "https://creativecommons.org/licenses/by-nc/4.0/", supports: "excerpt" }, hints: [] },
  rights: { proposed: "excerpt", current: "excerpt", changes: [] },
  checks: {
    license: { status: "recognized" },
    attribution: "Open Lessons Collective",
    accessibility: { lang: "en", images: 2, imagesWithoutAlt: 1 },
    scripts: { external: [], inline: 0 },
    instructionLikeText: [],
    flags: [{ code: "images-without-alt", severity: "warning", message: "1 of 2 images has no text description." }],
  },
  ai: {
    status: "completed",
    label: "ai-generated",
    notice: "AI-generated findings to help a human reviewer. They are not a certification of rights, standards alignment, accuracy or suitability.",
    findings: [{ category: "bias", summary: "One model essay presents only one side.", excerpt: "Everyone agrees", uncertainty: "medium", excerptVerified: true }],
  },
  decision: undefined,
});

/** Options that change what the fake district does. */
export interface FakeDistrictOptions {
  /** Routes that fail, with the error they fail with. */
  failures?: Partial<Record<RouteName, { status: number; body: EducateOsErrorBody }>>;
  /** Classes the teacher teaches. Defaults to English 9, Period 3. */
  offerings?: unknown[];
  /** The most AI help the district allows; asking for more is refused. */
  maxAiHelp?: "none" | "hints-only" | "full";
  /** The learning goals offered for the class, and how many standards releases are approved. Defaults to {@link GOALS} from one release. */
  learningGoals?: { goals: unknown[]; approvedReleases: number };
}

/** A fake district and the client the app talks to it through. */
export const fakeDistrict = (options: FakeDistrictOptions = {}) => {
  const calls: RecordedCall[] = [];
  const failures = { ...options.failures };
  type Item = Omit<ReturnType<typeof resourceItem>, "decision"> & { decision: unknown };
  const items = new Map<string, Item>();
  const releases: unknown[] = [];
  const definitions = new Map<string, Body>();
  const activities = new Map<string, unknown>([[IDS.existingActivity, {
    view: "teacher",
    installation: { id: IDS.existingActivity },
    content: { title: "Persuasive paragraph", steps: [{ id: "draft", title: "Draft", prompt: "Write it.", sources: [], response: { kind: "writing" } }], evidence: { alignments: [GOAL] } },
    evidenceContract: {},
  }]]);
  const assignments: ReturnType<typeof assignment>[] = [assignment(IDS.existingAssignment, IDS.existingActivity, "Persuasive paragraph")];
  const submissions: Body[] = [];
  const gadgetBindings = new Map<string, Body>();
  const texts = new Map<string, string>();
  // Each submitted item's title and text, by submission and artifact.
  const works = new Map<string, { artifactId: string; title?: string; text: string }[]>();
  const grades: Body[] = [];
  const files = new Map<string, { mediaType: string; base64: string }>();
  const proposals: Body[] = [];
  const feedback = new Map<string, { submissionId: string; state: string; comments: Body[]; scores: Body[]; updatedAt: string }>();
  const rubrics = new Map<string, { rubricId: string; version: number; title: string; criteria: { id: string; title: string; levels: { id: string; label: string; points: number }[] }[] }>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${++counter}`;
  const feedbackFor = (submissionId: string) => {
    let record = feedback.get(submissionId);
    if (record === undefined) {
      record = { submissionId, state: "draft", comments: [], scores: [], updatedAt: NOW };
      feedback.set(submissionId, record);
    }
    return record;
  };
  const LEVELS = { "none": 0, "hints-only": 1, "full": 2 } as const;
  type Module = { id: string; title: string; published: boolean; items: Body[]; source?: Body };
  const outline: { offeringId: string; revision: number; modules: Module[]; pages: Body[] } = { offeringId: IDS.offering, revision: 0, modules: [], pages: [] };
  const moduleOf = (id: string | undefined) => outline.modules.find((m) => m.id === id)!;
  const changed = <T>(value: T): T => {
    outline.revision++;
    return value;
  };
  const CARTRIDGE_PREVIEW = {
    packageDigest: DIGEST,
    title: "Ecosystems",
    modules: [{ title: "Week 1: Producers", items: [{ kind: "page", title: "Plants", characters: 120 }, { kind: "link", title: "Photosynthesis", url: "https://open-lessons.example/photo" }] }],
    skipped: [{ identifier: "I_TOOL", reason: "lti-tool" }],
    flattened: [],
    truncated: [],
  };

  // Gradebook (SCHO-187): a fixed grid of official grades whose markers and settings the UI changes.
  const QUIZ = "asg_claim-quiz";
  const gradebook = {
    offeringId: IDS.offering,
    revision: 0,
    settings: {
      weighting: "none", calculation: "points", missing: "zero", groups: [] as Body[],
      scale: [{ letter: "A", minPercent: 90 }, { letter: "B", minPercent: 80 }, { letter: "C", minPercent: 70 }, { letter: "D", minPercent: 60 }, { letter: "F", minPercent: 0 }],
    } as Body,
    columns: [
      { offeringId: IDS.offering, assignmentId: IDS.existingAssignment, title: "Persuasive paragraph", dueAt: "2026-11-03T23:59:00.000Z", pointsPossible: 10 },
      { offeringId: IDS.offering, assignmentId: QUIZ, title: "=Claim quiz", dueAt: "2026-11-10T23:59:00.000Z", pointsPossible: 5 },
    ],
    rows: [
      {
        studentPrincipalId: IDS.amara, displayName: "Amara Okafor",
        cells: [
          { assignmentId: IDS.existingAssignment, score: { points: 8, maxPoints: 10 }, version: 1, percent: 80, counted: true, dropped: false },
          { assignmentId: QUIZ, score: { points: 5, maxPoints: 5 }, version: 2, percent: 100, counted: true, dropped: false },
        ] as Body[],
        groups: [], totals: { points: { earned: 13, possible: 15 }, unweighted: 86.67, weighted: null, final: 86.67, letter: "B" },
      },
      {
        studentPrincipalId: IDS.noah, displayName: "Noah Brooks",
        cells: [
          { assignmentId: IDS.existingAssignment, percent: null, counted: false, dropped: false },
          { assignmentId: QUIZ, score: { points: 3, maxPoints: 5 }, version: 1, percent: 60, counted: true, dropped: false },
        ] as Body[],
        groups: [], totals: { points: { earned: 3, possible: 5 }, unweighted: 60, weighted: null, final: 60, letter: "D" },
      },
    ],
  };
  // Communication (SCHO-189): the class's announcements and its note to families.
  const announcements: { announcement: Body & { id: string; publishAt: string; deleted?: boolean }; courseLabel: string; published: boolean }[] = [];
  let weeklyNote: Body | null = null;

  const recordGrade = (submissionId: string, score: Body) => {
    const submission = submissions.find((s) => s.id === submissionId)!;
    const earlier = grades.filter((g) => g.assignmentId === submission.assignmentId && g.studentPrincipalId === submission.studentPrincipalId);
    const version = {
      format: "educateos.official-grade.v1", districtId: IDS.district, offeringId: IDS.offering, assignmentId: submission.assignmentId,
      studentPrincipalId: submission.studentPrincipalId, submissionId: submission.id, submissionDigest: DIGEST, version: earlier.length + 1,
      score, approval: { approvedBy: IDS.teacher, approvedAt: NOW, channel: "http" },
    };
    grades.push(version);
    return version;
  };

  const handlers: Partial<Record<RouteName, (input: Input) => unknown>> = {
    "teacher.listAnnouncements": () => announcements.filter((a) => a.announcement.deleted !== true).toReversed(),
    "teacher.createAnnouncement": ({ params, body }) => {
      const publishAt = typeof body!.publishAt === "string" ? body!.publishAt : NOW;
      const entry = {
        announcement: { id: next("ann"), districtId: IDS.district, offeringId: params!.offeringId!, title: body!.title, body: body!.body, publishAt, created: { by: IDS.teacher, at: NOW } },
        courseLabel: "English 9 (Period 3)",
        published: publishAt <= NOW,
      };
      announcements.push(entry);
      return entry;
    },
    "teacher.updateAnnouncement": ({ params, body }) => {
      const entry = announcements.find((a) => a.announcement.id === params!.announcementId)!;
      Object.assign(entry.announcement, body);
      entry.published = entry.announcement.publishAt <= NOW;
      return entry;
    },
    "teacher.deleteAnnouncement": ({ params }) => {
      const entry = announcements.find((a) => a.announcement.id === params!.announcementId);
      if (entry !== undefined) entry.announcement.deleted = true;
      return { deleted: true };
    },
    "teacher.weeklyNote": () => ({ week: "2026-W44", note: weeklyNote }),
    "teacher.setWeeklyNote": ({ body }) => {
      const text = String(body!.text).trim();
      weeklyNote = text === "" ? null : { offeringId: IDS.offering, week: "2026-W44", text, updated: { by: IDS.teacher, at: NOW } };
      return { week: "2026-W44", note: weeklyNote };
    },
    "me.get": () => ({ principalId: IDS.teacher, districtId: IDS.district, kind: "staff", displayName: "Sam Rivera", roles: [], enrollments: [] }),
    "teacher.listOfferings": () => options.offerings ?? [OFFERING],
    "teacher.roster": () => ROSTER,
    "teacher.listAssignments": () => assignments,
    "teacher.getActivity": ({ params }) => activities.get(params!.activityId!),
    "teacher.learningGoals": () => options.learningGoals ?? { goals: GOALS, approvedReleases: 1 },
    "teacher.importResource": ({ body }) => {
      const item = resourceItem(next("itm"), String(body!.url));
      items.set(item.id, item);
      return item;
    },
    "teacher.reviewQueue": () => [...items.values()].filter((item) => item.state === "reviewed").map((item) => ({
      itemId: item.id, resourceId: item.resourceId, title: item.title, source: item.source, contentType: item.contentType, targetScope: item.targetScope,
      submittedBy: item.submittedBy, submittedAt: item.submittedAt, proposedRights: item.rights.proposed, currentRights: item.rights.current, blockingFlags: 0,
    })),
    "teacher.resourceReport": ({ params }) => items.get(params!.itemId!),
    "teacher.approveResource": ({ params }) => {
      const item = items.get(params!.itemId!)!;
      const decided = { ...item, state: "released", revision: item.revision + 1, decision: { outcome: "approved", by: IDS.teacher, at: NOW, version: "1.0.0" } };
      items.set(item.id, decided);
      const release = {
        descriptor: { id: item.resourceId, release: { version: "1.0.0", releasedAt: NOW, contentDigest: DIGEST }, title: item.title, license: { name: "CC BY-NC 4.0", permittedUses: ["link", "embed", "excerpt"] } },
        itemId: item.id,
        scope: item.targetScope,
        alignmentEvidence: [],
      };
      releases.push(release);
      return release;
    },
    "teacher.listReleases": () => releases,
    "teacher.signRubric": ({ body }) => {
      const rubric = body!.rubric as { rubricId: string; version: number; title: string; criteria: never[] };
      const release = { format: "educateos.rubric-release.v1", ...rubric, signature: { signedBy: IDS.teacher, signedAt: NOW, channel: "http", digest: DIGEST } };
      rubrics.set(`${rubric.rubricId}@${rubric.version}`, release);
      return release;
    },
    "teacher.createActivity": ({ body }) => {
      const activity = body!.activity as Body & { aiHelp: keyof typeof LEVELS; codex: unknown[]; resources: unknown[]; alignments: unknown[]; title: string; overview: string };
      const max = options.maxAiHelp ?? "full";
      if (LEVELS[activity.aiHelp] > LEVELS[max]) {
        throw new DistrictApiError(422, { code: "policy-violation", message: `AI help may only be narrowed: the district allows ${max}` });
      }
      const definition = {
        id: next("adf"),
        version: 1,
        status: "draft",
        scope: { level: "offering", districtId: IDS.district, offeringId: IDS.offering },
        content: {
          template: activity.template,
          title: activity.title,
          subject: activity.subject,
          gradeBand: activity.gradeBand,
          overview: activity.overview,
          // A science investigation asks for its data table; every other template, a written draft.
          steps: activity.template === "science-investigation"
            ? [
              { id: "method", title: "Method", prompt: String(activity.methodPrompt), sources: [], response: { kind: "writing" } },
              { id: "data", title: "Data", prompt: "Record your observations.", sources: [], response: { kind: "dataset", columns: activity.dataColumns } },
            ]
            : [{ id: "draft", title: "Draft", prompt: String(activity.prompt ?? "Do the work."), sources: [], response: { kind: "writing" } }],
          resources: activity.resources,
          codex: activity.codex,
          rubricSlots: [],
          aiHelp: activity.aiHelp,
          permittedArtifactTypes: ["document"],
          due: { kind: "none" },
          evidence: { responseType: "text", criteria: [], collaboration: "individual", alignments: activity.alignments },
        },
        evidenceContract: {},
        savedBy: IDS.teacher,
        savedAt: NOW,
      };
      definitions.set(definition.id, definition);
      return definition;
    },
    "teacher.publishActivity": ({ params }) => {
      const definition: Body = { ...definitions.get(params!.definitionId!)!, status: "published", published: { by: IDS.teacher, at: NOW } };
      definitions.set(params!.definitionId!, definition);
      return definition;
    },
    "teacher.installActivity": ({ params, body }) => {
      const definition = definitions.get(params!.definitionId!)! as { content: { title: string; evidence: { alignments: unknown[] } } };
      const settings = (body!.assignment ?? {}) as { dueAt?: string; rubric?: { rubricId: string; version: number } };
      const activityId = next("act");
      activities.set(activityId, { view: "teacher", installation: { id: activityId }, content: definition.content, evidenceContract: {} });
      const created = assignment(next("asg"), activityId, definition.content.title, settings.rubric, settings.dueAt);
      assignments.push(created);
      return { installation: { id: activityId }, assignment: created };
    },
    "teacher.getGadgetAssessment": ({ params }) => gadgetBindings.get(params!.assignmentId!) ?? null,
    "teacher.bindGadgetAssessment": ({ params, body }) => {
      const assignmentId = params!.assignmentId!;
      const binding = { assignmentId, blueprint: body!.blueprint, rubric: assignments.find((a) => a.id === assignmentId)!.rubric, boundBy: IDS.teacher, boundAt: NOW };
      gadgetBindings.set(assignmentId, binding);
      return binding;
    },
    "teacher.listSubmissions": ({ params }) => submissions.filter((s) => s.assignmentId === params!.assignmentId),
    "teacher.submittedContent": ({ params }) => {
      const submission = submissions.find((s) => s.id === params!.submissionId)! as { items: Body[] };
      const pieces = works.get(params!.submissionId!);
      if (pieces !== undefined) {
        const piece = pieces.find((w) => w.artifactId === params!.artifactId)!;
        return { item: submission.items.find((i) => i.artifactId === piece.artifactId), content: { kind: "text", text: piece.text }, ...(piece.title === undefined ? {} : { title: piece.title }) };
      }
      const file = files.get(params!.submissionId!);
      // Learning Home saves a step's work as "<assignment>: <step>"; both fake activities have a "Draft" step.
      const title = `${assignments.find((a) => a.id === (submission as Body).assignmentId)!.title}: Draft`;
      return { item: submission.items[0], title, content: file === undefined ? { kind: "text", text: texts.get(params!.submissionId!) } : { kind: "bytes", base64: file.base64 } };
    },
    "teacher.getFeedback": ({ params }) => feedbackFor(params!.submissionId!),
    "teacher.runCi": ({ params }) => {
      const submission = submissions.find((s) => s.id === params!.submissionId)! as { rubric?: { rubricId: string; version: number } };
      const rubric = submission.rubric === undefined ? undefined : rubrics.get(`${submission.rubric.rubricId}@${submission.rubric.version}`);
      const criteria = rubric?.criteria ?? [];
      const suggestions = criteria.map((c) => ({
        criterionId: c.id, points: c.levels.at(-1)!.points, maxPoints: c.levels.at(-1)!.points,
        source: { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "writing.structure@1.0.0" } }, enteredBy: IDS.teacher, enteredAt: NOW,
      }));
      const record = feedbackFor(params!.submissionId!);
      record.scores = [...record.scores.filter((s) => (s.source as { kind: string }).kind === "teacher"), ...suggestions];
      return {
        run: {
          view: "teacher",
          runId: "asr_run-1",
          state: "completed",
          report: {
            format: "educateos.assessment-report.v2",
            runId: "asr_run-1",
            key: { submissionDigest: DIGEST, rubricRelease: submission.rubric, evaluatorRelease: DIGEST, executionProfile: "deterministic-v1", idempotencyKey: "default" },
            rubricDigest: DIGEST,
            evaluatorReleases: [{ id: "writing.structure", release: "1.0.0" }],
            stepsUsed: 1,
            costUsdNano: "0",
            criteria: criteria.map((c) => ({
              criterionId: c.id,
              title: c.title,
              checks: [{ checkId: "length", evaluator: { id: "writing.structure", release: "1.0.0" }, visibility: "student-visible", evidence: [{ criterionId: c.id, observation: "The essay has 24 words; 20 are required.", passed: true, excerpts: [], explanation: "Counted the words in the submitted text." }] }],
              suggestions: [{ evaluator: { id: "writing.structure", release: "1.0.0" }, levelId: c.levels.at(-1)!.id, points: c.levels.at(-1)!.points, maxPoints: c.levels.at(-1)!.points }],
            })),
            summary: { criteria: criteria.length, checks: criteria.length, passed: criteria.length, failed: 0, observations: 0, text: `${criteria.length} of ${criteria.length} checks met.` },
          },
        },
        suggestions,
      };
    },
    "teacher.scoreCriterion": ({ params, body }) => {
      const record = feedbackFor(params!.submissionId!);
      const score = { criterionId: body!.criterionId, points: body!.points, ...(body!.maxPoints === undefined ? {} : { maxPoints: body!.maxPoints }), source: { kind: "teacher" }, enteredBy: IDS.teacher, enteredAt: NOW };
      record.scores = [...record.scores.filter((s) => !(s.criterionId === body!.criterionId && (s.source as { kind: string }).kind === "teacher")), score];
      return score;
    },
    "teacher.addComment": ({ params, body }) => {
      const comment = { id: next("fbc"), ...body, source: { kind: "teacher" }, enteredBy: IDS.teacher, enteredAt: NOW };
      feedbackFor(params!.submissionId!).comments.push(comment);
      return comment;
    },
    "teacher.releaseFeedback": ({ params, body }) => {
      const record = feedbackFor(params!.submissionId!);
      record.state = String(body!.state);
      return record;
    },
    "teacher.recordGrade": ({ params, body }) => ({ status: "official", version: recordGrade(String(params!.submissionId), body!.score as Body) }),
    "teacher.officialGrades": ({ params }) => grades.filter((g) => g.assignmentId === params!.assignmentId && g.studentPrincipalId === params!.studentId),
    "teacher.getRubric": ({ params }) => {
      const release = rubrics.get(`${params!.rubricId}@${params!.version}`);
      if (release === undefined) throw new DistrictApiError(404, { code: "not-found", message: "no such rubric" });
      return release;
    },
    "teacher.pendingGrades": ({ params }) => proposals.filter((p) => p.assignmentId === params!.assignmentId && p.declined === undefined),
    "teacher.declineGradeProposal": ({ params, body }) => {
      const proposal = proposals.find((p) => p.id === params!.proposalId)!;
      proposal.declined = { declinedBy: IDS.teacher, declinedAt: NOW, reason: body!.reason };
      return proposal;
    },
    "teacher.updateAssignment": ({ params, body }) => {
      const index = assignments.findIndex((a) => a.id === params!.assignmentId);
      const updated = { ...assignments[index]!, ...body, updatedAt: NOW };
      assignments[index] = updated;
      return updated;
    },
    "teacher.listModules": () => ({ view: "teacher", outline }),
    "teacher.createModule": ({ body }) => {
      const module: Module = { id: next("cmod"), title: String(body!.title), published: false, items: [] };
      outline.modules.push(module);
      return changed(module);
    },
    "teacher.updateModule": ({ params, body }) => changed(Object.assign(moduleOf(params!.moduleId), body)),
    "teacher.reorderModules": ({ body }) => {
      outline.modules = (body!.moduleIds as string[]).map((id) => moduleOf(id));
      return changed(outline);
    },
    "teacher.deleteModule": ({ params }) => {
      outline.modules = outline.modules.filter((m) => m.id !== params!.moduleId);
      return changed({ deleted: true });
    },
    "teacher.addPage": ({ params, body }) => {
      const page = { id: next("cpg"), title: body!.title, body: body!.body };
      const item = { kind: "page", id: next("cit"), pageId: page.id };
      outline.pages.push(page);
      moduleOf(params!.moduleId).items.push(item);
      return changed({ page, item });
    },
    "teacher.updatePage": ({ params, body }) => changed(Object.assign(outline.pages.find((p) => p.id === params!.pageId)!, body)),
    "teacher.placeActivity": ({ params, body }) => {
      const item = { kind: "activity", id: next("cit"), activityId: body!.activityId };
      moduleOf(params!.moduleId).items.push(item);
      return changed(item);
    },
    "teacher.removeModuleItem": ({ params }) => {
      const module = moduleOf(params!.moduleId);
      module.items = module.items.filter((i) => i.id !== params!.itemId);
      return changed({ removed: true });
    },
    "teacher.reorderModuleItems": ({ params, body }) => {
      const module = moduleOf(params!.moduleId);
      module.items = (body!.itemIds as string[]).map((id) => module.items.find((i) => i.id === id)!);
      return changed(module);
    },
    "teacher.previewCartridge": () => CARTRIDGE_PREVIEW,
    "teacher.importCartridge": () => {
      const page = { id: next("cpg"), title: "Plants", body: "Plants make food." };
      const module: Module = {
        id: next("cmod"), title: "Week 1: Producers", published: false, source: { kind: "cartridge", fileName: "ecosystems.imscc", packageDigest: DIGEST },
        items: [{ kind: "page", id: next("cit"), pageId: page.id }, { kind: "link", id: next("cit"), title: "Photosynthesis", url: "https://open-lessons.example/photo" }],
      };
      outline.pages.push(page);
      outline.modules.push(module);
      return changed({ modules: [module], preview: CARTRIDGE_PREVIEW });
    },
    "teacher.gradebook": () => gradebook,
    "teacher.updateGradebookSettings": ({ body }) => {
      if (body!.revision !== gradebook.revision) {
        throw new DistrictApiError(409, { code: "conflict", message: "The gradebook settings changed while you were editing them; reload them and try again." });
      }
      gradebook.revision++;
      gradebook.settings = body!.settings as Body;
      return gradebook;
    },
    "teacher.setGradeMarker": ({ body }) => {
      const row = gradebook.rows.find((r) => r.studentPrincipalId === body!.studentPrincipalId)!;
      row.cells = row.cells.map((cell) => {
        if (cell.assignmentId !== body!.assignmentId) return cell;
        const { marker: _previous, ...rest } = cell;
        return body!.marker === null ? rest : { ...rest, marker: body!.marker };
      });
      return row;
    },
    "teacher.exportGradebookCsv": () => ({
      fileName: "english-9-period-3-gradebook.csv",
      mediaType: "text/csv",
      csv: "Student,Student ID,Persuasive paragraph (10 pts),'=Claim quiz (5 pts),Points earned,Points possible,Unweighted %,Weighted %,Final %,Letter\r\nAmara Okafor,prn_nf-student-amara,8,5,13,15,86.67,,86.67,B\r\n",
    }),
    "teacher.exportCartridge": () => ({
      fileName: "english-9-period-3.imscc",
      base64: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
      losses: outline.modules.flatMap((m) => m.items.filter((i) => i.kind === "activity").map((i) => ({ kind: "activity", module: m.id, item: i.id }))),
    }),
  };

  const client: DistrictApiClient = {
    call: (async (name: RouteName, input: Input = {}) => {
      calls.push({ name, input });
      const failure = failures[name];
      if (failure !== undefined) throw new DistrictApiError(failure.status, failure.body);
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`the fake district has no ${name} route`);
      return structuredClone(handler(input));
    }) as DistrictApiClient["call"],
  };

  return {
    client,
    calls,
    /** The calls made to `name`, in order. */
    callsTo: (name: RouteName) => calls.filter((call) => call.name === name),
    /** Makes `name` fail from now on, or succeed again with `undefined`. */
    fail: (name: RouteName, failure: { status: number; body: EducateOsErrorBody } | undefined) => {
      if (failure === undefined) delete failures[name];
      else failures[name] = failure;
    },
    /** A student turns in `text` for an assignment, against its rubric. */
    studentSubmits: (assignmentId: string, text: string, student: string = IDS.amara) => {
      const assigned = assignments.find((a) => a.id === assignmentId)!;
      const id = next("sub");
      texts.set(id, text);
      submissions.push({
        id, districtId: IDS.district, assignmentId, offeringId: IDS.offering, studentPrincipalId: student, attempt: 1,
        items: [{ artifactId: "art_essay", revisionId: "rev_essay-2", digest: DIGEST, artifactType: "document", mediaType: "text/markdown", sizeBytes: text.length, aiAssistance: { level: "none" } }],
        submissionDigest: DIGEST, ...(assigned.rubric === undefined ? {} : { rubric: assigned.rubric }), submittedAt: NOW, timing: "on-time", channel: "http",
      });
      return id;
    },
    /**
     * A student turns in several pieces of work, each saved under a title, as Learning Home saves
     * one per activity step. They are stored in canonical (artifact ID) order, as the district does.
     */
    studentSubmitsWorks: (assignmentId: string, pieces: { artifactId: string; title?: string; text: string }[]) => {
      const assigned = assignments.find((a) => a.id === assignmentId)!;
      const id = next("sub");
      const sorted = pieces.toSorted((a, b) => a.artifactId.localeCompare(b.artifactId));
      works.set(id, sorted);
      submissions.push({
        id, districtId: IDS.district, assignmentId, offeringId: IDS.offering, studentPrincipalId: IDS.amara, attempt: 1,
        items: sorted.map((piece) => ({ artifactId: piece.artifactId, revisionId: `rev_${piece.artifactId.slice(4)}`, digest: DIGEST, artifactType: "document", mediaType: "text/markdown", sizeBytes: piece.text.length, aiAssistance: { level: "none" } })),
        submissionDigest: DIGEST, ...(assigned.rubric === undefined ? {} : { rubric: assigned.rubric }), submittedAt: NOW, timing: "on-time", channel: "http",
      });
      return id;
    },
    /** The teacher approved an official grade for a submission earlier, in another session. */
    gradedEarlier: (submissionId: string, score: { points: number; maxPoints: number }) => recordGrade(submissionId, score),
    /** A step-by-step activity assigned in the class, with a rubric signed earlier. */
    assignStepActivity: (title: string, steps: { id: string; title: string; kind: "writing" | "dataset" | "none" }[], rubric?: { rubricId: string; version: number; title: string; criteria: { id: string; title: string; levels: { id: string; label: string; points: number }[]; checks: unknown[] }[] }) => {
      const activityId = next("act");
      activities.set(activityId, {
        view: "teacher", installation: { id: activityId }, evidenceContract: {},
        content: { title, steps: steps.map((s) => ({ id: s.id, title: s.title, prompt: `Do ${s.title}.`, sources: [], response: s.kind === "dataset" ? { kind: "dataset", columns: [{ name: "Sample" }] } : { kind: s.kind } })), evidence: { alignments: [] } },
      });
      if (rubric !== undefined) {
        rubrics.set(`${rubric.rubricId}@${rubric.version}`, { format: "educateos.rubric-release.v1", ...rubric, signature: { signedBy: IDS.teacher, signedAt: NOW, channel: "http", digest: DIGEST } } as never);
      }
      const created = assignment(next("asg"), activityId, title, rubric === undefined ? undefined : { rubricId: rubric.rubricId, version: rubric.version });
      assignments.push(created);
      return created.id;
    },
    /** A student turns in a file for an assignment. */
    studentSubmitsFile: (assignmentId: string, file: { mediaType: string; base64: string }) => {
      const id = next("sub");
      files.set(id, file);
      submissions.push({
        id, districtId: IDS.district, assignmentId, offeringId: IDS.offering, studentPrincipalId: IDS.amara, attempt: 1,
        items: [{ artifactId: "art_report", revisionId: "rev_report-1", digest: DIGEST, artifactType: "document", mediaType: file.mediaType, sizeBytes: file.base64.length, aiAssistance: { level: "none" } }],
        submissionDigest: DIGEST, submittedAt: NOW, timing: "on-time", channel: "http",
      });
      return id;
    },
    /** A co-teacher proposes a grade, which waits for the lead teacher. */
    propose: (submissionId: string, score: { points: number; maxPoints: number }) => {
      const submission = submissions.find((s) => s.id === submissionId)!;
      const proposal: Body = {
        id: next("gpr"), assignmentId: submission.assignmentId, studentPrincipalId: submission.studentPrincipalId, submissionId,
        score, proposedBy: "prn_nf-teacher-chen", proposedVia: "http", proposedAt: NOW,
      };
      proposals.push(proposal);
      return String(proposal.id);
    },
    /** Puts a suggested score on a submission's feedback, as an AI model or an evaluator would. */
    suggest: (submissionId: string, score: { criterionId: string; points: number; maxPoints: number; suggester: { kind: "ai"; modelId: string } | { kind: "evaluator"; evaluatorId: string } }) => {
      feedbackFor(submissionId).scores.push({
        criterionId: score.criterionId, points: score.points, maxPoints: score.maxPoints,
        source: { kind: "suggested", suggester: score.suggester }, enteredBy: IDS.teacher, enteredAt: NOW,
      });
    },
    /** Signs a rubric directly, as an earlier session would have. */
    rubricFor: (key: string) => rubrics.get(key),
    assignments,
    outline,
    gradebook,
  };
};

/** A fake district. */
export type FakeDistrict = ReturnType<typeof fakeDistrict>;
