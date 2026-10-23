// A fake district behind the typed API client, for the Teacher Studio tests. It keeps just enough
// state to follow a class from importing a resource to an official grade, records every call, and
// can be told to fail a route. Synthetic data only.
import { DistrictApiError, type DistrictApiClient, type RouteName } from "@schoolos/api-client";

type SchoolOsErrorBody = ConstructorParameters<typeof DistrictApiError>[1];

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
  existingAssignment: "asg_persuasive-paragraph",
  existingActivity: "act_persuasive-paragraph",
} as const;

/** The learning goal the class's existing activity uses. */
export const GOAL = { frameworkKey: "ccss-ela", competencyUri: "urn:schoolos:catalog:ccss-ela:W.9-10.1" };

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
  failures?: Partial<Record<RouteName, { status: number; body: SchoolOsErrorBody }>>;
  /** Classes the teacher teaches. Defaults to English 9, Period 3. */
  offerings?: unknown[];
  /** The most AI help the district allows; asking for more is refused. */
  maxAiHelp?: "none" | "hints-only" | "full";
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
    content: { title: "Persuasive paragraph", evidence: { alignments: [GOAL] } },
    evidenceContract: {},
  }]]);
  const assignments: ReturnType<typeof assignment>[] = [assignment(IDS.existingAssignment, IDS.existingActivity, "Persuasive paragraph")];
  const submissions: Body[] = [];
  const texts = new Map<string, string>();
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

  const handlers: Partial<Record<RouteName, (input: Input) => unknown>> = {
    "me.get": () => ({ principalId: IDS.teacher, districtId: IDS.district, kind: "staff", displayName: "Sam Rivera", roles: [], enrollments: [] }),
    "teacher.listOfferings": () => options.offerings ?? [OFFERING],
    "teacher.roster": () => ROSTER,
    "teacher.listAssignments": () => assignments,
    "teacher.getActivity": ({ params }) => activities.get(params!.activityId!),
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
      const release = { format: "schoolos.rubric-release.v1", ...rubric, signature: { signedBy: IDS.teacher, signedAt: NOW, channel: "http", digest: DIGEST } };
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
          steps: [{ id: "draft", title: "Draft", prompt: String(activity.prompt ?? "Do the work."), sources: [], response: { kind: "writing" } }],
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
    "teacher.listSubmissions": ({ params }) => submissions.filter((s) => s.assignmentId === params!.assignmentId),
    "teacher.submittedContent": ({ params }) => {
      const submission = submissions.find((s) => s.id === params!.submissionId)! as { items: Body[] };
      const file = files.get(params!.submissionId!);
      return { item: submission.items[0], content: file === undefined ? { kind: "text", text: texts.get(params!.submissionId!) } : { kind: "bytes", base64: file.base64 } };
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
    "teacher.recordGrade": ({ params, body }) => {
      const submission = submissions.find((s) => s.id === params!.submissionId)!;
      return {
        status: "official",
        version: {
          format: "schoolos.official-grade.v1", districtId: IDS.district, offeringId: IDS.offering, assignmentId: submission.assignmentId,
          studentPrincipalId: submission.studentPrincipalId, submissionId: submission.id, submissionDigest: DIGEST, version: 1,
          score: body!.score, approval: { approvedBy: IDS.teacher, approvedAt: NOW, channel: "http" },
        },
      };
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
    fail: (name: RouteName, failure: { status: number; body: SchoolOsErrorBody } | undefined) => {
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
  };
};

/** A fake district. */
export type FakeDistrict = ReturnType<typeof fakeDistrict>;
