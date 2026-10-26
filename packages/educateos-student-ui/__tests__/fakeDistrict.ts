// A scripted district for the UI tests: the student routes over in-memory state built from
// synthetic `.example` data, with a hook to make the next call to a route fail and a log of calls.
// It answers the way the district does where the UI depends on it: feedback is not-found until the
// teacher releases it (and an assignment's released feedback an empty list), and a finished class's
// work can be kept only once the term has closed.
import { DistrictApiError, type DistrictApiClient, type RouteInput, type RouteName, type RouteResponse } from "@educateos/api-client";

const NOW = "2026-10-20T15:00:00.000Z";
const DISTRICT = "dst_northfield";
const ME = "prn_nf-student-amara";

/** Offerings in the fake district. */
export const ENGLISH = "off_nf-eng9-fall-p3";
export const SCIENCE = "off_nf-bio-fall-p1";
export const ART_SPRING = "off_nf-art-spring-p2";

/** Assignments in the fake district. */
export const ESSAY = "asg_essay-later-start";
export const OSMOSIS = "asg_osmosis-lab";
export const COLOR = "asg_color-painting";
export const LAB_REPORT = "asg_osmosis-report";

const notFound = (what: string) => new DistrictApiError(404, { code: "not-found", message: `${what} not found` });

type Handlers = { [N in RouteName]?: (input: RouteInput<N>) => unknown };

const step = (id: string, title: string, prompt: string, response: object) => ({ id, title, prompt, sources: [], response });

const activity = (offeringId: string, assignmentId: string, title: string, dueAt: string, subject: string, steps: object[], aiHelp = "hints-only") => ({
  assignment: {
    id: assignmentId,
    districtId: DISTRICT,
    offeringId,
    activityId: `act_${assignmentId.slice(4)}`,
    title,
    dueAt,
    latePolicy: { kind: "accept" },
    attemptsAllowed: 3,
    permittedArtifactTypes: ["document", "dataset"],
    feedbackVisibility: "when-shared",
    createdBy: "prn_nf-teacher-rivera",
    createdAt: NOW,
    updatedAt: NOW,
  },
  activity: {
    view: "student",
    installation: {
      id: `act_${assignmentId.slice(4)}`,
      scope: { level: "offering", districtId: DISTRICT, offeringId },
      termId: "trm_fall",
      definitionId: "adf_demo",
      definitionVersion: 1,
      aiHelp,
      installedBy: "prn_nf-teacher-rivera",
      installedAt: NOW,
      codex: { collectionKey: "codex", revision: 1 },
    },
    content: {
      template: "writing-task",
      title,
      subject,
      gradeBand: "9-12",
      overview: `Overview of ${title}.`,
      steps,
      resources: [{ resourceId: "res_reading-1", version: "1.0.0" }],
      codex: [{ kind: "note", id: "context", title: "Before you start", body: "Read the article first.", purpose: "context", visibility: "students" }],
      rubricSlots: [],
      aiHelp,
      permittedArtifactTypes: ["document", "dataset"],
      due: { kind: "none" },
      evidence: {},
    },
    evidenceContract: {},
  },
});

interface StoredArtifact {
  artifact: Record<string, unknown> & { id: string; workspaceId: string; title: string; type: string };
  revisions: (Record<string, unknown> & { id: string; number: number; mediaType: string; createdAt: string })[];
  contents: Map<string, unknown>;
}

/**
 * A failure to inject: a district error by code, or a network failure. An `unauthenticated` one with
 * `unlinkedSignIn` is a sign-in that verified but that the school has not added.
 */
export type InjectedFailure =
  | { code: "unavailable" | "conflict" | "forbidden"; message?: string }
  | { code: "unauthenticated"; message?: string; unlinkedSignIn?: { issuer: string; subject: string; awaitingApproval?: true } }
  | "network";

const STATUS: Record<Exclude<InjectedFailure, "network">["code"], number> = { unavailable: 503, conflict: 409, forbidden: 403, unauthenticated: 401 };

