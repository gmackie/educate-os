// A live smoke test of Google Classroom grade sync (SCHO-77) on one course of the demo tenant
// (gedu.demo.educateos.io): one teacher, one student. It runs the shipped code, unchanged, against
// Google:
//
//   0. checks which Classroom scopes the classroom-sync service account's domain-wide delegation
//      grants, and stops if `classroom.coursework.students` is missing;
//   1. reads the course and its roster as the tenant admin;
//   2. plans Cedar Valley's links over the live course (alias `d:<offering ID>`, then members by
//      name) and applies the ones for this course;
//   3. creates coursework as the app, acting as the course owner;
//   4. publishes a teacher-approved grade through the passback gate;
//   5. reads the grade back as the teacher.
//
//   node packages/educateos-integrations/scripts/classroom-smoke.ts [--course <numeric ID>] [--offering <offering ID>]
//
// The key is read from the macOS Keychain and never printed or written to disk. Nothing but IDs,
// states, grades and outcomes is printed. Each run leaves one new coursework item in the course,
// titled with the run's time, as evidence.
import { execFileSync } from "node:child_process";
import { DistrictDirectorySnapshot } from "@educateos/contracts";
import type { OfferingId } from "@educateos/contracts";
import { demoDistrict } from "@educateos/fixtures";
import { googleclassroom } from "../src/index.ts";
import {
  CLASSROOM_ISSUER, ClassroomAdapter, ClassroomGradeSink, GradePassback, InMemoryGradeApprovalStore,
  InMemoryGradeRouteStore, InMemoryPassbackLedger,
} from "@educateos/lti";

const DOMAIN = "gedu.demo.educateos.io";
const ADMIN = `gmackie@${DOMAIN}`;
const SYNC_KEY = "educateos-classroom-demo-sa-key";
const S = googleclassroom.GOOGLE_SCOPES;
// The demo delegation lists the read-write course and roster scopes, not their `.readonly` forms.
const SCOPES = [...googleclassroom.CLASSROOM_ROSTER_SCOPES_READ_WRITE, S.courseworkStudents];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

function keyFromKeychain(service: string): unknown {
  const encoded = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
}

function step(label: string, outcome: string): void {
  console.log(`${label.padEnd(34)} ${outcome}`);
}

