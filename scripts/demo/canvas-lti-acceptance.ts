#!/usr/bin/env node
// Genuine LTI 1.3 acceptance between the Northfield Canvas demo and EducateOS (SCHO-354, SCHO-377).
// A scripted browser follows exactly the forms and redirects a person's browser would, signed in to
// Canvas as the synthetic person themself (a single-use session from canvas-actors.ts):
//
//   launches   every connected course: its teacher and a learner open EducateOS from course
//              navigation; each must be accepted as themself, in that course's offering.
//   deep-link  one course: its teacher adds two EducateOS activities to the first module through
//              Canvas's module "external tool" picker (LtiDeepLinkingRequest, link_selection), and
//              Canvas saves the signed content items as module items; a learner then launches each
//              one and EducateOS must open exactly the activity it names. A rerun reuses the items.
//              A learner cannot open the picker.
//
//   node scripts/demo/canvas-lti-acceptance.ts launches --access-cookie <file> --out <new report>
//   node scripts/demo/canvas-lti-acceptance.ts deep-link --offering <id> --access-cookie <file> --out <new report>
//
// canvas.mackie.house sits behind Cloudflare Access: the cookie file holds a CF_Authorization
// value (agent-inbox's access-sign-in.ts). The report holds IDs and outcomes, never credentials.
import { readFile, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canvasDemoPlan, CanvasClient } from "./seed-canvas-demo.ts";
import { consoleActors, railsRunner, type CanvasActors } from "./canvas-actors.ts";

const CANVAS = "https://canvas.mackie.house";
/** Where a launch may go: Canvas and the district's LTI tool. Anything else is refused. */
export const LAUNCH_HOSTS: readonly string[] = ["canvas.mackie.house", "northfield.educateos.io", "district.schoolos.gmac.io"];

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
const unescape = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => entities[e.toLowerCase()]
  ?? (e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m));
/** The visible text of a page. */
export const pageText = (page: string) => unescape(page.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m === null ? undefined : unescape(m[2] ?? m[3] ?? ""); };

