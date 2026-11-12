#!/usr/bin/env node
// Additive Canvas school seed. Uses account 3 only; preserves the original LTI acceptance course.
// dry-run is offline; run creates missing records; verify never writes. No passwords or emails
// are sent, and no grades are approved by this provisioning script.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NORTHFIELD, NORTHFIELD_SHOWCASE, type ShowcaseActivity } from "../../packages/educateos-fixtures/src/index.ts";

const ORIGIN = "https://canvas.mackie.house";
const ACCOUNT = 3;
const PREFIX = "educateos-demo:";
const marker = "<p>EducateOS synthetic demo — managed by seed-canvas-demo.ts.</p>";
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const paragraphs = (s: string) => s.split("\n").map(line => `<p>${escape(line)}</p>`).join("");

/** Public learner instructions, deliberately excluding answer keys and exemplar student work. */
export function activityInstructions(activity: ShowcaseActivity): string {
  let prompts: string[];
  switch (activity.template) {
    case "writing-task": prompts = [activity.prompt]; break;
    case "science-investigation": prompts = [activity.question, activity.methodPrompt, activity.analysisPrompt]; break;
    case "primary-source-analysis": prompts = [...activity.sourcingQuestions, ...activity.contextualizationQuestions, activity.claimPrompt]; break;
    case "problem-set": prompts = activity.problems.map(p => p.prompt); break;
    case "picture-response": prompts = [activity.lookPrompt, activity.drawPrompt, ...activity.sentenceFrames]; break;
    case "read-and-respond": prompts = [activity.passage, ...activity.questions.map(q => q.prompt), ...activity.sentenceFrames]; break;
  }
  return marker + paragraphs(activity.overview) + prompts.map(paragraphs).join("");
}

/** Stable fixture identities for all showcase courses and their active teachers and students. */
export function canvasDemoPlan() {
  const offerings = new Set(NORTHFIELD_SHOWCASE.courses.map(c => c.offeringId));
  const enrollments = NORTHFIELD.enrollments.filter(e => offerings.has(e.offeringId) && e.status === "active");
  const ids = new Set(enrollments.map(e => e.principalId));
  return {
    accountId: ACCOUNT,
    users: NORTHFIELD.principals.filter(p => ids.has(p.id)).map(p => ({
      fixtureId: p.id, name: p.displayName, sisId: PREFIX + p.id,
      login: `${p.id.slice(4)}@canvas.demo.educateos.io`,
    })),
    courses: NORTHFIELD_SHOWCASE.courses.map(c => {
      const offering = NORTHFIELD.offerings.find(o => o.id === c.offeringId)!;
      const title = NORTHFIELD.courses.find(course => course.id === offering.courseId)!.title;
      return { ...c, title, sisId: PREFIX + c.offeringId,
        enrollments: enrollments.filter(e => e.offeringId === c.offeringId) };
    }),
  };
}

/** Canvas REST transport; bearer credentials never follow redirects or pagination off-origin. */
export class CanvasClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  constructor(token: string, transport: typeof fetch = fetch) { this.#token = token; this.#fetch = transport; }
  async request<T>(method: string, path: string, body?: unknown): Promise<{ value: T; next?: string }> {
    const url = new URL(path, `${ORIGIN}/api/v1/`);
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/api/v1/")) throw new Error("Refusing a Canvas URL outside the demo API");
    const response = await this.#fetch(url, { method, redirect: "manual", headers: {
      authorization: `Bearer ${this.#token}`, "content-type": "application/json",
      "user-agent": "EducateOS-Demo-Seed/1.0", accept: "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => {
      throw new Error(`Canvas ${method} ${url.pathname}: transport failed. Check the provider before retrying a write.`);
    });
    if (!response.ok) throw new Error(`Canvas ${method} ${url.pathname}: HTTP ${response.status}. Check the provider before retrying a write.`);
    const next = response.headers.get("link")?.split(",").map(part => part.trim()).find(part => /rel="next"/.test(part))?.match(/^<([^>]+)>/)?.[1];
    return { value: await response.json() as T, ...(next ? { next } : {}) };
  }
  async list<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (seen.has(next)) throw new Error("Canvas repeated a pagination URL");
      seen.add(next);
      const page: { value: T[]; next?: string } = await this.request<T[]>("GET", next);
      result.push(...page.value); next = page.next;
    }
    return result;
  }
}

interface User { id: number; sis_user_id?: string; login_id?: string }
interface Course { id: number; sis_course_id?: string; course_code: string; workflow_state: string }
interface Assignment { id: number; name: string; description: string; published: boolean; points_possible: number; submission_types: string[] }
interface Enrollment { user_id: number; type: string; enrollment_state: string }
interface Module { id: number; name: string; published: boolean }
interface Page { page_id: number; url: string; title: string; body: string; published: boolean }
interface Topic { id: number; title: string; message: string; published: boolean }
interface ModuleItem { type: string; content_id?: number; page_url?: string }

