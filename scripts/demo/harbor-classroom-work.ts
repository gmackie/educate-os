#!/usr/bin/env node
// Learner work and teacher review in Harbor's real Classroom courses (SCHO-354). Every learner
// acts as themself with a token delegated to their own synthetic account (`classroom.coursework.me`,
// so it can reach only their own submission); every grade is set and returned by that course's
// own teacher. The calls are the ones the Google connector's student and teacher APIs make.
//
//   node scripts/demo/harbor-classroom-work.ts run    --out <new report>   turn in, grade, return
//   node scripts/demo/harbor-classroom-work.ts verify --out <new report>   GET-only readback
//
// `run` turns in each learner's submission on both of a course's seeded activities. The teacher
// then grades and returns the first activity with the synthetic scores below, and leaves the
// second turned in for review. A rerun changes nothing, and a grade a teacher has since edited, or
// review work a teacher has since graded and returned, is kept and reported, never overwritten. Only app-owned `[educateos-demo:` work is touched. Reports
// hold IDs, states and scores, never credentials.
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { serviceAccountTokens, CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES } from "../../packages/educateos-integrations/src/google-classroom/service-account.ts";
import { harborCourseworkPlan } from "./seed-harbor-classroom.ts";

const COURSEWORK_ME = "https://www.googleapis.com/auth/classroom.coursework.me";

/** Synthetic teacher scores (of 10) for each course's first activity, by learner account. Invented. */
export const HARBOR_SCORES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "off_hb-marine-b1": { "hb-student-nia": 9, "hb-student-pia": 8, "hb-student-owen": 7 },
  "off_hb-comp-b2": { "hb-student-nia": 8, "hb-student-pia": 9, "hb-student-quentin": 7, "hb-student-owen": 8 },
  "off_hb-gov-b3": { "hb-student-pia": 9 },
  "off_hb-math7-b1": { "hb-student-rosa": 10, "hb-student-sami": 8 },
};

interface Tokens { token(subject: string): Promise<string> }
interface Submission { id: string; userId: string; state: string; assignedGrade?: number }
interface Work { id: string; title: string; associatedWithDeveloper?: boolean }

/** A Classroom call failed; `status` is the HTTP status, if there was a response. */
export class ClassroomCallError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, what: string) {
    super(`Classroom ${what}: ${status === undefined ? "transport failed" : `HTTP ${status}`}; verify before retrying a write`);
    this.status = status;
  }
}

/** One row of the report: a learner's submission after the run. */
export interface WorkRow { offeringId: string; courseId: string; workId: string; learner: string; state: string; grade: number | null; outcome: string }

