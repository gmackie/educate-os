// Seeds a district with the K-12 showcase (SCHO-322) through its typed HTTP API alone, as its people
// would make it: the administrator approves standards and confirms guardians, each teacher builds
// their class, each student does their work, and each teacher grades it. Every call goes through a
// `DistrictApiClient` from `actAs`, so the same seeder runs in-process (the harness, the in-browser
// demo) and over HTTP against a live district. It only adds: a rerun finds what exists (by title
// within a class) and makes only what is missing, and nothing is ever changed or deleted.
import type { DistrictApiClient, RouteResponse } from "@educateos/api-client";
import type { GuardianRelationship, PrincipalId } from "@educateos/contracts";
import type { TemplateInput } from "@educateos/curriculum";
import {
  SHOWCASE_BANDS,
  rubricMaxPoints,
  type Showcase,
  type ShowcaseActivity,
  type ShowcaseBand,
  type ShowcaseCourse,
  type ShowcaseQuiz,
  type ShowcaseResource,
  type ShowcaseWork,
} from "@educateos/fixtures";

/** What one showcase run made in one grade band. A rerun over a seeded district makes nothing. */
export interface ShowcaseBandSummary {
  /** The band's classes the run worked through (made or found). */
  courses: number;
  modules: number;
  pages: number;
  activities: number;
  quizzes: number;
  quizAttempts: number;
  discussions: number;
  posts: number;
  announcements: number;
  weeklyNotes: number;
  /** Work saved in a class workspace and not submitted. */
  drafts: number;
  submissions: number;
  /** Submissions the teacher commented on and scored. */
  feedback: number;
  /** Official grades recorded, for activities and released quiz scores. */
  grades: number;
  /** Feedback released to students. */
  releases: number;
}

/** What {@link seedShowcase} made. */
export interface ShowcaseSummary {
  standardsApproved: number;
  guardiansConfirmed: number;
  resourcesImported: number;
  bands: Record<ShowcaseBand, ShowcaseBandSummary>;
  /** Everything the run made, across bands; 0 when it found the showcase already in place. */
  created: number;
  /** Activities left out because they need a reading the run was given no URL for. */
  skipped: string[];
}

/** How {@link seedShowcase} reaches the district and what it seeds. */
export interface SeedShowcaseOptions {
  /** The content, such as `NORTHFIELD_SHOWCASE`. */
  showcase: Showcase;
  /** The district administrator who approves standards and confirms guardians. */
  adminId: PrincipalId;
  /** A client signed in as `principalId`. Called once per person per run. */
  actAs: (principalId: PrincipalId) => DistrictApiClient | Promise<DistrictApiClient>;
  /**
   * The guardian relationships to set up, such as `NORTHFIELD_GUARDIANS`: each guardian is invited
   * for their child, redeems the invitation, and is confirmed. Their display names come from
   * `guardianNames`, keyed by principal ID.
   */
  guardians?: readonly GuardianRelationship[];
  /** Each guardian's display name, for the invitation. Defaults to "Guardian". */
  guardianNames?: Readonly<Record<string, string>>;
  /**
   * Where the district can fetch a showcase reading from, or undefined to import none. A class's
   * teacher imports and approves each reading their activities use; an activity that needs one it
   * cannot have (a primary-source analysis) is skipped.
   */
  resourceUrl?: (resource: ShowcaseResource) => string | undefined;
}

type Writable<T> = T extends readonly (infer U)[] ? Writable<U>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T;
const writable = <T>(value: T): Writable<T> => structuredClone(value) as Writable<T>;

const emptyBand = (): ShowcaseBandSummary => ({
  courses: 0, modules: 0, pages: 0, activities: 0, quizzes: 0, quizAttempts: 0, discussions: 0, posts: 0,
  announcements: 0, weeklyNotes: 0, drafts: 0, submissions: 0, feedback: 0, grades: 0, releases: 0,
});

/**
 * Seeds the showcase through the district's API. Idempotent: run it again, against the same
 * district or a live one already seeded, and it makes only what is missing. Returns what it made.
 *
 * @throws DistrictApiError for any call the district refuses, and Error for showcase content that
 *   names a standard the district does not offer the class.
 */
