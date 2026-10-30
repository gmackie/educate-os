// Read-only tenant preflight for the SCHO-255 customer demo. This checks Google directly; it is
// intentionally not evidence that an authenticated EducateOS user workflow has passed.
// Run: node packages/educateos-integrations/scripts/classroom-readiness.ts
// The existing key stays in memory. Output contains only synthetic IDs, HTTP statuses and flags.
import { execFileSync } from "node:child_process";
import { googleclassroom } from "../src/index.ts";

const DOMAIN = "gedu.demo.educateos.io";
const COURSE_ID = "895811762849";
const COURSE_WORK_ID = "896231288996";
const encoded = execFileSync("security", ["find-generic-password", "-s", "educateos-classroom-demo-sa-key", "-w"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
});
const key: unknown = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
const teacher = `cv-teacher-whitaker@${DOMAIN}`;
const tokens = googleclassroom.serviceAccountTokens({
  key, scopes: [...googleclassroom.CLASSROOM_ROSTER_SCOPES_READ_WRITE, googleclassroom.GOOGLE_SCOPES.courseworkStudents], fetch,
});
const token = await tokens.token(teacher);
const probes = [
  ["rubric-eligibility", "userProfiles/me:checkUserCapability?capability=CREATE_RUBRIC&previewVersion=V1_20240930_PREVIEW"],
  ["grading-period-eligibility", "userProfiles/me:checkUserCapability?capability=UPDATE_GRADING_PERIOD_SETTINGS&previewVersion=V1_20240930_PREVIEW"],
  ["add-on-eligibility", "userProfiles/me:checkUserCapability?capability=CREATE_ADD_ON_ATTACHMENT&previewVersion=V1_20240930_PREVIEW"],
  ["grading-period-settings", `courses/${COURSE_ID}/gradingPeriodSettings`],
  ["rubric-list", `courses/${COURSE_ID}/courseWork/${COURSE_WORK_ID}/rubrics`],
] as const;
const checks: { check: string; status: "passed" | "blocked"; httpStatus?: number; count?: number }[] = [];
for (const [check, path] of probes) {
  const response = await fetch(`https://classroom.googleapis.com/v1/${path}`, {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json();
  const allowed = typeof body === "object" && body !== null && "allowed" in body && body.allowed === true;
  const rubrics = typeof body === "object" && body !== null && "rubrics" in body && Array.isArray(body.rubrics) ? body.rubrics : undefined;
  checks.push({ check, status: response.ok && (!check.endsWith("eligibility") || allowed) ? "passed" : "blocked",
    httpStatus: response.status, ...(rubrics === undefined ? {} : { count: rubrics.length }) });
}
for (const scope of ["classroom.coursework.me", "classroom.addons.teacher", "classroom.addons.student"]) {
  const probe = googleclassroom.serviceAccountTokens({ key, scopes: [`https://www.googleapis.com/auth/${scope}`], fetch });
  checks.push({ check: `delegation:${scope}`, status: await probe.token(teacher).then(() => "passed" as const, () => "blocked" as const) });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scope: "Google tenant preflight only", teacher,
  courseId: COURSE_ID, courseWorkId: COURSE_WORK_ID, checks }, null, 2));
process.exitCode = checks.some((check) => check.status === "blocked") ? 2 : 0;