/** Runs (or, in `verify`, only reads) Harbor's learner submissions and teacher review. */
export async function harborClassroomWork(student: Tokens, teacher: Tokens, mode: "run" | "verify", transport: typeof fetch = fetch) {
  async function call<T>(tokens: Tokens, subject: string, method: string, path: string, body?: unknown): Promise<T> {
    const what = `${method} ${path.split("?")[0]}`;
    const response = await transport(`https://classroom.googleapis.com/v1/${path}`, {
      method, redirect: "manual",
      headers: { authorization: `Bearer ${await tokens.token(subject)}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => { throw new ClassroomCallError(undefined, what); });
    if (!response.ok) { await response.body?.cancel(); throw new ClassroomCallError(response.status, what); }
    return response.json() as Promise<T>;
  }
  const rows: WorkRow[] = [];
  const problems: string[] = [];
  const isolation: { learner: string; attempt: string; status: number | string }[] = [];
  for (const planned of harborCourseworkPlan()) {
    const asTeacher = <T>(method: string, path: string, body?: unknown) => call<T>(teacher, planned.ownerEmail, method, path, body);
    const course = await asTeacher<{ id: string }>("GET", `courses/${encodeURIComponent(planned.alias)}`);
    const students = ((await asTeacher<{ students?: { userId: string; profile: { emailAddress?: string } }[] }>("GET", `courses/${course.id}/students?pageSize=100`)).students ?? [])
      .flatMap((s) => s.profile.emailAddress === undefined ? [] : [{ userId: s.userId, email: s.profile.emailAddress }]);
    const works = (await asTeacher<{ courseWork?: Work[] }>("GET", `courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`)).courseWork ?? [];
    const ordered = planned.lessons.map((lesson) => works.find((w) => w.title === lesson.title && w.associatedWithDeveloper === true));
    if (ordered.some((w) => w === undefined)) {
      problems.push(`${planned.fixtureId}: a seeded app-owned activity is missing; run seed-harbor-classroom.ts verify`);
      continue;
    }
    for (const [index, work] of ordered.entries()) {
      const base = `courses/${course.id}/courseWork/${work!.id}/studentSubmissions`;
      for (const member of students) {
        const learner = member.email.split("@")[0]!;
        const own = async () => {
          const mine = (await call<{ studentSubmissions?: Submission[] }>(student, member.email, "GET", `${base}?userId=me`)).studentSubmissions ?? [];
          if (mine.length !== 1) throw new Error(`${learner}: expected exactly one own submission on ${work!.id}`);
          return mine[0]!;
        };
        let mine = await own();
        let outcome = "unchanged";
        if (mode === "run" && (mine.state === "CREATED" || mine.state === "NEW" || mine.state === "RECLAIMED_BY_STUDENT")) {
          await call(student, member.email, "POST", `${base}/${mine.id}:turnIn`, {});
          outcome = "turned in";
        }
        const score = index === 0 ? HARBOR_SCORES[planned.fixtureId]?.[learner] : undefined;
        if (score !== undefined) {
          const seen = await asTeacher<Submission>("GET", `${base}/${mine.id}`);
          if (seen.assignedGrade === undefined) {
            // As the connector's gradeAndReturn: only turned-in work is graded, then returned.
            if (mode === "run" && seen.state === "TURNED_IN") {
              await asTeacher("PATCH", `${base}/${mine.id}?updateMask=assignedGrade`, { assignedGrade: score });
              await asTeacher("POST", `${base}/${mine.id}:return`, {});
              outcome = outcome === "unchanged" ? "graded and returned" : `${outcome}, graded and returned`;
            }
          } else if (seen.assignedGrade !== score) {
            outcome = `teacher grade ${seen.assignedGrade} kept`;
          }
        }
        mine = await own();
        // Work left for review may since have been graded and returned by its teacher (as the
        // Workshop's approved Classroom grading does, SCHO-402): that is kept and reported.
        const reviewed = score === undefined && mine.state === "RETURNED" && mine.assignedGrade !== undefined;
        if (reviewed && outcome === "unchanged") outcome = `teacher returned ${mine.assignedGrade}`;
        const expected = score === undefined ? "TURNED_IN" : "RETURNED";
        if (mine.state !== expected && !reviewed) problems.push(`${learner}: ${work!.id} is ${mine.state}, expected ${expected}`);
        if (score !== undefined && mine.assignedGrade === undefined) problems.push(`${learner}: ${work!.id} has no returned grade`);
        rows.push({ offeringId: planned.fixtureId, courseId: course.id, workId: work!.id, learner, state: mine.state, grade: mine.assignedGrade ?? null, outcome });
      }
    }
    // A learner cannot read a classmate's submission, or grade or return one.
    const [a, b] = students;
    if (a !== undefined && b !== undefined) {
      const base = `courses/${course.id}/courseWork/${ordered[0]!.id}/studentSubmissions`;
      const theirs = (await asTeacher<{ studentSubmissions?: Submission[] }>("GET", `${base}?userId=${b.userId}`)).studentSubmissions?.[0];
      for (const [attempt, method, path, body] of [
        ["read classmate", "GET", `${base}/${theirs!.id}`, undefined],
        ["grade classmate", "PATCH", `${base}/${theirs!.id}?updateMask=assignedGrade`, { assignedGrade: 1 }],
      ] as const) {
        const status = await call(student, a.email, method, path, body).then(() => "allowed" as const, (e: unknown) => e instanceof ClassroomCallError ? e.status ?? "transport" : "error");
        isolation.push({ learner: a.email.split("@")[0]!, attempt, status });
        if (status === "allowed" || status === "transport" || status === "error") problems.push(`${a.email.split("@")[0]}: ${attempt} was not refused (${status})`);
      }
    }
  }
  return { rows, isolation, problems };
}

async function main() {
  const [mode, flag, out] = process.argv.slice(2);
  if ((mode !== "run" && mode !== "verify") || flag !== "--out" || !out) {
    throw new Error("Usage: harbor-classroom-work.ts run|verify --out <new report file>");
  }
  const report = await open(out, "wx", 0o600);
  const encoded = execFileSync("security", ["find-generic-password", "-s", "educateos-classroom-demo-sa-key", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const key: unknown = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  const teacher = serviceAccountTokens({ key, scopes: [...CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES.courseworkStudents], fetch });
  const student = serviceAccountTokens({ key, scopes: [GOOGLE_SCOPES.courses, COURSEWORK_ME], fetch });
  const result = await harborClassroomWork(student, teacher, mode);
  await report.writeFile(JSON.stringify({ mode, at: new Date().toISOString(), ...result }, null, 2));
  await report.close();
  const count = (state: string) => result.rows.filter((r) => r.state === state).length;
  console.log(`${mode}: ${result.rows.length} submissions, ${count("RETURNED")} returned, ${count("TURNED_IN")} awaiting review; ${result.isolation.length} isolation checks; ${result.problems.length} problems`);
  for (const problem of result.problems) console.log(`problem: ${problem}`);
  if (result.problems.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) await main();