/** Creates only missing fixture-owned records; verification checks the real account without writes. */
export async function seedCanvasDemo(client: CanvasClient, mode: "run" | "verify") {
  const plan = canvasDemoPlan();
  const problems: string[] = [];
  const users = await client.list<User>(`accounts/${ACCOUNT}/users?per_page=100`);
  const courses = await client.list<Course>(`accounts/${ACCOUNT}/courses?per_page=100`);
  const userIds = new Map<string, number>();
  for (const planned of plan.users) {
    const matches = users.filter(u => u.sis_user_id === planned.sisId);
    if (matches.length > 1) throw new Error(`Duplicate Canvas SIS user ${planned.fixtureId}`);
    let user = matches[0];
    if (!user && users.some(u => u.login_id === planned.login)) throw new Error(`Unowned Canvas login collision: ${planned.fixtureId}`);
    if (!user && mode === "run") user = (await client.request<User>("POST", `accounts/${ACCOUNT}/users`, {
      user: { name: planned.name, skip_registration: true },
      pseudonym: { unique_id: planned.login, sis_user_id: planned.sisId, send_confirmation: false },
    })).value;
    if (user) userIds.set(planned.fixtureId, user.id);
    else problems.push(`Missing user ${planned.fixtureId}`);
  }
  const mappings: { offeringId: string; canvasCourseId: number; assignments: { key: string; canvasAssignmentId: number }[] }[] = [];
  for (const planned of plan.courses) {
    const matches = courses.filter(c => c.sis_course_id === planned.sisId);
    if (matches.length > 1) throw new Error(`Duplicate Canvas SIS course ${planned.offeringId}`);
    let course = matches[0];
    if (!course && courses.some(c => c.course_code === planned.sisId)) throw new Error(`Unowned Canvas course collision: ${planned.offeringId}`);
    if (!course && mode === "run") course = (await client.request<Course>("POST", `accounts/${ACCOUNT}/courses`, {
      course: { name: `${planned.title} (synthetic demo)`, course_code: planned.sisId, sis_course_id: planned.sisId,
        public_description: "Synthetic Northfield showcase. All people and learner work are invented.", time_zone: "America/Detroit" },
    })).value;
    if (!course) { problems.push(`Missing course ${planned.offeringId}`); continue; }
    const base = `courses/${course.id}`;
    const enrolled = await client.list<Enrollment>(`${base}/enrollments?per_page=100`);
    for (const enrollment of planned.enrollments) {
      const userId = userIds.get(enrollment.principalId);
      if (!userId) continue;
      const type = enrollment.role === "student" ? "StudentEnrollment" : "TeacherEnrollment";
      if (!enrolled.some(e => e.user_id === userId && e.type === type && e.enrollment_state === "active")) {
        if (mode === "run") await client.request("POST", `${base}/enrollments`, { enrollment: { user_id: userId, type, enrollment_state: "active", notify: false } });
        else problems.push(`Missing ${type} ${enrollment.principalId} in ${planned.offeringId}`);
      }
    }
    const assignments = await client.list<Assignment>(`${base}/assignments?per_page=100`);
    const mapped = { offeringId: planned.offeringId, canvasCourseId: course.id, assignments: [] as { key: string; canvasAssignmentId: number }[] };
    for (const activity of planned.activities) {
      const name = `[${activity.key}] ${activity.title}`;
      const matches = assignments.filter(a => a.name === name);
      if (matches.length > 1) throw new Error(`Duplicate assignment ${planned.offeringId}/${activity.key}`);
      let assignment = matches[0];
      if (assignment && !assignment.description.includes("managed by seed-canvas-demo.ts")) throw new Error(`Unowned assignment collision: ${name}`);
      const points = activity.rubric.criteria.reduce((sum, c) => sum + Math.max(...c.levels.map(l => l.points)), 0);
      if (!assignment && mode === "run") assignment = (await client.request<Assignment>("POST", `${base}/assignments`, {
        assignment: { name, description: activityInstructions(activity), submission_types: ["online_text_entry"], points_possible: points, published: true },
      })).value;
      if (!assignment) problems.push(`Missing assignment ${planned.offeringId}/${activity.key}`);
      else {
        mapped.assignments.push({ key: activity.key, canvasAssignmentId: assignment.id });
        if (!assignment.published || assignment.points_possible !== points || !assignment.submission_types.includes("online_text_entry")) problems.push(`Assignment configuration drift: ${planned.offeringId}/${activity.key}`);
      }
    }
    const topicIds = new Map<string, number>();
    for (const kind of ["discussions", "announcements"] as const) {
      const existing = await client.list<Topic>(`${base}/discussion_topics?per_page=100${kind === "announcements" ? "&only_announcements=true" : ""}`);
      for (const [index, topic] of planned[kind].entries()) {
        const key = "key" in topic ? topic.key : `announcement-${index + 1}`;
        const title = `[educateos-demo:${key}] ${topic.title}`;
        const matches = existing.filter(t => t.title === title);
        if (matches.length > 1) throw new Error(`Duplicate topic: ${title}`);
        let record = matches[0];
        if (record && !record.message.includes("managed by seed-canvas-demo.ts")) throw new Error(`Unowned topic collision: ${title}`);
        if (!record && mode === "run") record = (await client.request<Topic>("POST", `${base}/discussion_topics`, {
          title, message: marker + paragraphs("prompt" in topic ? topic.prompt : topic.body),
          published: true, is_announcement: kind === "announcements", discussion_type: "threaded",
        })).value;
        if (!record) problems.push(`Missing ${kind} ${planned.offeringId}/${key}`);
        else {
          if (!record.published) problems.push(`Unpublished topic ${planned.offeringId}/${key}`);
          if (kind === "discussions") topicIds.set(key, record.id);
        }
      }
    }
    const modules = await client.list<Module>(`${base}/modules?per_page=100`);
    const pages = await client.list<Page>(`${base}/pages?per_page=100`);
    for (const [position, unit] of planned.modules.entries()) {
      const name = `[educateos-demo] ${unit.title}`;
      const matches = modules.filter(m => m.name === name);
      if (matches.length > 1) throw new Error(`Duplicate module: ${name}`);
      let module = matches[0];
      if (!module && mode === "run") module = (await client.request<Module>("POST", `${base}/modules`, { module: { name, position: position + 1 } })).value;
      if (!module) { problems.push(`Missing module ${planned.offeringId}/${position}`); continue; }
      const pageTitle = `[educateos-demo ${position + 1}] ${unit.page.title}`;
      const matchingPages = pages.filter(p => p.title === pageTitle);
      if (matchingPages.length > 1) throw new Error(`Duplicate page: ${pageTitle}`);
      let page = matchingPages[0];
      if (!page && mode === "run") page = (await client.request<Page>("POST", `${base}/pages`, {
        wiki_page: { title: pageTitle, body: marker + paragraphs(unit.page.body), published: true, editing_roles: "teachers" },
      })).value;
      const items = await client.list<ModuleItem>(`${base}/modules/${module.id}/items?per_page=100`);
      if (!page) problems.push(`Missing page ${planned.offeringId}/${position}`);
      else if (!items.some(i => i.type === "Page" && i.page_url === page.url)) {
        if (mode === "run") await client.request("POST", `${base}/modules/${module.id}/items`, { module_item: { type: "Page", page_url: page.url, position: 1 } });
        else problems.push(`Missing module page link ${planned.offeringId}/${position}`);
      }
      for (const item of unit.items.filter(i => i.kind === "activity")) {
        const assignment = mapped.assignments.find(a => a.key === item.key);
        if (assignment && !items.some(i => i.type === "Assignment" && i.content_id === assignment.canvasAssignmentId)) {
          if (mode === "run") await client.request("POST", `${base}/modules/${module.id}/items`, { module_item: { type: "Assignment", content_id: assignment.canvasAssignmentId } });
          else problems.push(`Missing module assignment link ${planned.offeringId}/${item.key}`);
        }
      }
      for (const item of unit.items.filter(i => i.kind === "discussion")) {
        const topicId = topicIds.get(item.key);
        if (topicId && !items.some(i => i.type === "Discussion" && i.content_id === topicId)) {
          if (mode === "run") await client.request("POST", `${base}/modules/${module.id}/items`, { module_item: { type: "Discussion", content_id: topicId } });
          else problems.push(`Missing module discussion link ${planned.offeringId}/${item.key}`);
        }
      }
      if (!module.published) {
        if (mode === "run") await client.request("PUT", `${base}/modules/${module.id}`, { module: { published: true } });
        else problems.push(`Unpublished module ${planned.offeringId}/${position}`);
      }
    }
    if (course.workflow_state !== "available") {
      if (mode === "run") await client.request("PUT", base, { course: { event: "offer" } });
      else problems.push(`Course is not published: ${planned.offeringId}`);
    }
    mappings.push(mapped);
  }
  return { accountId: ACCOUNT, users: userIds.size, courses: mappings, problems,
    pending: ["quizzes and discussion participation", "EducateOS offering/identity links", "LTI launches", "student submissions", "teacher-approved grade return"] };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!["dry-run", "run", "verify"].includes(mode ?? "") || args.length !== 2 || args[0] !== "--out") throw new Error("usage: seed-canvas-demo.ts <dry-run|run|verify> --out <new-report.json>");
  // Reserve the report before any vendor writes; never overwrite an earlier evidence file.
  const { open } = await import("node:fs/promises");
  const report = await open(args[1]!, "wx", 0o600);
  try {
    const result = mode === "dry-run" ? canvasDemoPlan() : await seedCanvasDemo(new CanvasClient(
      execFileSync("security", ["find-generic-password", "-s", "educateos-canvas-demo-admin-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    ), mode as "run" | "verify");
    await report.writeFile(JSON.stringify(result, null, 2) + "\n");
    console.log(`Canvas demo ${mode}: saved ${args[1]}`);
    if ("problems" in result && result.problems.length) process.exitCode = 1;
  } finally { await report.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Canvas seed failed"); process.exitCode = 1;
});
