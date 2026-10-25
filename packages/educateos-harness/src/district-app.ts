// Serves the full EducateOS district application (SCHO-95) for each harness district, over the
// district's own fake IdP, and seeds demo content through the typed API client so every subject
// journey has something to show.
import type { DistrictDirectorySnapshot, Principal, PrincipalId, Subject } from "@educateos/contracts";
import { catalogSeedRelease } from "@educateos/catalog";
import type { ImportFetch } from "@educateos/content-studio";
import type { TemplateInput } from "@educateos/curriculum";
import { createDistrictApp, inMemoryDistrictStores, type DistrictApp } from "@educateos/district-app";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { HarnessDistrict } from "./harness.ts";
import { identityFromBearer } from "./sign-in.ts";

/** The synthetic model every harness district funds. */
const DEMO_MODEL = { provider: "cloudflare", modelId: "synthetic-demo-model" } as const;

/** The synthetic pages teachers import in the demo, one per subject. Nothing is fetched from the internet. */
export const DEMO_PAGES: Readonly<Record<string, string>> = {
  "https://open-lessons.example/persuasive-writing": "Persuasive Writing Models",
  "https://open-lessons.example/osmosis-lab": "Osmosis in Potato Cells",
  "https://archive.example/letter-1863": "A Soldier's Letter, 1863",
  "https://open-lessons.example/proportional-reasoning": "Proportional Reasoning",
  "https://open-lessons.example/color-wheel": "The Color Wheel",
};