/** A form on a page: its target, method, plain fields and checkboxes. */
export interface PageForm { action: string; method: string; fields: [string, string][]; boxes: { name: string; value: string; label: string }[] }
export function pageForms(page: string): PageForm[] {
  return [...page.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(([form]) => {
    const open = /<form\b[^>]*>/i.exec(form)![0];
    const result: PageForm = { action: attr(open, "action") ?? "", method: (attr(open, "method") ?? "get").toLowerCase(), fields: [], boxes: [] };
    for (const m of form.matchAll(/<input\b[^>]*>([^<]*)/gi)) {
      const name = attr(m[0], "name");
      if (name === undefined) continue;
      if (attr(m[0], "type")?.toLowerCase() === "checkbox") result.boxes.push({ name, value: attr(m[0], "value") ?? "on", label: unescape(m[1]!).trim() });
      else result.fields.push([name, attr(m[0], "value") ?? ""]);
    }
    return result;
  });
}

/** Whether a form is EducateOS's content picker: activity checkboxes and a session, posted to the district tool. */
export function isContentPicker(form: PageForm, base = "https://canvas.mackie.house/"): boolean {
  const target = new URL(form.action, base);
  return form.boxes.some((b) => b.name === "activity") && form.fields.some(([n]) => n === "session") && LAUNCH_HOSTS.slice(1).includes(target.hostname);
}

/** What EducateOS's launch page says it accepted. */
export interface AcceptedLaunch { name: string; kind: string; messageType: string; offeringId: string; activityId?: string; services: string[] }
export function acceptedLaunch(page: string): AcceptedLaunch | undefined {
  const text = pageText(page);
  const who = /Signed in to EducateOS as (.+?) \((\w+)\), in /.exec(text);
  const accepted = /Launch accepted: (\w+); offering (\S+) ;/.exec(text);
  if (who === null || accepted === null) return undefined;
  const activity = /Activity (\S+) \./.exec(text)?.[1];
  return { name: who[1]!, kind: who[2]!, messageType: accepted[1]!, offeringId: accepted[2]!,
    ...(activity === undefined ? {} : { activityId: activity }), services: [...text.matchAll(/\((AGS|NRPS)\)/g)].map((m) => m[1]!) };
}

/** Failures to open a connection, which sent no request and may be retried. */
const CONNECT_FAILURES = new Set(["ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** A minimal browser: cookies per host, manual redirects within LAUNCH_HOSTS, form posts. */
export class LaunchBrowser {
  readonly #cookies = new Map<string, Map<string, string>>();
  readonly #fetch: typeof fetch;
  constructor(accessCookie: string, transport: typeof fetch = fetch) {
    this.#fetch = transport;
    this.#cookies.set("canvas.mackie.house", new Map([["CF_Authorization", accessCookie]]));
  }
  async #send(url: URL, init: { method: string; body?: string }): Promise<{ url: URL; status: number; page: string; location?: string }> {
    if (!LAUNCH_HOSTS.includes(url.hostname) || url.protocol !== "https:") throw new Error(`Refusing to visit ${url.hostname}`);
    const jar = this.#cookies.get(url.hostname) ?? new Map<string, string>();
    const send = () => this.#fetch(url, { method: init.method, redirect: "manual", headers: {
      "user-agent": "EducateOS-Demo-Verification/1.0",
      // fetch's default `*` makes Canvas record its first locale, Arabic, as the person's browser
      // locale, which their real sessions (and an administrator's Act as user) then show.
      "accept-language": "en-US,en;q=0.9",
      ...(jar.size === 0 ? {} : { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
      ...(init.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    }, ...(init.body === undefined ? {} : { body: init.body }) });
    let response: Response | undefined;
    for (let attempt = 1; response === undefined; attempt++) {
      try {
        response = await send();
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code ?? "transport failed";
        // A connection that never opened sent nothing, so even a form post is safe to try again.
        if (attempt >= 3 || !CONNECT_FAILURES.has(cause)) throw new Error(`${init.method} ${url.hostname}${url.pathname}: ${cause}`, { cause: error });
      }
    }
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const at = pair!.indexOf("=");
      if (at > 0) { jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim()); this.#cookies.set(url.hostname, jar); }
    }
    const location = response.headers.get("location") ?? undefined;
    return { url, status: response.status, page: await response.text(), ...(location === undefined ? {} : { location }) };
  }
  /**
   * Opens `start` and follows the launch: redirects (307/308 re-post), protocol forms (OIDC login,
   * id_token and deep-linking JWT posts) and Canvas's platform-storage hop, until `done(page)`.
   * `pick` fills a content picker (a form with checkboxes and a session).
   */
  async follow(start: string, done: (page: string) => boolean, pick?: (form: PageForm) => PageForm["boxes"]): Promise<{ page: string; reached: boolean }> {
    let request: { url: URL; method: string; body?: string } = { url: new URL(start), method: "GET" };
    for (let step = 0; step < 16; step++) {
      const response = await this.#send(request.url, request);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location !== undefined) {
        const keep = response.status === 307 || response.status === 308;
        request = { url: new URL(response.location, response.url), method: keep ? request.method : "GET", ...(keep && request.body !== undefined ? { body: request.body } : {}) };
        continue;
      }
      if (response.status >= 400) return { page: response.page, reached: false };
      if (done(response.page)) return { page: response.page, reached: true };
      const forms = pageForms(response.page);
      const picker = forms.find((f) => isContentPicker(f, response.url.href));
      const protocol = forms.find((f) => f.fields.some(([n]) => ["iss", "id_token", "login_hint", "JWT"].includes(n)));
      const form = picker !== undefined && pick !== undefined ? { ...picker, fields: [...picker.fields, ...pick(picker).map((b) => [b.name, b.value] as [string, string])] } : protocol;
      if (form === undefined) {
        const storage = /<script[^>]+id="lti-storage-config"[^>]*>([\s\S]*?)<\/script>/.exec(response.page);
        const config = storage === null ? undefined : JSON.parse(storage[1]!) as { mode?: string; next?: string };
        if (config?.mode === "put" && config.next !== undefined) { request = { url: new URL(config.next, response.url), method: "GET" }; continue; }
        return { page: response.page, reached: false };
      }
      const target = new URL(form.action, response.url);
      const body = new URLSearchParams(form.fields).toString();
      request = form.method === "post" ? { url: target, method: "POST", body } : { url: new URL(`${target.origin}${target.pathname}?${body}`), method: "GET" };
    }
    return { page: "", reached: false };
  }
}

