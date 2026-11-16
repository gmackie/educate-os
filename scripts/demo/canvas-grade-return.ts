#!/usr/bin/env node
// Teacher-approved grade return to Canvas, in every Northfield showcase course (SCHO-413).
//
// For each course, every assignment that holds teacher-approved official grades in EducateOS gets
// a Canvas gradebook column through LTI AGS, labelled "[educateos-approved] <title>". Each approved
// grade is then published by the teacher who approved it, through their own EducateOS session,
// and each learner reads the score back from Canvas with their own short-lived credential:
//
// - a district administrator routes the offering's grades to its Canvas course, finds or creates
//   the column (one per assignment, found again by its resource ID on a rerun), and binds it to
//   the assignment;
// - the approving teacher publishes each grade (`/api/lti/passback`). Only they may: the district
//   reads the score from their approval, never from the request. Teachers sign in as presenters:
//   each grade band has one presenter sign-in (agent-inbox's teacher-k2/35/68/912), which an
//   administrator links to the band's teacher being acted as and links back afterwards;
// - each learner reads their own Canvas submission for the column and must see the approved score;
// - the administrator's attempt to publish a teacher's grade must be refused.
//
//   node scripts/demo/canvas-grade-return.ts run    --admin-cookie <file> --presenter <band>=<file> ... --out <new report>
//   node scripts/demo/canvas-grade-return.ts verify --admin-cookie <file> --presenter <band>=<file> ... --out <new report>
//
// Cookie files hold a CF_Authorization value for northfield.educateos.io (agent-inbox's
// scripts/access-sign-in.ts prints one). `verify` writes nothing to EducateOS or Canvas beyond
// presenter links, which it restores. Reruns publish nothing twice (the district answers
// `already-posted`). Canvas credentials are expired before exit; reports hold IDs and scores only.
import { open, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canvasDemoPlan, CanvasClient } from "./seed-canvas-demo.ts";
import { consoleActors, railsRunner, type CanvasActors, type RailsRunner } from "./canvas-actors.ts";
import { accessSubject, BANDS, showcaseClient, type Band, type ShowcaseClient } from "./seed-showcase.ts";

const DISTRICT = "https://northfield.educateos.io";
const CANVAS = "https://canvas.mackie.house";
const LABEL = "[educateos-approved]";

