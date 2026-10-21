// A scripted district for the UI tests: the student routes over in-memory state built from
// synthetic `.example` data, with a hook to make the next call to a route fail and a log of calls.
// It answers the way the district does where the UI depends on it: feedback is not-found until the
// teacher releases it, and a finished class's work can be kept only once the term has closed.
import { DistrictApiError, type DistrictApiClient, type RouteInput, type RouteName, type RouteResponse } from "@schoolos/api-client";

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

/** A failure to inject: a district error by code, or a network failure. */
export type InjectedFailure = { code: "unavailable" | "conflict" | "forbidden"; message?: string } | "network";

/** The fake district and its controls. */
export interface FakeDistrict extends DistrictApiClient {
  /** Every call made, by route name. */
  calls: { name: RouteName; input: unknown }[];
  /** Makes the next call to `name` fail. */
  failNext(name: RouteName, failure: InjectedFailure): void;
  /** Releases teacher feedback on a submission, as the teacher's "share with student" does. */
  releaseFeedback(submissionId: string, feedback: { comments: string[]; scores: { criterionId: string; points: number; maxPoints?: number }[] }): void;
  /** Adds a saved artifact directly, as if made earlier. */
  addArtifact(workspaceId: string, title: string, type: string, mediaType: string, content: unknown): string;
  /** The submissions made so far. */
  submissions: { id: string; assignmentId: string; submissionDigest: string }[];
}

/** A Northfield student with an English and a science class this term and a finished art class. */
export function fakeDistrict(options: { aiHelp?: "full" | "hints-only" | "none" } = {}): FakeDistrict {
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
    ], options.aiHelp)],
    [ART_SPRING]: [activity(ART_SPRING, COLOR, "Color in a painting you love", "2026-04-01T21:00:00.000Z", "arts", [
      step("essay", "Describe the colors", "How does color shape the mood?", { kind: "writing" }),
    ], options.aiHelp)],
  };
  const artifacts = new Map<string, StoredArtifact>();
  const submissions: (Record<string, unknown> & { id: string; assignmentId: string; submissionDigest: string; attempt: number })[] = [];
  const feedback = new Map<string, unknown>();
  const failures = new Map<RouteName, InjectedFailure>();
  const calls: FakeDistrict["calls"] = [];

  const view = (stored: StoredArtifact) => ({ artifact: stored.artifact, head: stored.revisions.at(-1)! });
  const saveRevision = (stored: StoredArtifact, content: { kind: string; mediaType?: string; text?: string; url?: string }) => {
    const revision = {
      id: next("rev"),
      artifactId: stored.artifact.id,
      number: stored.revisions.length + 1,
      content: { backend: "text", key: "k", digest: `sha256:${"a".repeat(64)}` },
      sizeBytes: (content.text ?? content.url ?? "").length,
      mediaType: content.kind === "external" ? "application/vnd.schoolos.external-ref+json" : content.mediaType!,
      authorPrincipalId: ME,
      createdAt: time(),
      aiAssistance: { level: "none" },
      provenance: { origin: "authored", channel: "ui" },
    };
    stored.revisions.push(revision);
    stored.contents.set(revision.id, content.kind === "external" ? { kind: "external", url: content.url } : { kind: "text", text: content.text });
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

  const handlers: Handlers = {
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
      return { format: "schoolos.submission-receipt.v1", submissionId: id, assignmentId: params.assignmentId, studentPrincipalId: ME, attempt, submittedAt, timing: "on-time", items, submissionDigest };
    },
    "student.listSubmissions": ({ params }) => submissions.filter((s) => s.assignmentId === params.assignmentId),
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
    releaseFeedback(submissionId, { comments, scores }) {
      feedback.set(submissionId, {
        submissionId,
        state: "shared-with-student",
        comments: comments.map((body) => ({ id: next("fbc"), body, source: { kind: "teacher" }, enteredBy: "prn_nf-teacher-rivera", enteredAt: time() })),
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
        throw new DistrictApiError(failure.code === "conflict" ? 409 : failure.code === "forbidden" ? 403 : 503, { code: failure.code, message: failure.message ?? "failed" });
      }
      const handler = handlers[name] as ((input: RouteInput<N>) => unknown) | undefined;
      if (handler === undefined) throw notFound(name);
      // Deep copies, as JSON over the wire would be: the UI never holds the fake's own objects.
      return structuredClone(handler(input)) as RouteResponse<N>;
    },
  };
}