/** A synthetic web serving {@link DEMO_PAGES}: the harness's Content Studio fetch. Every other URL is a 404. */
export const demoWeb: ImportFetch = async (url) => {
  const title = DEMO_PAGES[url];
  if (title === undefined) return new Response("not found", { status: 404 });
  return new Response(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>Synthetic lesson text.</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

/**
 * The district application for a harness district: in-memory stores seeded with its directory,
 * its fake IdP's tokens as the only credential (signed in as Access payloads are), the synthetic
 * web for imports (or `importFetch`, such as `createPinnedEgressFetch()` from
 * `@educateos/harness/pinned-fetch` for the real web; the demo seed imports synthetic pages, so
 * {@link seedDemo} needs the synthetic web), and one funded district course pool for the synthetic
 * model.
 */
export async function bootDistrictApp(entry: HarnessDistrict, importFetch: ImportFetch = demoWeb): Promise<DistrictApp> {
  const { directory } = entry.district;
  return createDistrictApp({
    stores: inMemoryDistrictStores(directory),
    // The app resolves the identity with `createDirectoryPrincipalResolver` against its own store.
    verifyRequest: (request) => identityFromBearer(request, entry.identity),
    importFetch,
    fundingPools: [{
      id: "fpl_demo-courses" as never,
      name: "Demo course AI",
      purpose: "course",
      scope: { level: "district", districtId: directory.district.id },
      monthlyAllocationUsdNano: "500000000000", // $500
      allowedModels: [DEMO_MODEL],
    }],
    modelCatalog: [{ ...DEMO_MODEL, mode: "enabled" }],
  });
}

/** One district's demo principals, for the CLI to print tokens for. */
export interface DemoPrincipals {
  student: Principal;
  teacher: Principal;
  admin: Principal;
}

const PAGE_FOR: Partial<Record<Subject, string>> = {
  "english-language-arts": "https://open-lessons.example/persuasive-writing",
  science: "https://open-lessons.example/osmosis-lab",
  "history-social-studies": "https://archive.example/letter-1863",
  mathematics: "https://open-lessons.example/proportional-reasoning",
  arts: "https://open-lessons.example/color-wheel",
};

const DEMO_RUBRIC = {
  rubricId: "rbr_demo-writing",
  version: 1,
  title: "Writing basics",
  criteria: [{
    id: "length",
    title: "Length",
    levels: [{ id: "short", label: "Too short", points: 0 }, { id: "enough", label: "Long enough", points: 4 }],
    checks: [{ id: "word-count", evaluatorId: "writing.structure", visibility: "student-visible" as const, config: { minWords: 20 } }],
  }],
};

/** A template for each subject, so each class gets an activity of the kind it would really use. */
function activityFor(subject: Subject, gradeBand: string, resource: { resourceId: string; version: string }, alignment: { frameworkKey: string; competencyUri: string }): TemplateInput {
  const common = {
    subject,
    gradeBand,
    resources: [resource],
    codex: [{ kind: "resource", resource, visibility: "students" }],
    alignments: [alignment],
    aiHelp: "hints-only",
    due: { kind: "after-install", days: 14 },
  };
  switch (subject) {
    case "science":
      return {
        ...common,
        template: "science-investigation",
        title: "Osmosis in potato cores",
        overview: "Investigate how salt concentration affects the mass of potato cores.",
        question: "How does salt concentration affect the mass of potato cores?",
        methodPrompt: "Describe how you will prepare, soak and weigh the cores.",
        dataColumns: [{ name: "Concentration", unit: "M" }, { name: "Mass change", unit: "%" }],
        analysisPrompt: "Explain what your data shows about osmosis.",
      } as TemplateInput;
    case "history-social-studies":
      return {
        ...common,
        template: "primary-source-analysis",
        title: "A soldier's letter",
        overview: "Analyze a letter written in 1863.",
        sources: [resource],
        sourcingQuestions: ["Who wrote this letter, and why?"],
        contextualizationQuestions: ["What was happening when it was written?"],
        claimPrompt: "What does the letter show about how the war was experienced?",
        minimumEvidence: 1,
      } as TemplateInput;
    case "mathematics":
      return {
        ...common,
        template: "problem-set",
        title: "Proportional relationships",
        overview: "Decide whether each relationship is proportional.",
        problems: [{ prompt: "Is y = 3x proportional?", answer: "Yes; the constant is 3." }, { prompt: "Is y = x + 2 proportional?", answer: "No." }],
        showWork: true,
      } as TemplateInput;
    default:
      return {
        ...common,
        template: "writing-task",
        title: subject === "arts" ? "Color in a painting you love" : "Should the school day start later?",
        overview: subject === "arts" ? "Write about how an artist uses color." : "Write an argument for or against a later start.",
        prompt: subject === "arts" ? "Describe how color shapes the mood of one painting." : "Take a position on a later school start.",
        genre: subject === "arts" ? "informative" : "argument",
        minimumCitations: 1,
      } as TemplateInput;
  }
}

/**
 * Seeds a district with demo content through its own API, as its people would make it: the
 * administrator approves the ELA and math catalog seeds and applies a configuration; each active
 * class's teacher imports and approves a resource, signs a rubric and installs an activity of the
 * class's subject; one student saves an essay in a personal and a course workspace and submits it;
 * and one AI request is recorded through the governor. Returns the principals the CLI prints
 * tokens for.
 */
export async function seedDemo(entry: HarnessDistrict, app: DistrictApp): Promise<DemoPrincipals> {
  const { directory } = entry.district;
  const byId = (id: PrincipalId) => directory.principals.find((p) => p.id === id)!;
  const client = async (principal: Principal): Promise<DistrictApiClient> => createDistrictApiClient({
    baseUrl: "http://district.harness",
    token: await entry.identity.issueToken(principal.externalIdentities[0]!.subject),
    fetch: (request) => app.fetch(request),
  });

  const admin = byId(directory.roleAssignments.find((r) => r.role === "district-admin")!.principalId);
  const actor = { by: admin.id, at: new Date().toISOString() };
  const alignments: Record<string, { frameworkKey: string; competencyUri: string }> = {};
  for (const key of ["ccss-ela", "ccss-math"]) {
    const release = await catalogSeedRelease(key);
    await app.catalog.select(key, actor);
    await app.catalog.install(release, actor);
    await app.catalog.approve(key, release.version, actor);
    alignments[key] = { frameworkKey: key, competencyUri: release.content.nodes![0]!.uri };
  }
  const adminApi = await client(admin);
  await adminApi.call("admin.applyConfig", { body: { document: demoConfig(directory), acknowledgeApprovals: true } });

  const active = new Set(directory.terms.filter((t) => t.state === "active").map((t) => t.id));
  const assignments: { offeringId: string; assignmentId: string; subject: Subject; teacher: Principal }[] = [];
  for (const offering of directory.offerings.filter((o) => active.has(o.termId))) {
    const course = directory.courses.find((c) => c.id === offering.courseId)!;
    const lead = directory.enrollments.find((e) => e.offeringId === offering.id && e.role === "teacher" && e.status === "active");
    const page = PAGE_FOR[course.subject];
    if (lead === undefined || page === undefined) continue;
    const teacher = byId(lead.principalId);
    const api = await client(teacher);
    const params = { offeringId: offering.id };
    const item = await api.call("teacher.importResource", { params, body: { url: page } }) as { id: string };
    const release = await api.call("teacher.approveResource", { params: { itemId: item.id }, body: {} }) as { descriptor: { id: string; release: { version: string } } };
    const resource = { resourceId: release.descriptor.id, version: release.descriptor.release.version };
    const rubric = await api.call("teacher.signRubric", { params, body: { rubric: DEMO_RUBRIC } });
    const alignment = course.subject === "mathematics" || course.subject === "science" ? alignments["ccss-math"]! : alignments["ccss-ela"]!;
    const draft = await api.call("teacher.createActivity", { params, body: { activity: activityFor(course.subject, course.gradeBand, resource, alignment) } });
    await api.call("teacher.publishActivity", { params: { definitionId: draft.id } });
    const { assignment } = await api.call("teacher.installActivity", {
      params: { definitionId: draft.id },
      body: { offeringId: offering.id, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
    });
    assignments.push({ offeringId: offering.id, assignmentId: assignment.id, subject: course.subject, teacher });
  }

  // The demo student: the first active student of the first writing class.
  const essay = assignments.find((a) => a.subject === "english-language-arts") ?? assignments[0]!;
  const student = byId(directory.enrollments.find((e) => e.offeringId === essay.offeringId && e.role === "student" && e.status === "active")!.principalId);
  const studentApi = await client(student);
  const personal = await studentApi.call("student.openPersonalWorkspace");
  await studentApi.call("student.createArtifact", {
    body: { workspaceId: personal.id, type: "document", title: "Reading journal", content: { kind: "text", mediaType: "text/markdown", text: "# Reading journal\n\nNotes to myself." } },
  });
  const course = await studentApi.call("student.openCourseWorkspace", { params: { offeringId: essay.offeringId } });
  const { artifact, head } = await studentApi.call("student.createArtifact", {
    body: {
      workspaceId: course.id,
      type: "document",
      title: "My essay",
      content: { kind: "text", mediaType: "text/markdown", text: "School should start later. Teenagers need more sleep, and the research on adolescent sleep supports a later start for every high school." },
    },
  });
  await studentApi.call("student.submit", { params: { assignmentId: essay.assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });

  const requestId = `demo-${crypto.randomUUID()}`;
  const decision = await app.aiGovernor.beforeRequest({
    requestId,
    principal: { principalId: student.id, districtId: directory.district.id },
    workspace: { kind: "course", offeringId: essay.offeringId },
    model: DEMO_MODEL,
    estimatedMaxUsdNano: "30000000", // 3¢
  });
  if (decision.effect === "allow") {
    await app.aiGovernor.afterResponse({
      status: "completed",
      requestId,
      usage: { inputTokens: 240, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      actualUsdNano: "10000000", // 1¢
    });
  }
  return { student, teacher: essay.teacher, admin };
}

/** A configuration document for the district: the conservative profile, exposed to every active class. */
function demoConfig(directory: DistrictDirectorySnapshot): Record<string, unknown> {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: directory.district.id,
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled" },
    rollout: { target: "all-active-offerings", requiresAdminActivation: false },
  };
}

/**
 * One request handler for a harness district: `/api/*` goes to the district application, and
 * everything else to the F02 instance (`/health`, `/me`, `/ai/complete`).
 */
export function harnessFetch(entry: HarnessDistrict, app: DistrictApp): (request: Request) => Promise<Response> {
  return (request) => (new URL(request.url).pathname.startsWith("/api/") ? app.fetch(request) : entry.district.fetch(request));
}