export async function seedShowcase(options: SeedShowcaseOptions): Promise<ShowcaseSummary> {
  const { showcase } = options;
  const clients = new Map<string, Promise<DistrictApiClient>>();
  const as = (id: string): Promise<DistrictApiClient> => {
    let client = clients.get(id);
    if (client === undefined) {
      client = Promise.resolve(options.actAs(id as PrincipalId));
      clients.set(id, client);
    }
    return client;
  };
  const summary: ShowcaseSummary = {
    standardsApproved: 0,
    guardiansConfirmed: 0,
    resourcesImported: 0,
    bands: Object.fromEntries(SHOWCASE_BANDS.map((band) => [band, emptyBand()])) as Record<ShowcaseBand, ShowcaseBandSummary>,
    created: 0,
    skipped: [],
  };

  const admin = await as(options.adminId);
  const frameworks = new Set(showcase.courses.flatMap((c) => c.activities.flatMap((a) => a.standards.map((s) => s.framework))));
  const listed = await admin.call("admin.listStandards");
  for (const framework of frameworks) {
    if (listed.find((s) => s.frameworkKey === framework)?.status === "approved") continue;
    await admin.call("admin.approveStandards", { params: { frameworkKey: framework } });
    summary.standardsApproved++;
  }

  for (const relationship of options.guardians ?? []) {
    if (await confirmGuardian(admin, await as(relationship.guardianPrincipalId), relationship, options.guardianNames?.[relationship.guardianPrincipalId] ?? "Guardian")) {
      summary.guardiansConfirmed++;
    }
  }

  for (const course of showcase.courses) {
    await seedCourse(course, showcase, options, as, summary);
  }

  const counts = Object.values(summary.bands).flatMap(({ courses: _, ...made }) => Object.values(made));
  summary.created = summary.standardsApproved + summary.guardiansConfirmed + summary.resourcesImported + counts.reduce((a, b) => a + b, 0);
  return summary;
}

/**
 * Sets up one guardian relationship the way a district does (ADR-0012): the administrator invites,
 * the guardian (already in the directory) redeems and so joins, and the administrator confirms.
 * Returns whether it confirmed one; an active relationship is left as it is.
 */
async function confirmGuardian(admin: DistrictApiClient, guardian: DistrictApiClient, wanted: GuardianRelationship, guardianDisplayName: string): Promise<boolean> {
  const params = { studentId: wanted.studentPrincipalId };
  const existing = (await admin.call("admin.studentGuardians", { params })).relationships
    .map((r) => r.relationship)
    .find((r) => r.guardianPrincipalId === wanted.guardianPrincipalId && r.status !== "revoked");
  if (existing?.status === "active") return false;
  let relationshipId = existing?.id;
  if (relationshipId === undefined) {
    const invited = await admin.call("admin.inviteGuardian", { params, body: { guardianDisplayName } });
    const token = new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation");
    if (token === null) throw new Error("the district's invitation link carries no token");
    await guardian.call("onboarding.redeemGuardianInvitation", { body: { token } });
    relationshipId = invited.relationship.id;
  }
  await admin.call("admin.confirmGuardian", { params: { relationshipId } });
  return true;
}

type Client = (id: string) => Promise<DistrictApiClient>;