/** A district response that was not 2xx, with its status. */
export class DistrictError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** One EducateOS session, signed in by an Access cookie. */
export type DistrictRequest = <T>(cookie: string, method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

export function districtRequest(origin = DISTRICT, transport: typeof fetch = fetch): DistrictRequest {
  return async <T>(cookie: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await transport(`${origin}${path}`, {
      method, redirect: "manual",
      headers: { cookie: `CF_Authorization=${cookie}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.json().then((b) => (b as { code?: string }).code ?? "", () => "");
      throw new DistrictError(response.status, `${method} ${path}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    return await response.json() as T;
  };
}

interface Registration { issuer: string; clientId: string; offerings: { offeringId: string; contextId: string }[] }
interface Gradebook {
  columns: { assignmentId: string; title: string; pointsPossible: number | null }[];
  rows: { studentPrincipalId: string; cells: { assignmentId: string; score?: { points: number; maxPoints: number }; version?: number }[] }[];
}
interface LineItem { id: string }
interface Directory { offerings: { id: string }[]; enrollments: { offeringId: string; principalId: string; role: string; status: string }[] }

/** An approved grade to return: one student's official grade version on one assignment. */
export interface ApprovedGrade { assignmentId: string; title: string; studentId: string; version: number; points: number; maxPoints: number }

/** The approved grades a gradebook holds, grouped by assignment in column order. */
export function approvedGrades(gradebook: Gradebook): Map<string, ApprovedGrade[]> {
  const byAssignment = new Map<string, ApprovedGrade[]>();
  for (const column of gradebook.columns) {
    const grades: ApprovedGrade[] = [];
    for (const row of gradebook.rows) {
      const cell = row.cells.find((c) => c.assignmentId === column.assignmentId);
      if (cell?.score === undefined || cell.version === undefined) continue;
      grades.push({ assignmentId: column.assignmentId, title: column.title, studentId: row.studentPrincipalId, version: cell.version, points: cell.score.points, maxPoints: cell.score.maxPoints });
    }
    if (grades.length > 0) byAssignment.set(column.assignmentId, grades);
  }
  return byAssignment;
}

/**
 * A course's AGS column for an EducateOS assignment. `omitted` says whether Canvas leaves it out of
 * the course total, as it must: the work it grades is already a Canvas assignment of its own, and
 * counting both would count it twice (SCHO-422).
 */
export interface CanvasColumn { lineItemId: number; canvasAssignmentId: number; omitted: boolean }

/** The Canvas side: a course's AGS column for an EducateOS assignment, found by its resource ID. */
export interface CanvasColumns {
  find(courseId: number, assignmentId: string): Promise<CanvasColumn | undefined>;
  /** Drops what `find` has read, after a column was created. */
  forget(): void;
}

/**
 * Looks AGS columns up in the Canvas console, since the REST API does not list them by resource
 * ID. Each console start takes seconds, so the account's EducateOS columns are read in one go.
 */
export function consoleColumns(run: RailsRunner, accountId: number): CanvasColumns {
  type Row = CanvasColumn & { courseId: number; resourceId: string };
  let columns: Promise<Row[]> | undefined;
  return {
    async find(courseId, assignmentId) {
      if (!Number.isSafeInteger(accountId)) throw new Error("Refusing an unsafe column lookup");
      columns ??= Promise.resolve(run(`require "json"
rows=Lti::LineItem.active.where("resource_id LIKE 'asg_%'").joins(:assignment).where(assignments:{context_type:"Course",context_id:Course.where(account_id:${accountId}).select(:id)}).order(:id).map{|li|
 {courseId:li.assignment.context_id,resourceId:li.resource_id,lineItemId:li.id,canvasAssignmentId:li.assignment_id,omitted:!!li.assignment.omit_from_final_grade}}
puts "DATA="+JSON.generate(rows)`) as Row[]);
      const found = (await columns).find((c) => c.courseId === courseId && c.resourceId === assignmentId);
      return found === undefined ? undefined : { lineItemId: found.lineItemId, canvasAssignmentId: found.canvasAssignmentId, omitted: found.omitted };
    },
    forget() { columns = undefined; },
  };
}

/** A row of the report: one grade's return and readback. */
export interface GradeReturnRow {
  offeringId: string; courseId: number; assignmentId: string; column: string; studentId: string; version: number;
  points: number; maxPoints: number; publishedBy?: string; outcome: string; readback?: number | null;
}

export interface GradeReturnOptions {
  mode: "run" | "verify";
  adminCookie: string;
  /** Each band's presenter sign-in. */
  presenters: Partial<Record<Band, string>>;
  district: DistrictRequest;
  showcase: ShowcaseClient;
  subjectOf(cookie: string): Promise<string>;
  /** The account administrator's Canvas API client. */
  canvas: Pick<CanvasClient, "list" | "request">;
  canvasClient(token: string): Pick<CanvasClient, "request">;
  actors: CanvasActors;
  columns: CanvasColumns;
  log?(line: string): void;
}

export async function canvasGradeReturn(o: GradeReturnOptions) {
  const log = o.log ?? (() => {});
  const plan = canvasDemoPlan();
  const rows: GradeReturnRow[] = [];
  const refusals: { offeringId: string; status: number | "allowed" }[] = [];
  const problems: string[] = [];

  const registrations = (await o.district<{ registrations: Registration[] } | Registration[]>(o.adminCookie, "GET", "/api/lti/registrations"));
  const contexts = new Map<string, { issuer: string; clientId: string; contextId: string }>();
  for (const r of Array.isArray(registrations) ? registrations : registrations.registrations) {
    if (r.issuer !== CANVAS) continue;
    for (const link of r.offerings) contexts.set(link.offeringId, { issuer: r.issuer, clientId: r.clientId, contextId: link.contextId });
  }
  const exported = await o.showcase.exportDistrict() as { directory: Directory };
  const courses = await o.canvas.list<{ id: number; sis_course_id?: string }>(`accounts/${plan.accountId}/courses?per_page=100`);

  // Presenters: who each is, and who they are linked to now, so every link is restored.
  const presenters = new Map<Band, { cookie: string; subject: string; original: string; current: string }>();
  for (const band of BANDS) {
    const cookie = o.presenters[band];
    if (cookie === undefined) continue;
    const me = await o.district<{ principalId: string }>(cookie, "GET", "/api/me");
    presenters.set(band, { cookie, subject: await o.subjectOf(cookie), original: me.principalId, current: me.principalId });
  }
  const actAs = async (band: Band, teacherId: string) => {
    const presenter = presenters.get(band)!;
    if (presenter.current !== teacherId) {
      await o.showcase.link(presenter.subject, teacherId);
      presenter.current = teacherId;
    }
    return presenter.cookie;
  };

  const learners = [...new Set(plan.courses.flatMap((c) => c.enrollments.filter((e) => e.role === "student").map((e) => e.principalId)))];
  const credentials = await o.actors.credentials(learners);

  try {
    for (const course of plan.courses) {
      const { offeringId } = course;
      const context = contexts.get(offeringId);
      const courseId = courses.find((c) => c.sis_course_id === course.sisId)?.id;
      const band = course.band as Band;
      if (context === undefined || courseId === undefined) { problems.push(`${offeringId}: not connected to a Canvas course`); continue; }
      if (!presenters.has(band)) { problems.push(`${offeringId}: no presenter sign-in for its band`); continue; }
      // The plan's Canvas teacher first, then any other teacher of the offering in EducateOS.
      const teachers = [...new Set([course.teacherId, ...exported.directory.enrollments
        .filter((e) => e.offeringId === offeringId && e.status === "active" && (e.role === "teacher" || e.role === "co-teacher"))
        .map((e) => e.principalId)])];

      const gradebook = await o.district<Gradebook>(await actAs(band, teachers[0]!), "GET", `/api/teacher/offerings/${offeringId}/gradebook`);
      const approved = approvedGrades(gradebook);
      if (approved.size === 0) { problems.push(`${offeringId}: no teacher-approved grades to return`); continue; }
      if (o.mode === "run") await o.district(o.adminCookie, "POST", "/api/lti/grade-routes", { offeringId, ...context });

      for (const [assignmentId, grades] of approved) {
        const title = grades[0]!.title;
        let found = await o.columns.find(courseId, assignmentId);
        if (found === undefined && o.mode === "run") {
          const scoreMaximum = gradebook.columns.find((c) => c.assignmentId === assignmentId)?.pointsPossible ?? grades[0]!.maxPoints;
          await o.district<LineItem>(o.adminCookie, "POST", "/api/lti/line-items", { offeringId, ...context, label: `${LABEL} ${title}`, scoreMaximum, resourceId: assignmentId });
          o.columns.forget();
          found = await o.columns.find(courseId, assignmentId);
        }
        if (found === undefined) { problems.push(`${offeringId}: no Canvas column for ${assignmentId}`); continue; }
        if (!found.omitted) {
          if (o.mode === "run") {
            await o.canvas.request("PUT", `courses/${courseId}/assignments/${found.canvasAssignmentId}`, { assignment: { omit_from_final_grade: true } });
            found = { ...found, omitted: true };
          } else problems.push(`${offeringId}: the Canvas column for ${assignmentId} counts toward the course total`);
        }
        const column = `${CANVAS}/api/lti/courses/${courseId}/line_items/${found.lineItemId}`;
        if (o.mode === "run") await o.district(o.adminCookie, "POST", "/api/lti/grade-columns", { offeringId, column, assignmentId });

        for (const grade of grades) {
          const row: GradeReturnRow = { offeringId, courseId, assignmentId, column, studentId: grade.studentId, version: grade.version, points: grade.points, maxPoints: grade.maxPoints, outcome: "not-published" };
          rows.push(row);
          if (o.mode === "run") {
            for (const teacherId of teachers) {
              try {
                const result = await o.district<{ status: string }>(await actAs(band, teacherId), "POST", "/api/lti/passback",
                  { offeringId, studentId: grade.studentId, column, gradeVersion: grade.version });
                row.publishedBy = teacherId; row.outcome = result.status;
                break;
              } catch (error) {
                // Another teacher approved it: only the approver may publish.
                if (error instanceof DistrictError && error.status === 403) continue;
                row.outcome = `failed: ${(error as Error).message}`;
                break;
              }
            }
            if (row.outcome === "not-published") problems.push(`${offeringId}: no teacher of the class could publish ${grade.studentId}'s grade on ${assignmentId}`);
          }
          const learner = credentials.get(grade.studentId);
          if (learner === undefined) { problems.push(`${grade.studentId}: no Canvas login`); continue; }
          const mine = await o.canvasClient(learner.token).request<{ score: number | null }>("GET", `courses/${courseId}/assignments/${found.canvasAssignmentId}/submissions/self`)
            .then((r) => r.value, () => undefined);
          row.readback = mine?.score ?? null;
          if (mine?.score !== grade.points) problems.push(`${grade.studentId}: reads ${mine?.score ?? "no score"} on ${title}, not the approved ${grade.points}`);
        }

        // Publishing is the approving teacher's alone: the administrator who set all of this up may not.
        const first = grades[0]!;
        const status = await o.district(o.adminCookie, "POST", "/api/lti/passback", { offeringId, studentId: first.studentId, column, gradeVersion: first.version })
          .then(() => "allowed" as const, (e: unknown) => e instanceof DistrictError ? e.status : 0);
        refusals.push({ offeringId, status });
        if (status !== 403) problems.push(`${offeringId}: an administrator's publish answered ${status}, not 403`);
      }
      log(`${offeringId}: ${rows.filter((r) => r.offeringId === offeringId).length} grades`);
    }
  } finally {
    for (const presenter of presenters.values()) {
      if (presenter.current !== presenter.original) await o.showcase.link(presenter.subject, presenter.original);
    }
  }
  return { rows, refusals, problems };
}

const readCookie = async (file: string) => (await readFile(file, "utf8")).trim();

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) flags.set(args[i]!, [...flags.get(args[i]!) ?? [], args[i + 1] ?? ""]);
  const out = flags.get("--out")?.[0];
  const adminFile = flags.get("--admin-cookie")?.[0];
  if ((mode !== "run" && mode !== "verify") || !out || !adminFile) {
    throw new Error("usage: canvas-grade-return.ts <run|verify> --admin-cookie <file> --presenter <band>=<file> ... --out <new-report.json>");
  }
  const presenters: Partial<Record<Band, string>> = {};
  for (const spec of flags.get("--presenter") ?? []) {
    const [band, file] = spec.split("=") as [Band, string];
    if (!BANDS.includes(band) || !file) throw new Error(`--presenter takes <band>=<file>, with a band of ${BANDS.join(", ")}`);
    presenters[band] = await readCookie(file);
  }
  const report = await open(out, "wx", 0o600);
  const adminCookie = await readCookie(adminFile);
  const runner = railsRunner(process.env.CANVAS_RAILS_RUNNER ? JSON.parse(process.env.CANVAS_RAILS_RUNNER) as string[] : undefined);
  const actors = consoleActors(runner, "educateos-demo canvas grade return");
  const canvas = new CanvasClient(execFileSync("security", ["find-generic-password", "-s", "educateos-canvas-demo-admin-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  try {
    const result = await canvasGradeReturn({
      mode, adminCookie, presenters,
      district: districtRequest(),
      showcase: showcaseClient(DISTRICT, adminCookie),
      subjectOf: async (cookie) => (await accessSubject(DISTRICT, cookie)).subject,
      canvas, canvasClient: (token) => new CanvasClient(token), actors, columns: consoleColumns(runner, canvasDemoPlan().accountId),
      log: (line) => console.log(line),
    });
    await report.writeFile(JSON.stringify({ mode, at: new Date().toISOString(), ...result }, null, 2) + "\n");
    const read = result.rows.filter((r) => r.readback === r.points).length;
    console.log(`Canvas grade return ${mode}: ${result.rows.length} approved grades in ${new Set(result.rows.map((r) => r.offeringId)).size} courses; ${read} read back by their learner; ${result.refusals.filter((r) => r.status === 403).length}/${result.refusals.length} administrator publishes refused; ${result.problems.length} problems`);
    for (const problem of result.problems) console.log(`problem: ${problem}`);
    if (result.problems.length > 0) process.exitCode = 1;
  } finally {
    const active = await actors.expire();
    await report.close();
    if (active !== 0) { console.error(`${active} demo credentials are still active`); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Canvas grade return failed"); process.exitCode = 1;
});
