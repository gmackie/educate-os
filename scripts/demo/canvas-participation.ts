#!/usr/bin/env node
// Learner participation and teacher review in the Northfield Canvas demo (SCHO-354, SCHO-377), from
// the showcase fixtures. Every learner acts as themself and every grade comes from the course's
// own teacher, each with a short-lived credential of their own (canvas-actors.ts):
//
// - learners submit their fixture work as text entries; teachers grade work the fixture marks
//   graded or released, with its rubric total and comment, and learners read the grade back;
// - learners post their fixture discussion entries and replies;
// - learners take the Classic quizzes with their fixture answers; teachers score essay items;
// - a learner's attempts to read a classmate's submission are refused.
//
//   node scripts/demo/canvas-participation.ts run    --out <new report>
//   node scripts/demo/canvas-participation.ts verify --out <new report>   reads only
//
// Run after seed-canvas-demo.ts. Reruns add nothing: existing submissions, grades, entries and quiz
// attempts are kept as they are (a teacher's later edits are reported, never overwritten). These
// are Canvas-native workflows: not EducateOS grade approval or AGS passback. All tokens are expired
// before exit. Reports hold IDs, states and scores only.
import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canvasDemoPlan, CanvasClient } from "./seed-canvas-demo.ts";
import { consoleActors, railsRunner, type CanvasActors, type CanvasCredential } from "./canvas-actors.ts";
import type { ShowcaseQuizAnswer, ShowcaseQuizItem } from "../../packages/educateos-fixtures/src/index.ts";