interface Connected { courseId: number; offeringId: string; toolId: number }
/** Each seeded course with its EducateOS tool installation (the tool whose URL is the district's launch). */
async function connectedCourses(admin: CanvasClient): Promise<Connected[]> {
  const plan = canvasDemoPlan();
  const courses = await admin.list<{ id: number; sis_course_id?: string }>(`accounts/${plan.accountId}/courses?per_page=100`);
  const result: Connected[] = [];
  for (const course of plan.courses) {
    const id = courses.find((c) => c.sis_course_id === course.sisId)?.id;
    if (id === undefined) continue;
    const tools = await admin.list<{ id: number; url?: string; context_type?: string }>(`courses/${id}/external_tools?per_page=100&include_parents=false`);
    const tool = tools.find((t) => t.url !== undefined && LAUNCH_HOSTS.slice(1).includes(new URL(t.url).hostname));
    if (tool !== undefined) result.push({ courseId: id, offeringId: course.offeringId, toolId: tool.id });
  }
  return result;
}

const launched = (page: string) => acceptedLaunch(page) !== undefined;

/** Course-navigation launches by each connected course's teacher and first enrolled learner. */
export async function courseLaunches(admin: CanvasClient, actors: CanvasActors, accessCookie: string, transport: typeof fetch = fetch) {
  const plan = canvasDemoPlan();
  const rows: { courseId: number; offeringId: string; principalId: string; role: "teacher" | "student"; accepted?: AcceptedLaunch }[] = [];
  const problems: string[] = [];
  for (const connected of await connectedCourses(admin)) {
    const course = plan.courses.find((c) => c.offeringId === connected.offeringId)!;
    const student = course.enrollments.find((e) => e.role === "student")?.principalId;
    for (const [role, principalId] of [["teacher", course.teacherId], ["student", student]] as const) {
      if (principalId === undefined) continue;
      const token = encodeURIComponent(await actors.session(principalId));
      const { page, reached } = await new LaunchBrowser(accessCookie, transport)
        .follow(`${CANVAS}/courses/${connected.courseId}/external_tools/${connected.toolId}?launch_type=course_navigation&session_token=${token}`, launched);
      const accepted = reached ? acceptedLaunch(page) : undefined;
      rows.push({ ...connected, principalId, role, ...(accepted === undefined ? {} : { accepted }) });
      if (accepted === undefined) problems.push(`${principalId}: launch in course ${connected.courseId} was not accepted`);
      else if (accepted.offeringId !== connected.offeringId) problems.push(`${principalId}: launched into ${accepted.offeringId}, not ${connected.offeringId}`);
      else if ((role === "student") !== (accepted.kind === "student")) problems.push(`${principalId}: launched as ${accepted.kind}`);
    }
  }
  if (rows.length === 0) problems.push("No connected course was found");
  return { rows, problems };
}