async function main(): Promise<number> {
  const courseId = arg("--course", "895811762849");
  const offeringId = arg("--offering", "off_cv-earthsci-p1") as OfferingId;
  const key = keyFromKeychain(SYNC_KEY);

  // 0. Which scopes the delegation grants: a token for one scope at a time.
  const missing: string[] = [];
  for (const scope of SCOPES) {
    const probe = googleclassroom.serviceAccountTokens({ key, scopes: [scope], fetch });
    const granted = await probe.token(ADMIN).then(() => true, () => false);
    if (!granted) missing.push(scope);
    step(`delegated ${scope.slice(scope.lastIndexOf("/") + 1)}`, granted ? "yes" : "NO");
  }
  if (missing.length > 0) {
    console.log(`\nStopped: classroom-sync's delegation lacks ${missing.join(", ")}.`);
    console.log(`Add to its domain-wide delegation: ${SCOPES.join(",")}`);
    return 2;
  }

  const tokens = googleclassroom.serviceAccountTokens({ key, scopes: SCOPES, fetch });
  const client = new googleclassroom.GoogleClassroomClient({ tokens, admin: ADMIN, fetch });

  // 1. The course and its roster.
  const course = await client.getCourse(courseId);
  const aliases = await client.listAliases(courseId);
  const teachers = await client.listTeachers(courseId);
  const students = await client.listStudents(courseId);
  step("course", `${course.id} ${course.courseState} "${course.name}" (${course.section ?? "no section"})`);
  step("course link", course.alternateLink ?? "none");
  step("aliases", aliases.join(", ") || "none");
  step("roster", `${teachers.records.length} teacher(s), ${students.records.length} student(s), ${teachers.invalid.length + students.invalid.length} unreadable`);
  const student = students.records[0];
  if (student === undefined) throw new Error("the course has no student");

  // 2. Match a real synthetic learner already in the fixture's active offering roster.
  const cv = demoDistrict("cedarvalley").directory;
  const directory = DistrictDirectorySnapshot.parse({
    ...cv,
    district: { ...cv.district, trustedIssuers: [...new Set([...cv.district.trustedIssuers, CLASSROOM_ISSUER])] },
  });
  const plan = await googleclassroom.planClassroomLinks({ directory, client });
  const courseLinks = plan.courses.filter((c) => c.courseId === courseId);
  const identityLinks = plan.identities.filter((i) => i.courseId === courseId);
  step("link plan: course", courseLinks.map((c) => `${c.offeringId} by ${c.basis}`).join(", ") || "NOT LINKED");
  step("link plan: identities", identityLinks.map((i) => `${i.principalId} by ${i.basis}`).join(", ") || "none");
  for (const u of plan.unresolved.filter((x) => x.courseId === courseId)) step("link plan: unresolved", `${u.reason}`);
  // Name matches are applied only when confirmed one by one; the operator running this smoke test
  // confirms these two, printed above.
  const linked = googleclassroom.applyClassroomLinks({ directory, courses: courseLinks, identities: identityLinks, authority: "lms:cv-classroom", acceptNameMatches: true });
  const teacher = linked.directory.principals.find((p) => p.id === "prn_cv-teacher-whitaker")!;
  const learner = linked.directory.principals.find((p) =>
    p.kind === "student" && p.externalIdentities.some((i) => i.issuer === CLASSROOM_ISSUER && i.subject === student.userId) &&
    linked.directory.enrollments.some((e) => e.principalId === p.id && e.offeringId === offeringId && e.status === "active"));
  if (learner === undefined) throw new Error("the live learner is not an active synthetic fixture student in this offering");
  if (!teacher.externalIdentities.some((i) => i.issuer === CLASSROOM_ISSUER)) throw new Error("the teacher was not linked to a Google account");

  // 3. Coursework created by the app, as the course owner.
  const routes = new InMemoryGradeRouteStore(linked.routes);
  const provider = new googleclassroom.GoogleClassroomProvider(client);
  const adapter = new ClassroomAdapter({ districtId: linked.directory.district.id, provider, routes });
  const title = `EducateOS live smoke (SCHO-77) ${new Date().toISOString()}`;
  const column = await adapter.createCourseWork(offeringId, { title, maxPoints: 10, description: "Created by EducateOS's Classroom provider as a live smoke test. Synthetic." });
  step("create coursework", `${column.id} "${column.title}" out of ${column.maxPoints}`);
  const listed = await adapter.courseWork(offeringId);
  step("listed as EducateOS's own", listed.some((w) => w.id === column.id) ? "yes" : "NO");

  // 4. A teacher-approved grade through the passback gate.
  const approval = {
    offeringId, studentId: learner.id, column: column.id, gradeVersion: 1, scoreGiven: 8.5, scoreMaximum: 10,
    approverId: teacher.id, approvedAt: new Date(Date.now() - 1000).toISOString(),
  };
  const passback = new GradePassback({
    districtId: linked.directory.district.id, directory: async () => linked.directory, routes,
    approvals: new InMemoryGradeApprovalStore([approval]), ledger: new InMemoryPassbackLedger(), sinks: [new ClassroomGradeSink(provider)],
  });
  const { approverId: _approver, approvedAt: _at, ...request } = approval;
  const first = await passback.publish(request);
  const repeated = await passback.publish(request);
  step("passback (approved 8.5/10)", JSON.stringify(first));
  step("passback again", JSON.stringify(repeated));
  const unapproved = await passback.publish({ ...request, gradeVersion: 2, scoreGiven: 10 }).then(() => "POSTED", (e: { code?: string }) => `refused: ${e.code}`);
  step("passback without approval", unapproved);

  // 5. The grade, read back as the teacher.
  const owner = (await client.getTeacher(courseId, course.ownerId)).profile?.emailAddress ?? "";
  const submissions = await client.listSubmissions(courseId, column.id, student.userId, owner);
  for (const s of submissions.records) step("read back", `submission ${s.id} ${s.state} assignedGrade=${s.assignedGrade} draftGrade=${s.draftGrade}`);
  const ok = submissions.records.length === 1 && submissions.records[0]!.assignedGrade === 8.5 &&
    submissions.records[0]!.draftGrade === 8.5 && first.status === "posted" && repeated.status === "already-posted" && unapproved === "refused: policy-violation";
  // This provider-level smoke deliberately does not claim deployed user-flow or return coverage.
  console.log(ok ? "\nSMOKE PASSED" : "\nSMOKE FAILED");
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => {
  // A RosterSyncError or EducateOsError carries a code and a message with no secrets in it.
  const e = error as { name?: string; code?: string; message?: string };
  console.error(`failed: ${e.name ?? "Error"} ${e.code ?? ""} ${e.message ?? String(error)}`);
  process.exit(1);
});