/** The fake district and its controls. */
export interface FakeDistrict extends DistrictApiClient {
  /** Every call made, by route name. */
  calls: { name: RouteName; input: unknown }[];
  /** Makes the next call to `name` fail. */
  failNext(name: RouteName, failure: InjectedFailure): void;
  /** Releases teacher feedback on a submission, as the teacher's "share with student" does. */
  releaseFeedback(submissionId: string, feedback: { comments: (string | { body: string; anchor: { artifactId: string; revisionId: string; start: number; end: number } })[]; scores: { criterionId: string; points: number; maxPoints?: number }[] }): void;
  /** Lets the district send email, or not (SCHO-222). */
  setEmailEnabled(enabled: boolean): void;
  /** Adds a saved artifact directly, as if made earlier. */
  addArtifact(workspaceId: string, title: string, type: string, mediaType: string, content: unknown): string;
  /** Records an official grade version for an assignment, as the teacher's approval does. */
  recordGrade(assignmentId: string, score: { points: number; maxPoints: number }): void;
  /** Marks one of the student's assignments in the teacher's gradebook (SCHO-187). */
  markAssignment(assignmentId: string, marker: "excused" | "missing" | "late"): void;
  /** The submissions made so far. */
  submissions: { id: string; assignmentId: string; submissionDigest: string }[];
}

