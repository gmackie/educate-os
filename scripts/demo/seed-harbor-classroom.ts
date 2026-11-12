#!/usr/bin/env node
// Adds repeatable coursework to Harbor's four existing real Classroom courses. No roster changes,
// exemplar edits, grades, or fabricated teacher approvals. Uses the existing delegated credential.
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEMO_DISTRICTS, googleDemoPlan } from "../../packages/educateos-fixtures/src/index.ts";
import { serviceAccountTokens, CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES } from "../../packages/educateos-integrations/src/google-classroom/service-account.ts";

const marker = "EducateOS Harbor synthetic demo (SCHO-354).";
/** Harbor-specific lessons; all prompts are invented and contain no learner answer keys. */
export const HARBOR_LESSONS: Readonly<Record<string, readonly { key: string; title: string; prompt: string; points: number }[]>> = {
  "off_hb-marine-b1": [
    { key: "tide-pools", title: "Tide Pool Biodiversity Survey", points: 10, prompt: "A synthetic survey counted 12 mussels, 8 barnacles and 4 sea stars in a sheltered pool, and 6 mussels, 15 barnacles and 1 sea star in an exposed pool. Make a data table, compare the communities, and explain one environmental factor that could account for the difference. Separate evidence from your hypothesis." },
    { key: "coastal-water", title: "Coastal Water Quality Investigation", points: 10, prompt: "Design a fair investigation of how runoff affects a coastal ecosystem. Identify a testable question, variables, a sampling plan, and two safety precautions. Explain what evidence would support your claim and one limitation of the design." },
  ],
  "off_hb-comp-b2": [
    { key: "community-argument", title: "A Proposal for Our Community", points: 10, prompt: "Write an argument proposing one improvement to a fictional coastal town. State your claim, use two concrete pieces of evidence, acknowledge a counterargument, and explain why your proposal is workable. Label invented evidence as synthetic." },
    { key: "revision-reflection", title: "Revision and Writer Reflection", points: 10, prompt: "Revise one paragraph from your community proposal for clarity and evidence. Submit the original and revised paragraphs, then explain two deliberate changes and one question you would ask a peer reviewer." },
  ],
  "off_hb-gov-b3": [
    { key: "public-hearing", title: "Local Government Public Hearing", points: 10, prompt: "A fictional town council is considering a protected coastal area. Explain the roles of the council, residents and local businesses. Write a two-minute public comment with a claim, evidence, and a response to a competing interest." },
    { key: "rights-responsibilities", title: "Rights, Responsibilities and Civic Action", points: 10, prompt: "Compare two lawful ways residents can influence the town council's decision. Explain the rights involved, the responsibilities of participants, and how to check whether a source about the proposal is reliable." },
  ],
  "off_hb-math7-b1": [
    { key: "coastal-ratios", title: "Ratios at the Coastal Market", points: 10, prompt: "A fictional market sells 3 kg of apples for $7.50 and 5 kg for $12.50. Find the unit price, decide whether the relationship is proportional, and represent it with a table and equation. Explain how you know." },
    { key: "field-trip-budget", title: "Plan a Field Trip Budget", points: 10, prompt: "A synthetic field trip costs $120 for a bus plus $8 per learner. Write an expression for the cost for n learners, calculate the cost for 24 learners, and decide whether the total cost is proportional to the number of learners. Justify your answer." },
  ],
};

/** The four planned courses, resolved by their existing domain-scoped aliases. */
export function harborCourseworkPlan() {
  return googleDemoPlan("gedu.demo.educateos.io", DEMO_DISTRICTS).courses.filter(c => c.district === "harbor").map(c => ({
    ...c, lessons: HARBOR_LESSONS[c.fixtureId]!.map(lesson => ({ ...lesson,
      title: `[educateos-demo:${lesson.key}] ${lesson.title}`, description: `${marker}\n\n${lesson.prompt}`,
    })),
  }));
}

interface Work { id: string; title: string; description?: string; state: string; maxPoints?: number; associatedWithDeveloper?: boolean }
interface Tokens { token(subject: string): Promise<string> }