const WORK_MARKER = "Synthetic demo learner work.";
const POST_MARKER = "Synthetic demo discussion contribution.";
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const html = (marker: string, text: string) => `<p>${marker}</p>` + text.split("\n").map((l) => `<p>${escape(l)}</p>`).join("");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&(#x27|#39|[a-z]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();

interface Submission { id: number; user_id: number; workflow_state: string; score?: number | null; grade?: string | null; grader_id?: number | null; body?: string | null }
interface Entry { id: number; user_id: number; message?: string | null }
interface QuizSubmission { id: number; user_id: number; attempt: number; validation_token?: string; workflow_state: string; score?: number | null; quiz_points_possible?: number }
interface QuizQuestion { id: number; question_type: string; points_possible: number; answers?: { id: number; text: string; weight: number }[] }

/** The Canvas REST calls this script makes (CanvasClient, or a fake in tests). */
export type CanvasApi = Pick<CanvasClient, "request" | "list">;

/** A row of the report. */
export interface ParticipationRow { kind: "submission" | "review" | "entry" | "quiz"; courseId: number; principalId: string; id: number | null; state: string; score?: number | null; outcome: string }

/** Canvas's answer for one fixture quiz answer, given the question as the teacher sees it. */
export function canvasQuizAnswer(item: ShowcaseQuizItem, answer: ShowcaseQuizAnswer, question: QuizQuestion): unknown {
  const byText = (text: string) => {
    const match = question.answers?.find((a) => plain(a.text) === plain(text));
    if (match === undefined) throw new Error(`No Canvas choice for ${JSON.stringify(text)}`);
    return match.id;
  };
  if (item.type !== answer.type) throw new Error(`A ${answer.type} answer does not fit a ${item.type} item`);
  switch (answer.type) {
    case "multiple-choice": {
      if (item.type !== "multiple-choice") break;
      return byText(item.choices.find((c) => c.id === answer.choiceId)!.text);
    }
    case "multiple-select": {
      if (item.type !== "multiple-select") break;
      const texts = answer.choiceIds.map((id) => item.choices.find((c) => c.id === id)!.text);
      // All-or-nothing items are teacher-scored essays in Canvas (canvas-quiz.ts).
      return question.question_type === "essay_question" ? `<p>${escape(answer.choiceIds.join(", "))}</p>` : texts.map(byText);
    }
    case "true-false": return byText(answer.value ? "True" : "False");
    case "numeric": return answer.value;
    case "short-answer": return answer.text;
    case "essay": return `<p>${escape(answer.text)}</p>`;
  }
  throw new Error(`A ${answer.type} answer does not fit a ${item.type} item`);
}

/** Runs (or, in `verify`, only reads) Northfield's Canvas participation. */
export async function canvasParticipation(admin: CanvasApi, actors: CanvasActors, mode: "run" | "verify", client: (token: string) => CanvasApi = (token) => new CanvasClient(token)) {
  const plan = canvasDemoPlan();
  const rows: ParticipationRow[] = [];
  const problems: string[] = [];
  const isolation: { courseId: number; principalId: string; status: number | "allowed" }[] = [];
  const courses = await admin.list<{ id: number; sis_course_id?: string }>(`accounts/${plan.accountId}/courses?per_page=100`);
  const people = [...new Set(plan.courses.flatMap((c) => [c.teacherId, ...c.enrollments.map((e) => e.principalId)]))];
  const credentials = await actors.credentials(people);
  const as = (principalId: string): { credential: CanvasCredential; api: CanvasApi } | undefined => {
    const credential = credentials.get(principalId);
    return credential === undefined ? undefined : { credential, api: client(credential.token) };
  };
  const status = (p: Promise<unknown>) => p.then(() => "allowed" as const, (e: unknown) => Number(/HTTP (\d+)/.exec(String((e as Error).message))?.[1] ?? 0));
  for (const course of plan.courses) {
    const courseId = courses.find((c) => c.sis_course_id === course.sisId)?.id;
    const teacher = as(course.teacherId);
    if (courseId === undefined || teacher === undefined) { problems.push(`${course.offeringId}: not seeded; run seed-canvas-demo.ts`); continue; }
    const assignments = await admin.list<{ id: number; name: string }>(`courses/${courseId}/assignments?per_page=100`);
    const submissionsSeen: { principalId: string; assignmentId: number; userId: number }[] = [];

    for (const activity of course.activities) {
      const assignment = assignments.find((a) => a.name === `[${activity.key}] ${activity.title}`);
      if (assignment === undefined) { problems.push(`${course.offeringId}: assignment ${activity.key} missing`); continue; }
      for (const [principalId, work] of Object.entries(activity.work)) {
        if (work.stage === "not-started" || work.stage === "draft") continue;
        const learner = as(principalId);
        if (learner === undefined) { problems.push(`${principalId}: no Canvas login`); continue; }
        const path = `courses/${courseId}/assignments/${assignment.id}/submissions`;
        let mine = (await learner.api.request<Submission>("GET", `${path}/self`)).value;
        let outcome = "unchanged";
        if (mode === "run" && !["submitted", "graded", "pending_review"].includes(mine.workflow_state)) {
          mine = (await learner.api.request<Submission>("POST", path, { submission: { submission_type: "online_text_entry", body: html(WORK_MARKER, work.text) } })).value;
          outcome = "submitted";
        }
        if (mine.user_id !== learner.credential.userId) problems.push(`${principalId}: submission ${mine.id} is not their own`);
        if (mine.workflow_state === "unsubmitted") problems.push(`${principalId}: ${activity.key} is not submitted`);
        else if (!plain(mine.body ?? "").includes(plain(work.text))) problems.push(`${principalId}: ${activity.key} differs from the fixture work`);
        rows.push({ kind: "submission", courseId, principalId, id: mine.id, state: mine.workflow_state, outcome });
        submissionsSeen.push({ principalId, assignmentId: assignment.id, userId: learner.credential.userId });
        if (work.stage !== "graded" && work.stage !== "released") continue;

        const score = Object.values(work.scores).reduce((a, b) => a + b, 0);
        const graded = `${path}/${learner.credential.userId}`;
        let current = (await teacher.api.request<Submission>("GET", graded)).value;
        let review = "unchanged";
        if (mode === "run" && (current.score === null || current.score === undefined)) {
          current = (await teacher.api.request<Submission>("PUT", graded, { submission: { posted_grade: score }, comment: { text_comment: `Synthetic teacher review: ${work.comment}` } })).value;
          review = "graded";
        }
        if (current.score === null || current.score === undefined) problems.push(`${principalId}: ${activity.key} is not graded`);
        else if (current.score !== score) review = `teacher grade ${current.score} kept`;
        else if (current.grader_id !== teacher.credential.userId) problems.push(`${principalId}: ${activity.key} was not graded by the course teacher`);
        const seen = (await learner.api.request<Submission>("GET", `${path}/self`)).value;
        if (seen.score !== current.score) problems.push(`${principalId}: cannot read their ${activity.key} grade`);
        rows.push({ kind: "review", courseId, principalId, id: current.id, state: current.workflow_state, score: seen.score ?? null, outcome: review });
      }
    }

    // A learner cannot read a classmate's submission.
    const [a, b] = [submissionsSeen[0], submissionsSeen.find((s) => s.principalId !== submissionsSeen[0]?.principalId && s.assignmentId === submissionsSeen[0]?.assignmentId)];
    if (a !== undefined && b !== undefined) {
      const result = await status(as(a.principalId)!.api.request("GET", `courses/${courseId}/assignments/${b.assignmentId}/submissions/${b.userId}`));
      isolation.push({ courseId, principalId: a.principalId, status: result });
      if (result === "allowed") problems.push(`${a.principalId}: read a classmate's submission`);
    }

    const topics = course.discussions.length === 0 ? [] : await admin.list<{ id: number; title: string }>(`courses/${courseId}/discussion_topics?per_page=100`);
    for (const discussion of course.discussions) {
      const topic = topics.find((t) => t.title === `[educateos-demo:${discussion.key}] ${discussion.title}`);
      if (topic === undefined) { problems.push(`${course.offeringId}: discussion ${discussion.key} missing`); continue; }
      const entryIds = new Map<number, number>();
      for (const [index, post] of discussion.posts.entries()) {
        const author = as(post.author);
        if (author === undefined) continue;
        let root: number | undefined = post.replyTo;
        while (root !== undefined && discussion.posts[root]!.replyTo !== undefined) root = discussion.posts[root]!.replyTo;
        if (root !== undefined && !entryIds.has(root)) { problems.push(`${post.author}: reply to a missing entry in ${discussion.key}`); continue; }
        const path = `courses/${courseId}/discussion_topics/${topic.id}/entries` + (root === undefined ? "" : `/${entryIds.get(root)}/replies`);
        const existing = (await author.api.list<Entry>(`${path}?per_page=100`)).find((e) => e.user_id === author.credential.userId && plain(e.message ?? "").includes(plain(post.body)));
        let entry = existing;
        if (entry === undefined && mode === "run") entry = (await author.api.request<Entry>("POST", path, { message: html(POST_MARKER, post.body) })).value;
        if (entry === undefined) { problems.push(`${post.author}: entry ${index} in ${discussion.key} missing`); continue; }
        entryIds.set(index, entry.id);
        rows.push({ kind: "entry", courseId, principalId: post.author, id: entry.id, state: "posted", outcome: existing === undefined ? "posted" : "unchanged" });
      }
    }

    const quizzes = course.quizzes.length === 0 ? [] : await admin.list<{ id: number; title: string }>(`courses/${courseId}/quizzes?per_page=100`);
    for (const quiz of course.quizzes) {
      const found = quizzes.find((q) => q.title === `[educateos-demo:${quiz.key}] ${quiz.title}`);
      if (found === undefined) { problems.push(`${course.offeringId}: quiz ${quiz.key} missing`); continue; }
      const questions = (await admin.list<QuizQuestion>(`courses/${courseId}/quizzes/${found.id}/questions?per_page=100`));
      for (const [principalId, answers] of Object.entries(quiz.attempts)) {
        const learner = as(principalId);
        if (learner === undefined) { problems.push(`${principalId}: no Canvas login`); continue; }
        const base = `courses/${courseId}/quizzes/${found.id}`;
        let mine = (await learner.api.request<{ quiz_submissions: QuizSubmission[] }>("GET", `${base}/submission`)).value.quiz_submissions[0];
        let outcome = "unchanged";
        if (mode === "run" && (mine === undefined || mine.workflow_state === "untaken")) {
          mine ??= (await learner.api.request<{ quiz_submissions: QuizSubmission[] }>("POST", `${base}/submissions`, {})).value.quiz_submissions[0]!;
          const quizQuestions = answers.map((answer, i) => ({ id: questions[i]!.id, answer: canvasQuizAnswer(quiz.items[i]!, answer, questions[i]!) }));
          await learner.api.request("POST", `quiz_submissions/${mine.id}/questions`, { attempt: mine.attempt, validation_token: mine.validation_token, quiz_questions: quizQuestions });
          mine = (await learner.api.request<{ quiz_submissions: QuizSubmission[] }>("POST", `${base}/submissions/${mine.id}/complete`, { attempt: mine.attempt, validation_token: mine.validation_token })).value.quiz_submissions[0]!;
          outcome = "taken";
        }
        if (mine === undefined) { problems.push(`${principalId}: has not taken ${quiz.key}`); continue; }
        if (mode === "run" && mine.workflow_state === "pending_review") {
          // The teacher scores the essay items with the fixture's points.
          const scores = Object.fromEntries(answers.flatMap((answer, i) => questions[i]!.question_type !== "essay_question" ? []
            : [[String(questions[i]!.id), { score: answer.type === "essay" ? answer.points : 0 }]]));
          await teacher.api.request("PUT", `${base}/submissions/${mine.id}`, { quiz_submissions: [{ attempt: mine.attempt, questions: scores }] });
          outcome += ", teacher scored";
        }
        mine = (await learner.api.request<{ quiz_submissions: QuizSubmission[] }>("GET", `${base}/submission`)).value.quiz_submissions[0]!;
        if (mine.user_id !== learner.credential.userId) problems.push(`${principalId}: quiz ${quiz.key} attempt is not their own`);
        if (mine.workflow_state !== "complete") problems.push(`${principalId}: quiz ${quiz.key} is ${mine.workflow_state}`);
        rows.push({ kind: "quiz", courseId, principalId, id: mine.id, state: mine.workflow_state, score: mine.score ?? null, outcome });
      }
    }
  }
  return { rows, isolation, problems };
}

async function main() {
  const [mode, flag, out] = process.argv.slice(2);
  if ((mode !== "run" && mode !== "verify") || flag !== "--out" || !out) throw new Error("usage: canvas-participation.ts <run|verify> --out <new-report.json>");
  const report = await open(out, "wx", 0o600);
  const runner = railsRunner(process.env.CANVAS_RAILS_RUNNER ? JSON.parse(process.env.CANVAS_RAILS_RUNNER) as string[] : undefined);
  const actors = consoleActors(runner, "educateos-demo canvas participation");
  const admin = new CanvasClient(execFileSync("security", ["find-generic-password", "-s", "educateos-canvas-demo-admin-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  try {
    const result = await canvasParticipation(admin, actors, mode);
    await report.writeFile(JSON.stringify({ mode, at: new Date().toISOString(), ...result }, null, 2) + "\n");
    const count = (kind: string) => result.rows.filter((r) => r.kind === kind).length;
    console.log(`Canvas participation ${mode}: ${count("submission")} submissions, ${count("review")} reviews, ${count("entry")} discussion entries, ${count("quiz")} quiz attempts; ${result.isolation.length} isolation checks; ${result.problems.length} problems`);
    for (const problem of result.problems) console.log(`problem: ${problem}`);
    if (result.problems.length > 0) process.exitCode = 1;
  } finally {
    const active = await actors.expire();
    await report.close();
    if (active !== 0) { console.error(`${active} demo credentials are still active`); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Canvas participation failed"); process.exitCode = 1;
});
