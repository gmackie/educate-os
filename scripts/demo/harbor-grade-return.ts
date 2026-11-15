#!/usr/bin/env node
// Harbor's teacher-approved grade return to Google Classroom (SCHO-428), end to end, each step by
// the person who does it in the product:
//
//   1. Kwame Asante assigns an EducateOS activity in Marine Science (once; found again by title).
//   2. Nia Fontaine submits her work, as herself.
//   3. Kwame records and approves her grade.
//   4. The district administrator routes Marine Science's grades to its Classroom course and gives
//      the assignment its "[educateos-approved]" coursework.
//   5. Kwame publishes the grade; an administrator's attempt to publish it is refused.
//   6. Kwame returns her work in Classroom (as the course's owner, with the existing delegation),
//      since Classroom shows a student a grade only once it is returned. Classroom's API returns
//      only turned-in work, so Nia first turns in her Classroom copy of the work, as herself.
//   7. Nia reads the grade back from her own Classroom submission and from Harbor's "From Google
//      Classroom" panel.
//
//   node scripts/demo/harbor-grade-return.ts run|verify --admin-cookie <file> --teacher-cookie <file> \
//     --student-cookie <file> --out <new report>
//
// Each cookie file holds a CF_Authorization value for harbor.educateos.io: the owner's (Marisol
// Vega), teacher@agents.gmac.io's (Kwame) and student@agents.gmac.io's (Nia). `verify` makes no
// writes. Classroom credentials come from Keychain (`educateos-classroom-demo-sa-key`); reports
// hold IDs, states and scores, never credentials.
import { execFileSync } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { serviceAccountTokens, CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES } from "../../packages/educateos-integrations/src/google-classroom/service-account.ts";
import { DistrictError, districtRequest, type DistrictRequest } from "./canvas-grade-return.ts";
import { harborCourseworkPlan } from "./seed-harbor-classroom.ts";

const HARBOR = "https://harbor.educateos.io";
const COURSEWORK_ME = "https://www.googleapis.com/auth/classroom.coursework.me";

/** The assignment Kwame gives, and the grade he approves for Nia. Invented. */
export const HARBOR_ASSIGNMENT = {
  title: "Rocky Shore Field Notes",
  overview: "Record what lives in one rocky-shore zone and explain how it survives the tide.",
  prompt: "Choose the high, middle or low intertidal zone. Describe three organisms you would find there and how each one copes with being uncovered at low tide.",
  answer: "I chose the middle intertidal zone. Mussels close their shells tight and hold water inside. Barnacles seal their plates and wait for the tide. Sea stars cling under ledges where it stays wet.",
  points: 9,
  maxPoints: 10,
} as const;
const COLUMN_TITLE = `[educateos-approved] ${HARBOR_ASSIGNMENT.title}`;