/** Deep linking in one course, and a learner launch of every item it created. */
export async function deepLinkAcceptance(admin: CanvasClient, actors: CanvasActors, accessCookie: string, offeringId: string, transport: typeof fetch = fetch) {
  const plan = canvasDemoPlan();
  const course = plan.courses.find((c) => c.offeringId === offeringId);
  const connected = (await connectedCourses(admin)).find((c) => c.offeringId === offeringId);
  if (course === undefined || connected === undefined) throw new Error(`${offeringId} is not a connected Canvas demo course`);
  const student = course.enrollments.find((e) => e.role === "student")!.principalId;
  const problems: string[] = [];
  const [module] = await admin.list<{ id: number }>(`courses/${connected.courseId}/modules?per_page=100`);
  if (module === undefined) throw new Error("The course has no module; run seed-canvas-demo.ts");
  type Item = { id: number; title: string; type: string; published: boolean; external_url?: string };
  const toolItems = async () => (await admin.list<Item>(`courses/${connected.courseId}/modules/${module.id}/items?per_page=100`))
    .filter((i) => i.type === "ExternalTool" && i.external_url !== undefined && LAUNCH_HOSTS.slice(1).includes(new URL(i.external_url).hostname));
  const browse = async (principalId: string, path: string, done: (p: string) => boolean, pick?: (f: PageForm) => PageForm["boxes"]) =>
    new LaunchBrowser(accessCookie, transport).follow(`${CANVAS}${path}${path.includes("?") ? "&" : "?"}session_token=${encodeURIComponent(await actors.session(principalId))}`, done, pick);
  const picker = `/courses/${connected.courseId}/external_tools/${connected.toolId}/resource_selection?placement=link_selection&context_module_id=${module.id}`;

  // A learner may not add content: Canvas must not hand them EducateOS's picker.
  const refused = await browse(student, picker, (p) => pageForms(p).some((f) => isContentPicker(f)));
  if (refused.reached) problems.push(`${student}: a learner reached the content picker`);

  let selected: { activityId: string; title: string }[] = [];
  let items = await toolItems();
  let outcome = "reused";
  if (items.length === 0) {
    // Done once the teacher has chosen and Canvas has answered the signed response: not before the
    // picker (Canvas's own launch page mentions deep linking too), nor at the response's auto-post.
    const { reached } = await browse(course.teacherId, picker, (p) => selected.length > 0 && !pageForms(p).some((f) => f.fields.some(([n]) => n === "JWT")),
      (form) => { const chosen = form.boxes.slice(0, 2); selected = chosen.map((b) => ({ activityId: b.value, title: b.label })); return chosen; });
    if (selected.length === 0) problems.push(`${course.teacherId}: the picker offered no activities`);
    items = await toolItems();
    outcome = reached ? "linked" : "picker did not return";
    // Publishing the new items is the teacher's next step, as themself.
    const teacher = (await actors.credentials([course.teacherId])).get(course.teacherId);
    for (const item of items.filter((i) => !i.published)) {
      if (teacher === undefined) break;
      await new CanvasClient(teacher.token).request("PUT", `courses/${connected.courseId}/modules/${module.id}/items/${item.id}`, { module_item: { published: true } });
    }
  }
  if (items.length < 2) problems.push(`Expected two deep-linked module items, found ${items.length}`);
  const launches: { itemId: number; title: string; accepted?: AcceptedLaunch }[] = [];
  for (const item of items) {
    const { page, reached } = await browse(student, `/courses/${connected.courseId}/modules/items/${item.id}`, launched);
    const accepted = reached ? acceptedLaunch(page) : undefined;
    launches.push({ itemId: item.id, title: item.title, ...(accepted === undefined ? {} : { accepted }) });
    if (accepted?.activityId === undefined) problems.push(`Item ${item.id} did not open an EducateOS activity`);
    else if (accepted.offeringId !== offeringId || accepted.kind !== "student" || accepted.messageType !== "LtiResourceLinkRequest") problems.push(`Item ${item.id} launched unexpectedly`);
    else if (selected.length > 0 && !selected.some((s) => s.activityId === accepted.activityId && s.title === item.title)) problems.push(`Item ${item.id} opened ${accepted.activityId}, not what the teacher selected`);
  }
  return { courseId: connected.courseId, moduleId: module.id, teacher: course.teacherId, student, outcome, selected, launches, problems };
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) flags.set(rest[i]!, rest[i + 1]!);
  const out = flags.get("--out"), cookieFile = flags.get("--access-cookie"), offering = flags.get("--offering");
  if (!out || !cookieFile || (mode !== "launches" && !(mode === "deep-link" && offering))) {
    throw new Error("usage: canvas-lti-acceptance.ts <launches | deep-link --offering <id>> --access-cookie <file> --out <new-report.json>");
  }
  const report = await open(out, "wx", 0o600);
  const accessCookie = (await readFile(cookieFile, "utf8")).trim();
  const actors = consoleActors(railsRunner(process.env.CANVAS_RAILS_RUNNER ? JSON.parse(process.env.CANVAS_RAILS_RUNNER) as string[] : undefined), "educateos-demo canvas lti acceptance");
  const admin = new CanvasClient(execFileSync("security", ["find-generic-password", "-s", "educateos-canvas-demo-admin-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  try {
    const result = mode === "launches" ? await courseLaunches(admin, actors, accessCookie) : await deepLinkAcceptance(admin, actors, accessCookie, offering!);
    await report.writeFile(JSON.stringify({ mode, at: new Date().toISOString(), ...result }, null, 2) + "\n");
    console.log(`Canvas LTI ${mode}: ${"rows" in result ? `${result.rows.filter((r) => r.accepted).length}/${result.rows.length} launches accepted` : `${result.outcome}; ${result.launches.filter((l) => l.accepted?.activityId).length}/${result.launches.length} items opened their activity`}; ${result.problems.length} problems`);
    for (const problem of result.problems) console.log(`problem: ${problem}`);
    if (result.problems.length > 0) process.exitCode = 1;
  } finally {
    await actors.expire();
    await report.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Canvas LTI acceptance failed"); process.exitCode = 1;
});