/** A Northfield student with an English and a science class this term and a finished art class. */
export function fakeDistrict(options: {
  aiHelp?: "full" | "hints-only" | "none";
  modules?: Record<string, unknown>;
  /** Whether English has posted its library announcement (SCHO-189). */
  announcements?: boolean;
} = {}): FakeDistrict {
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, "0")}`;
  const time = () => new Date(Date.parse(NOW) + counter * 60_000).toISOString();

  const workspaces: Record<string, unknown>[] = [
    { kind: "personal", id: "wsp_amara-personal", districtId: DISTRICT, ownerPrincipalId: ME, createdAt: NOW, lifecycle: "active" },
    { kind: "course", id: "wsp_amara-eng9", districtId: DISTRICT, ownerPrincipalId: ME, createdAt: NOW, schoolId: "sch_nf-high", offeringId: ENGLISH, termId: "trm_fall", lifecycle: "active" },
    { kind: "course", id: "wsp_amara-art", districtId: DISTRICT, ownerPrincipalId: ME, createdAt: NOW, schoolId: "sch_nf-high", offeringId: ART_SPRING, termId: "trm_spring", lifecycle: "retained" },
  ];
  const activities: Record<string, ReturnType<typeof activity>[]> = {
    [ENGLISH]: [activity(ENGLISH, ESSAY, "Should the school day start later?", "2026-11-03T21:00:00.000Z", "english-language-arts", [
      step("read", "Read the article", "Read the article about sleep.", { kind: "none" }),
      step("draft", "Draft your argument", "Take a position and support it.", { kind: "writing" }),
    ], options.aiHelp)],
    [SCIENCE]: [activity(SCIENCE, OSMOSIS, "Osmosis in potato cores", "2026-11-05T21:00:00.000Z", "science", [
      step("hypothesis", "Your hypothesis", "What do you expect to happen?", { kind: "writing" }),
      step("data", "Record your data", "Weigh each core before and after.", { kind: "dataset", columns: [{ name: "Concentration", unit: "M" }, { name: "Mass change", unit: "%" }] }),
    ], options.aiHelp), activity(SCIENCE, LAB_REPORT, "Osmosis lab report", "2026-11-12T21:00:00.000Z", "science", [
      step("report", "Upload your lab report", "Upload your report as a PDF or a text file.", { kind: "artifact", artifactType: "document" }),
    ], options.aiHelp)],
    [ART_SPRING]: [activity(ART_SPRING, COLOR, "Color in a painting you love", "2026-04-01T21:00:00.000Z", "arts", [
      step("essay", "Describe the colors", "How does color shape the mood?", { kind: "writing" }),
    ], options.aiHelp)],
  };
  const artifacts = new Map<string, StoredArtifact>();
  const submissions: (Record<string, unknown> & { id: string; assignmentId: string; submissionDigest: string; attempt: number })[] = [];
  const feedback = new Map<string, unknown>();
  const grades: (Record<string, unknown> & { assignmentId: string })[] = [];
  const markers = new Map<string, "excused" | "missing" | "late">();
  // The gradebook's default settings: points earned over points possible, letters from A at 90%.
  const gradeSummary = (offeringId: string) => {
    const assigned = (activities[offeringId] ?? []).map((a) => a.assignment);
    const latest = (assignmentId: string) => grades.filter((g) => g.assignmentId === assignmentId).at(-1) as { score: { points: number; maxPoints: number }; version: number } | undefined;
    const cells = assigned.map((a) => {
      const grade = latest(a.id);
      const marker = markers.get(a.id);
      const counted = grade !== undefined && marker !== "excused";
      return {
        assignmentId: a.id,
        ...(grade === undefined ? {} : { score: grade.score, version: grade.version }),
        ...(marker === undefined ? {} : { marker }),
        percent: grade === undefined ? null : (grade.score.points / grade.score.maxPoints) * 100,
        counted,
        dropped: false,
      };
    });
    const earned = cells.reduce((sum, c) => sum + (c.counted ? c.score!.points : 0), 0);
    const possible = cells.reduce((sum, c) => sum + (c.counted ? c.score!.maxPoints : 0), 0);
    const final = possible === 0 ? null : Math.round((earned / possible) * 10_000) / 100;
    const letter = final === null ? null : final >= 90 ? "A" : final >= 80 ? "B" : final >= 70 ? "C" : final >= 60 ? "D" : "F";
    return {
      offeringId,
      settings: { weighting: "none", calculation: "points", missing: "zero", groups: [], scale: [{ letter: "A", minPercent: 90 }, { letter: "F", minPercent: 0 }] },
      columns: assigned.map((a) => ({ offeringId, assignmentId: a.id, title: a.title, dueAt: a.dueAt, pointsPossible: latest(a.id)?.score.maxPoints ?? null })),
      row: {
        studentPrincipalId: ME,
        displayName: "Amara Okafor",
        cells,
        groups: [],
        totals: { points: { earned, possible }, unweighted: final, weighted: null, final, letter },
      },
    };
  };
  const failures = new Map<RouteName, InjectedFailure>();
  const calls: FakeDistrict["calls"] = [];

  const view = (stored: StoredArtifact) => ({ artifact: stored.artifact, head: stored.revisions.at(-1)! });
  const saveRevision = (stored: StoredArtifact, content: { kind: string; mediaType?: string; text?: string; url?: string; base64?: string }) => {
    const revision = {
      id: next("rev"),
      artifactId: stored.artifact.id,
      number: stored.revisions.length + 1,
      content: { backend: "text", key: "k", digest: `sha256:${"a".repeat(64)}` },
      sizeBytes: (content.text ?? content.url ?? content.base64 ?? "").length,
      mediaType: content.kind === "external" ? "application/vnd.educateos.external-ref+json" : content.mediaType!,
      authorPrincipalId: ME,
      createdAt: time(),
      aiAssistance: { level: "none" },
      provenance: { origin: "authored", channel: "ui" },
    };
    stored.revisions.push(revision);
    stored.contents.set(revision.id, content.kind === "external" ? { kind: "external", url: content.url } : content.kind === "bytes" ? { kind: "bytes", base64: content.base64 } : { kind: "text", text: content.text });
    return view(stored);
  };
  const addArtifact = (workspaceId: string, title: string, type: string, mediaType: string, content: unknown) => {
    const id = next("art");
    const stored: StoredArtifact = {
      artifact: { id, districtId: DISTRICT, workspaceId, ownerPrincipalId: ME, type, title, classification: "course", scope: { level: "district", districtId: DISTRICT }, createdAt: time() },
      revisions: [],
      contents: new Map(),
    };
    artifacts.set(id, stored);
    const revision = { id: next("rev"), artifactId: id, number: 1, content: { backend: "text", key: "k", digest: `sha256:${"b".repeat(64)}` }, sizeBytes: 1, mediaType, authorPrincipalId: ME, createdAt: time(), aiAssistance: { level: "none" }, provenance: { origin: "authored", channel: "ui" } };
    stored.revisions.push(revision);
    stored.contents.set(revision.id, content);
    return id;
  };
  const artifact = (id: string) => {
    const stored = artifacts.get(id);
    if (stored === undefined) throw notFound("artifact");
    return stored;
  };

  // Communication (SCHO-189): one English announcement, two notifications, a calendar, preferences
  // and a calendar feed whose token is kept only as the path it was last shown at.
  const ANNOUNCEMENT = {
    announcement: {
      id: "ann_library", districtId: DISTRICT, offeringId: ENGLISH, title: "Library visit <Friday>", body: "Bring your card.\nWe meet at the door.",
      publishAt: "2026-10-19T13:00:00.000Z", created: { by: "prn_nf-teacher-rivera", at: "2026-10-19T13:00:00.000Z" },
    },
    courseLabel: "English 9 · Period 3",
    published: true,
  };
  const notifications: (Record<string, unknown> & { id: string; readAt?: string })[] = [
    { id: `ntf_${"1".repeat(32)}`, principalId: ME, kind: "announcement", offeringId: ENGLISH, title: "New announcement in English 9 · Period 3: Library visit <Friday>", ref: { announcementId: "ann_library" }, occurredAt: "2026-10-19T13:00:00.000Z", createdAt: NOW },
    { id: `ntf_${"2".repeat(32)}`, principalId: ME, kind: "assignment-due-soon", offeringId: SCIENCE, title: "Due soon in Biology · Period 1: Osmosis in potato cores", ref: { assignmentId: OSMOSIS }, occurredAt: "2026-10-18T13:00:00.000Z", createdAt: NOW, readAt: NOW },
  ];
  let preferences = { email: { announcements: true, assignments: true, feedback: true, grades: true, digest: true }, hasEmailAddress: true, emailEnabled: true };
  let feed: { createdAt: string; path: string } | undefined;
  const CALENDAR = [
    { uid: "term-start-trm_fall@dst_northfield.schoolos", kind: "term-start", title: "Fall 2026 begins", start: "2026-10-19", allDay: true }, // rename-educateos: keep
    { uid: `due-${ESSAY}@dst_northfield.schoolos`, kind: "assignment-due", title: "Due: Should the school day start later? — English 9 · Period 3", start: "2026-10-22T21:00:00.000Z", allDay: false, offeringId: ENGLISH, assignmentId: ESSAY }, // rename-educateos: keep
    { uid: `due-${LAB_REPORT}@dst_northfield.schoolos`, kind: "assignment-due", title: "Due: Osmosis lab report — Biology · Period 1", start: "2026-11-12T21:00:00.000Z", allDay: false, offeringId: SCIENCE, assignmentId: LAB_REPORT }, // rename-educateos: keep
  ];

  // The student's classes, by name (SCHO-222).
  const term = (id: string, name: string, state: string) => ({ id, districtId: DISTRICT, name, startsOn: "2026-01-12", endsOn: "2027-01-22", state });
  const FALL = term("trm_fall", "Fall 2026", "active");
  const SPRING = term("trm_spring", "Spring 2026", "completed");
  const offering = (id: string, courseId: string, title: string, subject: string, termValue: typeof FALL, sectionName: string) => ({
    offering: { id, districtId: DISTRICT, schoolId: "sch_nf-high", termId: termValue.id, courseId, sectionName },
    course: { id: courseId, districtId: DISTRICT, title, subject, gradeBand: "9-12" },
    term: termValue,
  });
  const OFFERINGS = [
    offering(ENGLISH, "crs_nf-english-9", "English 9", "english-language-arts", FALL, "Period 3"),
    offering(SCIENCE, "crs_nf-biology", "Biology", "science", FALL, "Period 1"),
    offering(ART_SPRING, "crs_nf-art", "Art", "arts", SPRING, "Period 2"),
  ];

  const handlers: Handlers = {
    "student.listOfferings": () => OFFERINGS,
    "student.assignmentFeedback": ({ params }) =>
      submissions.filter((s) => s.assignmentId === params.assignmentId).flatMap((s) => (feedback.has(s.id) ? [feedback.get(s.id)] : [])),
    "student.announcements": () => (options.announcements === true ? [ANNOUNCEMENT] : []),
    "student.courseAnnouncements": ({ params }) => (options.announcements === true && params.offeringId === ENGLISH ? [ANNOUNCEMENT] : []),
    "me.notifications": () => ({ notifications, unread: notifications.filter((n) => n.readAt === undefined).length }),
    "me.markNotificationsRead": ({ body }) => {
      for (const n of notifications) if (body?.all === true || body?.ids?.includes(n.id)) n.readAt = NOW;
      return { unread: notifications.filter((n) => n.readAt === undefined).length };
    },
    // The whole calendar, whatever the range: the screen places each event on its own day.
    "me.calendar": ({ query }) => ({ from: query?.from ?? NOW, to: query?.to ?? NOW, events: CALENDAR }),
    "me.preferences": () => preferences,
    "me.updatePreferences": ({ body }) => (preferences = { ...preferences, email: { ...preferences.email, ...body.email } }),
    "me.calendarFeed": () => (feed === undefined ? { active: false } : { active: true, createdAt: feed.createdAt }),
    "me.rotateCalendarFeed": () => {
      const token = `${next("tok").replace("_", "")}${"x".repeat(35)}`;
      feed = { createdAt: NOW, path: `/api/calendar/${token}.ics` };
      return { token, path: feed.path, createdAt: NOW };
    },
    "me.revokeCalendarFeed": () => {
      feed = undefined;
      return { active: false };
    },
    "me.get": () => ({ principalId: ME, districtId: DISTRICT, kind: "student", displayName: "Amara Okafor", roles: [], enrollments: [{ offeringId: ENGLISH, role: "student" }, { offeringId: SCIENCE, role: "student" }] }),
    "student.listWorkspaces": () => workspaces,
    "student.openPersonalWorkspace": () => workspaces[0],
    "student.openCourseWorkspace": ({ params }) => {
      let found = workspaces.find((w) => w.offeringId === params.offeringId);
      if (found === undefined) {
        found = { kind: "course", id: `wsp_amara-${params.offeringId.slice(4)}`, districtId: DISTRICT, ownerPrincipalId: ME, createdAt: time(), schoolId: "sch_nf-high", offeringId: params.offeringId, termId: "trm_fall", lifecycle: "active" };
        workspaces.push(found);
      }
      return found;
    },
    "student.listActivities": ({ params }) => activities[params.offeringId] ?? [],
    "student.listModules": ({ params }) => ({ view: "student", outline: options.modules?.[params.offeringId] ?? { offeringId: params.offeringId, revision: 0, modules: [], pages: [] } }),
    "student.listArtifacts": ({ params }) => [...artifacts.values()].filter((s) => s.artifact.workspaceId === params.workspaceId).map(view),
    "student.createArtifact": ({ body }) => {
      const id = addArtifact(body.workspaceId, body.title, body.type, "text/plain", undefined);
      const stored = artifact(id);
      stored.revisions.length = 0;
      stored.contents.clear();
      return saveRevision(stored, body.content as never);
    },
    "student.saveRevision": ({ params, body }) => saveRevision(artifact(params.artifactId), body.content as never),
    "student.getArtifact": ({ params, query }) => {
      const stored = artifact(params.artifactId);
      const revision = query?.revisionId === undefined ? stored.revisions.at(-1)! : stored.revisions.find((r) => r.id === query.revisionId);
      if (revision === undefined) throw notFound("revision");
      return { artifact: stored.artifact, revision, content: stored.contents.get(revision.id) };
    },
    "student.artifactHistory": ({ params }) => artifact(params.artifactId).revisions,
    "student.keepArtifact": ({ params }) => {
      const source = workspaces.find((w) => w.id === params.workspaceId);
      if (source?.lifecycle !== "retained") throw new DistrictApiError(409, { code: "conflict", message: "Work can be kept in your personal workspace once the class has closed." });
      const kept = artifact(params.artifactId);
      addArtifact("wsp_amara-personal", kept.artifact.title, kept.artifact.type, kept.revisions.at(-1)!.mediaType, kept.contents.get(kept.revisions.at(-1)!.id));
      return { principalId: ME, fromWorkspaceId: params.workspaceId, toWorkspaceId: "wsp_amara-personal", artifactId: params.artifactId, promotedAt: time() };
    },
    "student.submit": ({ params, body }) => {
      const attempt = submissions.filter((s) => s.assignmentId === params.assignmentId).length + 1;
      const id = next("sub");
      const submissionDigest = `sha256:${(counter * 7919).toString(16).padStart(12, "0")}${"c".repeat(52)}`;
      const items = body.revisions.map(({ artifactId, revisionId }) => ({ artifactId, revisionId, digest: `sha256:${"a".repeat(64)}` }));
      const submittedAt = time();
      submissions.push({
        id, districtId: DISTRICT, assignmentId: params.assignmentId, offeringId: ENGLISH, studentPrincipalId: ME, attempt,
        items: items.map((item) => ({ ...item, artifactType: "document", mediaType: "text/plain", sizeBytes: 1, aiAssistance: { level: "none" } })),
        submissionDigest, submittedAt, timing: "on-time", channel: "ui",
      });
      return { format: "educateos.submission-receipt.v1", submissionId: id, assignmentId: params.assignmentId, studentPrincipalId: ME, attempt, submittedAt, timing: "on-time", items, submissionDigest };
    },
    "student.listSubmissions": ({ params }) => submissions.filter((s) => s.assignmentId === params.assignmentId),
    "student.officialGrades": ({ params }) => grades.filter((g) => g.assignmentId === params.assignmentId),
    "student.gradeSummary": ({ params }) => gradeSummary(params.offeringId),
    "student.getFeedback": ({ params }) => {
      const released = feedback.get(params.submissionId);
      if (released === undefined) throw notFound("feedback");
      return released;
    },
  };

  return {
    calls,
    submissions,
    addArtifact,
    failNext: (name, failure) => void failures.set(name, failure),
    setEmailEnabled: (enabled) => void (preferences = { ...preferences, emailEnabled: enabled }),
    markAssignment: (assignmentId, marker) => void markers.set(assignmentId, marker),
    recordGrade(assignmentId, score) {
      const course = Object.values(activities).flat().find((a) => a.assignment.id === assignmentId)!.assignment;
      grades.push({
        format: "educateos.official-grade.v1",
        districtId: DISTRICT,
        offeringId: course.offeringId,
        assignmentId,
        studentPrincipalId: ME,
        submissionId: submissions.find((s) => s.assignmentId === assignmentId)?.id ?? "sub_graded",
        submissionDigest: `sha256:${"d".repeat(64)}`,
        version: grades.filter((g) => g.assignmentId === assignmentId).length + 1,
        score,
        approval: { approvedBy: "prn_nf-teacher-rivera", approvedAt: time(), channel: "http" },
      });
    },
    releaseFeedback(submissionId, { comments, scores }) {
      feedback.set(submissionId, {
        submissionId,
        state: "shared-with-student",
        comments: comments.map((comment) => {
          const { body, anchor } = typeof comment === "string" ? { body: comment, anchor: undefined } : comment;
          return {
            id: next("fbc"), body, source: { kind: "teacher" }, enteredBy: "prn_nf-teacher-rivera", enteredAt: time(),
            ...(anchor === undefined ? {} : { anchor: { artifactId: anchor.artifactId, revisionId: anchor.revisionId, region: { kind: "text-range", start: anchor.start, end: anchor.end } } }),
          };
        }),
        scores: scores.map((score) => ({ ...score, source: { kind: "teacher" }, enteredBy: "prn_nf-teacher-rivera", enteredAt: time() })),
        updatedAt: time(),
      });
    },
    async call<N extends RouteName>(name: N, ...args: [RouteInput<N>?]): Promise<RouteResponse<N>> {
      const input = (args[0] ?? {}) as RouteInput<N>;
      calls.push({ name, input });
      await Promise.resolve();
      const failure = failures.get(name);
      if (failure !== undefined) {
        failures.delete(name);
        if (failure === "network") throw new TypeError("Failed to fetch");
        throw new DistrictApiError(STATUS[failure.code], { ...failure, message: failure.message ?? "failed" });
      }
      const handler = handlers[name] as ((input: RouteInput<N>) => unknown) | undefined;
      if (handler === undefined) throw notFound(name);
      // Deep copies, as JSON over the wire would be: the UI never holds the fake's own objects.
      return structuredClone(handler(input)) as RouteResponse<N>;
    },
  };
}