/** Classroom calls as one Google account. */
export type ClassroomAs = <T>(email: string, method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

interface Assignment { id: string; title: string }
interface GradeVersion { version: number; score: { points: number; maxPoints: number } }

export interface HarborGradeReturnOptions {
  mode: "run" | "verify";
  district: DistrictRequest;
  cookies: { admin: string; teacher: string; student: string };
  /** Classroom as the course owner (the teacher's delegation) and as a student (their own work only). */
  classroom: { owner: ClassroomAs; student: ClassroomAs };
  log?(line: string): void;
}

/** One report: what each step found or did. */
export interface HarborGradeReturn {
  offeringId?: string; assignmentId?: string; courseWorkId?: string; gradeVersion?: number;
  steps: { step: string; outcome: string }[];
  readback: { classroom?: { state: string; assignedGrade: number | null }; harbor?: number | null };
  adminPublish?: number | "allowed";
  problems: string[];
}

export async function harborGradeReturn(o: HarborGradeReturnOptions): Promise<HarborGradeReturn> {
  const { district, cookies, mode } = o;
  const log = o.log ?? (() => {});
  const result: HarborGradeReturn = { steps: [], readback: {}, problems: [] };
  const step = (name: string, outcome: string) => { result.steps.push({ step: name, outcome }); log(`${name}: ${outcome}`); };
  const fail = (problem: string) => { result.problems.push(problem); return result; };

  // Who each session is: the right people, or nothing is done.
  const who = async (cookie: string) => (await district<{ principalId: string; displayName: string }>(cookie, "GET", "/api/me"));
  const [admin, teacher, student] = [await who(cookies.admin), await who(cookies.teacher), await who(cookies.student)];
  for (const [person, expected] of [[admin, "Marisol Vega"], [teacher, "Kwame Asante"], [student, "Nia Fontaine"]] as const) {
    if (person.displayName !== expected) return fail(`a session is ${person.displayName}, not ${expected}`);
  }

  const offerings = await district<{ id?: string; offering?: { id: string }; title?: string; course?: { title: string } }[]>(cookies.teacher, "GET", "/api/teacher/offerings");
  const marine = offerings.map((x) => ({ id: x.offering?.id ?? x.id!, title: x.course?.title ?? x.title ?? "" })).find((x) => x.title.startsWith("Marine Science"));
  if (marine === undefined) return fail("Kwame does not teach Marine Science");
  const offeringId = result.offeringId = marine.id;

  // 1. The assignment.
  let assignment = (await district<Assignment[]>(cookies.teacher, "GET", `/api/teacher/offerings/${offeringId}/assignments`)).find((a) => a.title === HARBOR_ASSIGNMENT.title);
  if (assignment === undefined && mode === "run") {
    const draft = await district<{ id: string }>(cookies.teacher, "POST", `/api/teacher/offerings/${offeringId}/activities`, { activity: {
      template: "writing-task", title: HARBOR_ASSIGNMENT.title, subject: "science", gradeBand: "9-12",
      overview: HARBOR_ASSIGNMENT.overview, aiHelp: "hints-only", due: { kind: "after-install", days: 7 },
      prompt: HARBOR_ASSIGNMENT.prompt, genre: "informative", minimumCitations: 0,
    } });
    await district(cookies.teacher, "POST", `/api/teacher/activity-definitions/${draft.id}/publish`);
    assignment = (await district<{ assignment: Assignment }>(cookies.teacher, "POST", `/api/teacher/activity-definitions/${draft.id}/install`, { offeringId, assignment: {} })).assignment;
    step("assignment", "created by Kwame");
  } else step("assignment", assignment === undefined ? "missing" : "found");
  if (assignment === undefined) return fail(`Marine Science has no "${HARBOR_ASSIGNMENT.title}" assignment`);
  const assignmentId = result.assignmentId = assignment.id;

  // 2. Nia's submission.
  let [submission] = await district<{ id: string }[]>(cookies.student, "GET", `/api/student/assignments/${assignmentId}/submissions`);
  if (submission === undefined && mode === "run") {
    const workspace = await district<{ id: string }>(cookies.student, "POST", `/api/student/offerings/${offeringId}/workspace`);
    const saved = await district<{ artifact: { id: string }; head: { id: string } }>(cookies.student, "POST", "/api/student/artifacts", {
      workspaceId: workspace.id, title: `${HARBOR_ASSIGNMENT.title}: Draft`, type: "document",
      content: { kind: "text", mediaType: "text/plain", text: HARBOR_ASSIGNMENT.answer },
    });
    await district(cookies.student, "POST", `/api/student/assignments/${assignmentId}/submissions`, { revisions: [{ artifactId: saved.artifact.id, revisionId: saved.head.id }] });
    [submission] = await district<{ id: string }[]>(cookies.student, "GET", `/api/student/assignments/${assignmentId}/submissions`);
    step("submission", "submitted by Nia");
  } else step("submission", submission === undefined ? "missing" : "found");
  if (submission === undefined) return fail("Nia has not submitted");

  // 3. Kwame's approved grade.
  const gradesPath = `/api/teacher/assignments/${assignmentId}/students/${student.principalId}/grades`;
  let grades = await district<GradeVersion[]>(cookies.teacher, "GET", gradesPath);
  if (grades.length === 0 && mode === "run") {
    const recorded = await district<{ status: string; proposal?: { id: string } }>(cookies.teacher, "POST", `/api/teacher/submissions/${submission.id}/grade`,
      { score: { points: HARBOR_ASSIGNMENT.points, maxPoints: HARBOR_ASSIGNMENT.maxPoints } });
    if (recorded.status === "pending-approval") await district(cookies.teacher, "POST", `/api/teacher/grade-proposals/${recorded.proposal!.id}/approve`);
    grades = await district<GradeVersion[]>(cookies.teacher, "GET", gradesPath);
    step("grade", "recorded and approved by Kwame");
  } else step("grade", grades.length === 0 ? "missing" : "found");
  const grade = grades.at(-1);
  if (grade === undefined) return fail("Nia's grade is not approved");
  result.gradeVersion = grade.version;

  // 4. The route and column, set up by the administrator.
  let courseWorkId: string | undefined;
  if (mode === "run") {
    await district(cookies.admin, "POST", "/api/lti/classroom/grade-routes", { offeringId });
    const column = await district<{ courseWork: { id: string }; created: boolean }>(cookies.admin, "POST", "/api/lti/classroom/columns",
      { offeringId, assignmentId, maxPoints: grade.score.maxPoints });
    courseWorkId = column.courseWork.id;
    step("classroom column", column.created ? "created by the administrator" : "found");
  }
  const planned = harborCourseworkPlan().find((c) => c.fixtureId === "off_hb-marine-b1")!;
  const course = await o.classroom.owner<{ id: string }>(planned.ownerEmail, "GET", `courses/${encodeURIComponent(planned.alias)}`);
  const works = (await o.classroom.owner<{ courseWork?: { id: string; title: string; associatedWithDeveloper?: boolean }[] }>(planned.ownerEmail, "GET",
    `courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`)).courseWork ?? [];
  const work = works.find((w) => w.title === COLUMN_TITLE && w.associatedWithDeveloper === true && (courseWorkId === undefined || w.id === courseWorkId));
  if (work === undefined) return fail(`Classroom has no ${COLUMN_TITLE} coursework`);
  courseWorkId = result.courseWorkId = work.id;

  // 5. Kwame publishes; the administrator who set it up may not.
  const publish = { offeringId, studentId: student.principalId, column: courseWorkId, gradeVersion: grade.version };
  if (mode === "run") {
    const published = await district<{ status: string }>(cookies.teacher, "POST", "/api/lti/passback", publish);
    step("publish", `${published.status} by Kwame`);
  }
  result.adminPublish = await district(cookies.admin, "POST", "/api/lti/passback", publish)
    .then(() => "allowed" as const, (e: unknown) => e instanceof DistrictError ? e.status : 0);
  if (result.adminPublish !== 403) result.problems.push(`an administrator's publish answered ${result.adminPublish}, not 403`);

  // 6. Returned in Classroom, so Nia can see it.
  const base = `courses/${course.id}/courseWork/${courseWorkId}/studentSubmissions`;
  const roster = (await o.classroom.owner<{ students?: { userId: string; profile: { emailAddress?: string } }[] }>(planned.ownerEmail, "GET", `courses/${course.id}/students?pageSize=100`)).students ?? [];
  const nia = roster.find((s) => s.profile.emailAddress?.startsWith("hb-student-nia@"));
  if (nia === undefined) return fail("Nia is not on the Classroom roster");
  const [theirs] = (await o.classroom.owner<{ studentSubmissions?: { id: string; state: string; assignedGrade?: number }[] }>(planned.ownerEmail, "GET", `${base}?userId=${nia.userId}`)).studentSubmissions ?? [];
  if (theirs === undefined) return fail("Nia has no Classroom submission for the column");
  if (theirs.state !== "RETURNED" && mode === "run") {
    // Classroom's API returns only work that was turned in, so Nia first turns in her Classroom copy
    // of the work she submitted in EducateOS, as herself (her token reaches only her own work).
    if (theirs.state !== "TURNED_IN") {
      await o.classroom.student(nia.profile.emailAddress!, "POST", `${base}/${theirs.id}:turnIn`, {});
      step("turn in", "turned in by Nia in Classroom");
    }
    await o.classroom.owner(planned.ownerEmail, "POST", `${base}/${theirs.id}:return`, {});
    step("return", "returned by Kwame in Classroom");
  }

  // 7. Nia reads it back, from Classroom and from Harbor.
  const [mine] = (await o.classroom.student<{ studentSubmissions?: { state: string; assignedGrade?: number }[] }>(nia.profile.emailAddress!, "GET", `${base}?userId=me`)).studentSubmissions ?? [];
  result.readback.classroom = { state: mine?.state ?? "none", assignedGrade: mine?.assignedGrade ?? null };
  if (mine?.state !== "RETURNED" || mine.assignedGrade !== grade.score.points) {
    result.problems.push(`Nia's Classroom submission is ${mine?.state ?? "missing"} with ${mine?.assignedGrade ?? "no grade"}, not RETURNED with ${grade.score.points}`);
  }
  const panel = await district<{ status: string; grades?: { title: string; assignedGrade?: number }[] }>(cookies.student, "GET", `/api/student/offerings/${offeringId}/classroom-grades`);
  result.readback.harbor = panel.grades?.find((g) => g.title === COLUMN_TITLE)?.assignedGrade ?? null;
  if (result.readback.harbor !== grade.score.points) result.problems.push(`Harbor's From Google Classroom panel shows ${result.readback.harbor ?? "nothing"} for Nia, not ${grade.score.points}`);
  return result;
}

const readCookie = async (file: string) => (await readFile(file, "utf8")).trim().replace(/^CF_Authorization=/, "");

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) flags.set(args[i]!, args[i + 1] ?? "");
  const [out, adminFile, teacherFile, studentFile] = ["--out", "--admin-cookie", "--teacher-cookie", "--student-cookie"].map((f) => flags.get(f));
  if ((mode !== "run" && mode !== "verify") || !out || !adminFile || !teacherFile || !studentFile) {
    throw new Error("usage: harbor-grade-return.ts run|verify --admin-cookie <file> --teacher-cookie <file> --student-cookie <file> --out <new report>");
  }
  const report = await open(out, "wx", 0o600);
  const encoded = execFileSync("security", ["find-generic-password", "-s", "educateos-classroom-demo-sa-key", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const key: unknown = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  const asTokens = (tokens: { token(subject: string): Promise<string> }): ClassroomAs => async <T>(email: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`https://classroom.googleapis.com/v1/${path}`, {
      method, redirect: "manual",
      headers: { authorization: `Bearer ${await tokens.token(email)}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const reason = await response.json().then((b) => (b as { error?: { status?: string } }).error?.status ?? "", () => "");
      throw new Error(`Classroom ${method} ${path.split("?")[0]}: HTTP ${response.status}${reason ? ` (${reason})` : ""}`);
    }
    return await response.json() as T;
  };
  const result = await harborGradeReturn({
    mode,
    district: districtRequest(HARBOR),
    cookies: { admin: await readCookie(adminFile), teacher: await readCookie(teacherFile), student: await readCookie(studentFile) },
    classroom: {
      owner: asTokens(serviceAccountTokens({ key, scopes: [...CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES.courseworkStudents], fetch })),
      student: asTokens(serviceAccountTokens({ key, scopes: [GOOGLE_SCOPES.courses, COURSEWORK_ME], fetch })),
    },
    log: (line) => console.log(line),
  });
  await report.writeFile(JSON.stringify({ mode, at: new Date().toISOString(), ...result }, null, 2) + "\n");
  await report.close();
  console.log(`Harbor grade return ${mode}: Classroom ${result.readback.classroom?.state ?? "-"} ${result.readback.classroom?.assignedGrade ?? "-"}; Harbor panel ${result.readback.harbor ?? "-"}; administrator publish ${result.adminPublish ?? "-"}; ${result.problems.length} problems`);
  for (const problem of result.problems) console.log(`problem: ${problem}`);
  if (result.problems.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