/** Additive teacher-scoped coursework provisioning. Verification makes only GET requests. */
export async function seedHarborClassroom(tokens: Tokens, mode: "run" | "verify", transport: typeof fetch = fetch) {
  async function request<T>(subject: string, method: string, path: string, body?: unknown): Promise<T> {
    const token = await tokens.token(subject);
    const response = await transport(`https://classroom.googleapis.com/v1/${path}`, {
      method, redirect: "manual", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => { throw new Error(`Classroom ${method} ${path.split("?")[0]}: transport failed; verify before retrying a write`); });
    if (!response.ok) throw new Error(`Classroom ${method} ${path.split("?")[0]}: HTTP ${response.status}; verify before retrying a write`);
    return response.json() as Promise<T>;
  }
  const problems: string[] = [];
  const courses: { offeringId: string; courseId: string; assignments: { key: string; workId: string }[] }[] = [];
  for (const planned of harborCourseworkPlan()) {
    const course = await request<{ id: string; courseState: string }>(planned.ownerEmail, "GET", `courses/${encodeURIComponent(planned.alias)}`);
    if (course.courseState !== "ACTIVE") problems.push(`Inactive course ${planned.fixtureId}`);
    const works: Work[] = [];
    const seen = new Set<string>();
    let next = "";
    do {
      const page: { courseWork?: Work[]; nextPageToken?: string } = await request(planned.ownerEmail, "GET", `courses/${course.id}/courseWork?pageSize=100${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`);
      works.push(...page.courseWork ?? []);
      next = page.nextPageToken ?? "";
      if (next && seen.has(next)) throw new Error("Classroom repeated a page token");
      seen.add(next);
    } while (next);
    const mapped = { offeringId: planned.fixtureId, courseId: course.id, assignments: [] as { key: string; workId: string }[] };
    for (const lesson of planned.lessons) {
      const matches = works.filter(w => w.title === lesson.title);
      if (matches.length > 1) throw new Error(`Duplicate Harbor assignment ${lesson.key}`);
      let work = matches[0];
      if (work && (!work.description?.startsWith(marker) || !work.associatedWithDeveloper)) throw new Error(`Unowned Harbor assignment collision ${lesson.key}`);
      if (!work && mode === "run") work = await request<Work>(planned.ownerEmail, "POST", `courses/${course.id}/courseWork`, {
        title: lesson.title, description: lesson.description, workType: "ASSIGNMENT", state: "PUBLISHED", maxPoints: lesson.points,
      });
      if (!work) problems.push(`Missing coursework ${planned.fixtureId}/${lesson.key}`);
      else {
        mapped.assignments.push({ key: lesson.key, workId: work.id });
        if (work.state !== "PUBLISHED" || work.maxPoints !== lesson.points) problems.push(`Coursework configuration drift ${planned.fixtureId}/${lesson.key}`);
      }
    }
    courses.push(mapped);
  }
  return { courses, problems, pending: ["district identity verification", "student work/submission", "teacher-approved grade return"] };
}

async function main() {
  const [mode, flag, output] = process.argv.slice(2);
  if (!["dry-run", "run", "verify"].includes(mode ?? "") || flag !== "--out" || !output) throw new Error("usage: seed-harbor-classroom.ts <dry-run|run|verify> --out <new-report.json>");
  const report = await open(output, "wx", 0o600);
  try {
    let result;
    if (mode === "dry-run") result = harborCourseworkPlan();
    else {
      const encoded = execFileSync("security", ["find-generic-password", "-s", "educateos-classroom-demo-sa-key", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const key: unknown = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
      const tokens = serviceAccountTokens({ key, scopes: [...CLASSROOM_ROSTER_SCOPES_READ_WRITE, GOOGLE_SCOPES.courseworkStudents], fetch });
      result = await seedHarborClassroom(tokens, mode as "run" | "verify");
    }
    await report.writeFile(JSON.stringify(result, null, 2) + "\n");
    console.log(`Harbor Classroom ${mode}: saved ${output}`);
    if ("problems" in result && result.problems.length) process.exitCode = 1;
  } finally { await report.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Harbor seed failed"); process.exitCode = 1;
});