async function seedCourse(course: ShowcaseCourse, showcase: Showcase, options: SeedShowcaseOptions, as: Client, summary: ShowcaseSummary): Promise<void> {
  const counts = summary.bands[course.band];
  counts.courses++;
  const teacher = await as(course.teacherId);
  const params = { offeringId: course.offeringId };
  const teaching = (await teacher.call("teacher.listOfferings")).find((t) => t.offering.id === course.offeringId);
  if (teaching === undefined) throw new Error(`${course.teacherId} does not teach ${course.offeringId}`);

  // Readings, imported and approved once per class.
  const releases = await teacher.call("teacher.listReleases", { params });
  const readings = new Map<string, { resourceId: string; version: string }>();
  for (const key of new Set(course.activities.flatMap((a) => a.resources ?? []))) {
    const resource = showcase.resources.find((r) => r.key === key);
    if (resource === undefined) throw new Error(`the showcase has no reading ${key}`);
    const found = releases.find((r) => r.descriptor.title === resource.title);
    if (found !== undefined) {
      readings.set(key, { resourceId: found.descriptor.id, version: found.descriptor.release.version });
      continue;
    }
    const url = options.resourceUrl?.(resource);
    if (url === undefined) continue;
    const item = await teacher.call("teacher.importResource", { params, body: { url } });
    const release = await teacher.call("teacher.approveResource", { params: { itemId: item.id }, body: {} });
    readings.set(key, { resourceId: release.descriptor.id, version: release.descriptor.release.version });
    summary.resourcesImported++;
  }

  // Activities, found by their assignment's title.
  const goals = (await teacher.call("teacher.learningGoals", { params })).goals;
  const assignments = await teacher.call("teacher.listAssignments", { params });
  const installed = new Map<string, Pick<RouteResponse<"teacher.listAssignments">[number], "id" | "activityId">>();
  for (const activity of course.activities) {
    const existing = assignments.find((a) => a.title === activity.title);
    if (existing !== undefined) {
      installed.set(activity.key, existing);
      continue;
    }
    const resources = (activity.resources ?? []).flatMap((key) => readings.get(key) ?? []);
    if (activity.template === "primary-source-analysis" && resources.length === 0) {
      summary.skipped.push(`${course.offeringId}: ${activity.title}`);
      continue;
    }
    const alignments = activity.standards.map(({ framework, code }) => {
      const goal = goals.find((g) => g.frameworkKey === framework && g.code === code);
      if (goal === undefined) throw new Error(`${course.offeringId} is not offered ${framework} ${code}; is the framework approved and the code real?`);
      return { frameworkKey: goal.frameworkKey, competencyUri: goal.competencyUri };
    });
    const rubric = await teacher.call("teacher.signRubric", {
      params,
      body: { rubric: { rubricId: activity.rubric.rubricId, version: 1, title: activity.rubric.title, criteria: activity.rubric.criteria.map((c) => ({ ...writable(c), checks: [] })) } },
    });
    const draft = await teacher.call("teacher.createActivity", { params, body: { activity: templateInput(activity, teaching.course, resources, alignments) } });
    await teacher.call("teacher.publishActivity", { params: { definitionId: draft.id } });
    const { assignment } = await teacher.call("teacher.installActivity", {
      params: { definitionId: draft.id },
      body: { offeringId: course.offeringId, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
    });
    installed.set(activity.key, assignment);
    counts.activities++;
  }

  // Modules: an intro page, then the activities; quizzes and discussions are placed as they are made.
  const outline = (await teacher.call("teacher.listModules", { params })).outline;
  const moduleIds = new Map<string, string>();
  for (const module of course.modules) {
    let current = outline.modules.find((m) => m.title === module.title);
    if (current === undefined) {
      current = await teacher.call("teacher.createModule", { params, body: { title: module.title } });
      counts.modules++;
    }
    const moduleParams = { ...params, moduleId: current.id };
    const pageIds = new Set(current.items.flatMap((i) => (i.kind === "page" ? [i.pageId] : [])));
    if (!outline.pages.some((p) => pageIds.has(p.id) && p.title === module.page.title)) {
      await teacher.call("teacher.addPage", { params: moduleParams, body: { title: module.page.title, body: module.page.body } });
      counts.pages++;
    }
    const placed = new Set(current.items.flatMap((i) => (i.kind === "activity" ? [i.activityId] : [])));
    for (const item of module.items) {
      const activity = item.kind === "activity" ? installed.get(item.key) : undefined;
      if (activity === undefined || placed.has(activity.activityId)) continue;
      await teacher.call("teacher.placeActivity", { params: moduleParams, body: { activityId: activity.activityId } });
    }
    if (!current.published) await teacher.call("teacher.updateModule", { params: moduleParams, body: { published: true } });
    for (const item of module.items) moduleIds.set(`${item.kind}:${item.key}`, current.id);
  }

  for (const quiz of course.quizzes) await seedQuiz(course, quiz, moduleIds.get(`quiz:${quiz.key}`), teacher, as, counts);

  const topics = (await teacher.call("teacher.listDiscussions", { params })).topics;
  for (const discussion of course.discussions) {
    if (topics.some((t) => t.topic.title === discussion.title)) continue;
    const moduleId = moduleIds.get(`discussion:${discussion.key}`);
    const topic = await teacher.call("teacher.createTopic", {
      params,
      body: { title: discussion.title, prompt: discussion.prompt, ...(moduleId === undefined ? {} : { moduleId }) },
    });
    counts.discussions++;
    const postIds: string[] = [];
    for (const post of discussion.posts) {
      const parent = post.replyTo === undefined ? {} : { parentId: postIds[post.replyTo]! };
      const postParams = { ...params, topicId: topic.id };
      const body = { body: post.body, ...parent };
      const made = post.author === course.teacherId
        ? await teacher.call("teacher.createPost", { params: postParams, body })
        : await (await as(post.author)).call("student.createPost", { params: postParams, body });
      postIds.push(made.id);
      counts.posts++;
    }
  }

  const announcements = await teacher.call("teacher.listAnnouncements", { params });
  for (const announcement of course.announcements) {
    if (announcements.some((a) => a.announcement.title === announcement.title)) continue;
    await teacher.call("teacher.createAnnouncement", { params, body: announcement });
    counts.announcements++;
  }
  if ((await teacher.call("teacher.weeklyNote", { params, query: {} })).note === null) {
    await teacher.call("teacher.setWeeklyNote", { params, body: { text: course.weeklyNote } });
    counts.weeklyNotes++;
  }

  for (const activity of course.activities) {
    const target = installed.get(activity.key);
    if (target === undefined) continue;
    for (const [studentId, work] of Object.entries(activity.work)) {
      await seedWork(course, activity, target.id, studentId, work, teacher, await as(studentId), counts);
    }
  }
}

/** A template's inputs for an activity, in its class's subject and grade band. */
function templateInput(
  activity: ShowcaseActivity,
  course: { subject: TemplateInput["subject"]; gradeBand: string },
  resources: { resourceId: string; version: string }[],
  alignments: { frameworkKey: string; competencyUri: string }[],
): TemplateInput {
  const common = {
    title: activity.title,
    subject: course.subject,
    gradeBand: course.gradeBand,
    overview: activity.overview,
    resources,
    codex: resources.map((resource) => ({ kind: "resource" as const, resource, visibility: "students" as const })),
    alignments,
    aiHelp: activity.aiHelp,
    due: { kind: "after-install" as const, days: activity.dueInDays },
  };
  switch (activity.template) {
    case "writing-task":
      return {
        ...common, template: activity.template, prompt: activity.prompt, genre: activity.genre, minimumCitations: activity.minimumCitations,
        ...(activity.minWords === undefined ? {} : { minWords: activity.minWords }),
      };
    case "science-investigation":
      return {
        ...common, template: activity.template, question: activity.question, methodPrompt: activity.methodPrompt,
        dataColumns: writable(activity.dataColumns), analysisPrompt: activity.analysisPrompt,
      };
    case "primary-source-analysis":
      return {
        ...common, template: activity.template, sources: resources, sourcingQuestions: [...activity.sourcingQuestions],
        contextualizationQuestions: [...activity.contextualizationQuestions], claimPrompt: activity.claimPrompt, minimumEvidence: activity.minimumEvidence,
      };
    case "problem-set":
      return { ...common, template: activity.template, problems: writable(activity.problems), showWork: activity.showWork };
  }
}

/**
 * One student's work on one activity, taken to its scripted stage: saved, submitted, then (by the
 * teacher) commented on and scored, then graded officially and released.
 */
async function seedWork(
  course: ShowcaseCourse,
  activity: ShowcaseActivity,
  assignmentId: string,
  studentId: string,
  work: ShowcaseWork,
  teacher: DistrictApiClient,
  student: DistrictApiClient,
  counts: ShowcaseBandSummary,
): Promise<void> {
  if (work.stage === "not-started") return;
  const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId: course.offeringId } });
  const save = () => student.call("student.createArtifact", {
    body: { workspaceId: workspace.id, type: "document", title: activity.title, content: { kind: "text", mediaType: "text/markdown", text: work.text } },
  });
  if (work.stage === "draft") {
    const artifacts = await student.call("student.listArtifacts", { params: { workspaceId: workspace.id } });
    if (artifacts.some((a) => a.artifact.title === activity.title)) return;
    await save();
    counts.drafts++;
    return;
  }

  let [submission] = await student.call("student.listSubmissions", { params: { assignmentId } });
  if (submission === undefined) {
    const { artifact, head } = await save();
    await student.call("student.submit", { params: { assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
    [submission] = await student.call("student.listSubmissions", { params: { assignmentId } });
    counts.submissions++;
  }
  if ((work.stage !== "graded" && work.stage !== "released") || submission === undefined) return;

  const submissionId = submission.id;
  const feedback = await teacher.call("teacher.getFeedback", { params: { submissionId } });
  let gave = false;
  if (feedback.comments.length === 0) {
    await teacher.call("teacher.addComment", { params: { submissionId }, body: { body: work.comment } });
    gave = true;
  }
  for (const criterion of activity.rubric.criteria) {
    if (feedback.scores.some((s) => s.criterionId === criterion.id && s.source.kind === "teacher")) continue;
    const maxPoints = Math.max(...criterion.levels.map((l) => l.points));
    await teacher.call("teacher.scoreCriterion", { params: { submissionId }, body: { criterionId: criterion.id, points: work.scores[criterion.id]!, maxPoints } });
    gave = true;
  }
  if (gave) counts.feedback++;
  if (work.stage !== "released") return;

  const grades = await teacher.call("teacher.officialGrades", { params: { assignmentId, studentId } });
  if (grades.length === 0) {
    const points = Object.values(work.scores).reduce((a, b) => a + b, 0);
    const recorded = await teacher.call("teacher.recordGrade", { params: { submissionId }, body: { score: { points, maxPoints: rubricMaxPoints(activity.rubric) } } });
    if (recorded.status === "pending-approval") await teacher.call("teacher.approveGrade", { params: { proposalId: recorded.proposal.id } });
    counts.grades++;
  }
  if (feedback.state === "draft") {
    await teacher.call("teacher.releaseFeedback", { params: { submissionId }, body: { state: "shared-with-student" } });
    counts.releases++;
  }
}

/** A quiz, published into its module, taken by the students who took it, graded and (if scripted) released. */
async function seedQuiz(
  course: ShowcaseCourse,
  quiz: ShowcaseQuiz,
  moduleId: string | undefined,
  teacher: DistrictApiClient,
  as: Client,
  counts: ShowcaseBandSummary,
): Promise<void> {
  const params = { offeringId: course.offeringId };
  let made = (await teacher.call("teacher.listQuizzes", { params })).quizzes.find((q) => q.quiz.title === quiz.title)?.quiz;
  if (made === undefined) {
    made = await teacher.call("teacher.createQuiz", {
      params,
      body: {
        title: quiz.title,
        description: quiz.description,
        ...(moduleId === undefined ? {} : { moduleId }),
        items: writable(quiz.items),
        settings: { attemptsAllowed: 2, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" },
      },
    });
    counts.quizzes++;
  }
  if (made.status !== "published") await teacher.call("teacher.publishQuiz", { params: { ...params, quizId: made.id }, body: { published: true } });
  const itemIds = made.items.map((i) => i.id);

  for (const [studentId, answers] of Object.entries(quiz.attempts)) {
    const student = await as(studentId);
    const view = (await student.call("student.listQuizzes", { params })).find((q) => q.id === made.id);
    let attemptId = view?.attempts.find((a) => a.status === "submitted")?.id;
    if (attemptId === undefined) {
      const attempt = view?.attempts.find((a) => a.status === "in-progress")?.id
        ?? (await student.call("student.startQuizAttempt", { params: { ...params, quizId: made.id } })).attemptId;
      const responses = answers.map((answer, index) => {
        const { points: _, ...response } = answer as typeof answer & { points?: number };
        return { itemId: itemIds[index]!, response: writable(response) };
      });
      await student.call("student.submitQuizAttempt", { params: { ...params, attemptId: attempt }, body: { answers: responses } });
      attemptId = attempt;
      counts.quizAttempts++;
    }
    // Essays wait for the teacher.
    const staff = await teacher.call("teacher.quizAttempt", { params: { ...params, attemptId } });
    for (const [index, answer] of answers.entries()) {
      if (answer.type !== "essay") continue;
      const score = staff.attempt.itemScores?.find((s) => s.itemId === itemIds[index]);
      if (score === undefined || score.points !== null) continue;
      await teacher.call("teacher.gradeQuizItem", { params: { ...params, attemptId, itemId: itemIds[index]! }, body: { points: answer.points } });
    }
  }

  if (quiz.releaseScores) {
    const results: RouteResponse<"teacher.quizResults"> = await teacher.call("teacher.quizResults", { params: { ...params, quizId: made.id } });
    if (results.releasable > 0) {
      const outcome = await teacher.call("teacher.releaseQuizScores", { params: { ...params, quizId: made.id } });
      counts.grades += outcome.official;
    }
  }
}
