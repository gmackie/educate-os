import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasDemoPlan } from "./seed-canvas-demo.ts";
import { canvasQuizQuestion } from "./canvas-quiz.ts";
import { canvasParticipation, canvasQuizAnswer, type CanvasApi } from "./canvas-participation.ts";
import { consoleActors, type CanvasActors } from "./canvas-actors.ts";

/** A fake Canvas holding the seeded demo, enforcing that people act only on what is theirs. */
function fakeCanvas() {
  const plan = canvasDemoPlan();
  const people = new Map<string, number>();
  for (const id of new Set(plan.courses.flatMap((c) => [c.teacherId, ...c.enrollments.map((e) => e.principalId)]))) people.set(id, people.size + 1);
  const teacherOf = new Map(plan.courses.map((c, i) => [i + 1, people.get(c.teacherId)!]));
  const subs = new Map<string, Record<string, unknown>>();
  const entries = new Map<string, Record<string, unknown>[]>();
  const quizSubs = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  let next = 1000;
  const questions = new Map<string, { id: number; question_type: string; points_possible: number; answers?: { id: number; text: string; weight: number }[] }[]>(plan.courses.flatMap((c, ci) => c.quizzes.map((q, qi) => [`${ci + 1}/${qi + 1}`, q.items.map((item, i) => {
    const canvas = canvasQuizQuestion(item, i + 1) as { question_type: string; answers?: { answer_text?: string; answer_weight: number }[] };
    return { id: (ci + 1) * 1000 + (qi + 1) * 100 + i, question_type: canvas.question_type, points_possible: item.points,
      answers: canvas.answers?.map((a, j) => ({ id: j + 1, text: a.answer_text ?? "", weight: a.answer_weight })) };
  })] as const)));
  const refuse = (method: string, path: string): never => { throw new Error(`Canvas ${method} /api/v1/${path}: HTTP 401. Check the provider before retrying a write.`); };
  const api = (user: number | "admin"): CanvasApi => ({
    async request<T>(method: string, raw: string, body?: unknown) {
      const path = raw.split("?")[0]!;
      const b = body as Record<string, any>;
      if (method !== "GET") writes.push(`${user} ${method} ${path}`);
      let m: RegExpExecArray | null;
      if ((m = /^courses\/(\d+)\/assignments\/(\d+)\/submissions(?:\/(self|\d+))?$/.exec(path))) {
        const [, c, a, who] = m;
        const target = who === undefined || who === "self" ? user as number : Number(who);
        if (user !== "admin" && target !== user && teacherOf.get(Number(c)) !== user) refuse(method, path);
        const key = `${c}/${a}/${target}`;
        const sub = subs.get(key) ?? { id: next++, user_id: target, workflow_state: "unsubmitted", score: null };
        subs.set(key, sub);
        if (method === "POST") Object.assign(sub, { workflow_state: "submitted", body: b.submission.body });
        if (method === "PUT") Object.assign(sub, { workflow_state: "graded", score: b.submission.posted_grade, grader_id: user });
        return { value: { ...sub } as T };
      }
      if ((m = /^courses\/(\d+)\/quizzes\/(\d+)\/submission$/.exec(path))) {
        const s = quizSubs.get(`${m[1]}/${m[2]}/${user}`);
        return { value: { quiz_submissions: s === undefined ? [] : [{ ...s }] } as T };
      }
      if ((m = /^courses\/(\d+)\/quizzes\/(\d+)\/submissions$/.exec(path))) {
        const s = { id: next++, user_id: user, attempt: 1, validation_token: "v", workflow_state: "untaken", course: m[1], quiz: m[2] };
        quizSubs.set(`${m[1]}/${m[2]}/${user}`, s);
        return { value: { quiz_submissions: [s] } as T };
      }
      if ((m = /^quiz_submissions\/(\d+)\/questions$/.exec(path))) {
        const s = [...quizSubs.values()].find((q) => q.id === Number(m![1]))!;
        if (s.user_id !== user) refuse(method, path);
        s.answers = b.quiz_questions;
        return { value: {} as T };
      }
      if ((m = /^courses\/(\d+)\/quizzes\/(\d+)\/submissions\/(\d+)(\/complete)?$/.exec(path))) {
        const s = [...quizSubs.values()].find((q) => q.id === Number(m![3]))!;
        const essays = questions.get(`${m[1]}/${m[2]}`)!.some((q) => q.question_type === "essay_question");
        if (m[4] !== undefined) { if (s.user_id !== user) refuse(method, path); s.workflow_state = essays ? "pending_review" : "complete"; s.score = 1; }
        else if (method === "PUT") { if (teacherOf.get(Number(m[1])) !== user) refuse(method, path); s.workflow_state = "complete"; }
        return { value: { quiz_submissions: [{ ...s }] } as T };
      }
      if ((m = /^courses\/(\d+)\/discussion_topics\/(\d+)\/entries(?:\/(\d+)\/replies)?$/.exec(path)) && method === "POST") {
        const list = entries.get(path) ?? []; entries.set(path, list);
        const entry = { id: next++, user_id: user, message: b.message }; list.push(entry);
        return { value: entry as T };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async list<T>(raw: string) {
      const path = raw.split("?")[0]!;
      let m: RegExpExecArray | null;
      if (path === "accounts/3/courses") return plan.courses.map((c, i) => ({ id: i + 1, sis_course_id: c.sisId })) as T[];
      if ((m = /^courses\/(\d+)\/assignments$/.exec(path))) return plan.courses[Number(m[1]) - 1]!.activities.map((a, i) => ({ id: i + 1, name: `[${a.key}] ${a.title}` })) as T[];
      if ((m = /^courses\/(\d+)\/discussion_topics$/.exec(path))) return plan.courses[Number(m[1]) - 1]!.discussions.map((d, i) => ({ id: i + 1, title: `[educateos-demo:${d.key}] ${d.title}` })) as T[];
      if ((m = /^courses\/(\d+)\/quizzes$/.exec(path))) return plan.courses[Number(m[1]) - 1]!.quizzes.map((q, i) => ({ id: i + 1, title: `[educateos-demo:${q.key}] ${q.title}` })) as T[];
      if ((m = /^courses\/(\d+)\/quizzes\/(\d+)\/questions$/.exec(path))) return questions.get(`${m[1]}/${m[2]}`) as T[];
      if (/\/entries(\/\d+\/replies)?$/.test(path)) return (entries.get(path) ?? []) as T[];
      throw new Error(`Unexpected list ${path}`);
    },
  });
  let active = 0;
  const actors: CanvasActors = {
    async credentials(ids) { active += ids.length; return new Map(ids.map((id) => [id, { principalId: id, userId: people.get(id)!, token: String(people.get(id)) }])); },
    async session() { throw new Error("no browser in this test"); },
    async expire() { active = 0; return active; },
  };
  return { admin: api("admin"), client: (token: string) => api(Number(token)), actors, writes, subs, plan };
}

test("learners submit their own fixture work, teachers grade it, and a rerun or verify writes nothing", async () => {
  const fake = fakeCanvas();
  const first = await canvasParticipation(fake.admin, fake.actors, "run", fake.client);
  assert.deepEqual(first.problems, []);
  const expect = (stages: string[]) => fake.plan.courses.flatMap((c) => c.activities.flatMap((a) => Object.values(a.work).filter((w) => stages.includes(w.stage)))).length;
  assert.equal(first.rows.filter((r) => r.kind === "submission").length, expect(["submitted", "graded", "released"]));
  assert.equal(first.rows.filter((r) => r.kind === "review").length, expect(["graded", "released"]));
  assert.ok(first.rows.some((r) => r.kind === "entry") && first.rows.some((r) => r.kind === "quiz" && r.state === "complete"));
  assert.ok(first.isolation.length > 0 && first.isolation.every((i) => i.status === 401));
  assert.ok(fake.writes.every((w) => !w.startsWith("admin")), "the administrator credential never writes");
  const writes = fake.writes.length;
  assert.deepEqual((await canvasParticipation(fake.admin, fake.actors, "run", fake.client)).problems, []);
  assert.deepEqual((await canvasParticipation(fake.admin, fake.actors, "verify", fake.client)).problems, []);
  assert.equal(fake.writes.length, writes);
});

test("a teacher's later grade is kept, and verify reports missing work without writing", async () => {
  const fake = fakeCanvas();
  const missing = await canvasParticipation(fake.admin, fake.actors, "verify", fake.client);
  assert.ok(missing.problems.some((p) => /is not submitted/.test(p)));
  assert.equal(fake.writes.length, 0);
  await canvasParticipation(fake.admin, fake.actors, "run", fake.client);
  const graded = [...fake.subs.values()].find((s) => s.workflow_state === "graded")!;
  graded.score = 0.5;
  const again = await canvasParticipation(fake.admin, fake.actors, "verify", fake.client);
  assert.ok(again.rows.some((r) => r.outcome === "teacher grade 0.5 kept"));
});

test("fixture quiz answers map onto the Canvas question's own choices", () => {
  const quiz = canvasDemoPlan().courses.flatMap((c) => c.quizzes).find((q) => q.items.some((i) => i.type === "multiple-choice"))!;
  const index = quiz.items.findIndex((i) => i.type === "multiple-choice");
  const item = quiz.items[index]!;
  if (item.type !== "multiple-choice") throw new Error("unreachable");
  const canvas = canvasQuizQuestion(item, 1) as { question_type: string; answers: { answer_text: string; answer_weight: number }[] };
  const question = { id: 1, question_type: canvas.question_type, points_possible: 1, answers: canvas.answers.map((a, i) => ({ id: 10 + i, text: a.answer_text, weight: a.answer_weight })) };
  const correct = item.choices.findIndex((c) => c.id === item.correctChoiceId);
  assert.equal(canvasQuizAnswer(item, { type: "multiple-choice", choiceId: item.correctChoiceId }, question), 10 + correct);
  assert.throws(() => canvasQuizAnswer(item, { type: "numeric", value: 1 }, question), /does not fit/);
});

test("console credentials refuse anything but a demo principal and expire by purpose", async () => {
  const scripts: string[] = [];
  const actors = consoleActors((ruby) => { scripts.push(ruby); return /expires_at:Time.now.utc\+3600/.test(ruby) ? [] : 0; }, "educateos-demo test");
  await assert.rejects(actors.credentials(['prn_x"); User.destroy_all; ("']), /Refusing principal/);
  await actors.credentials(["prn_nf-student-kofi"]);
  assert.match(scripts[0]!, /sis_user_id:\["educateos-demo:prn_nf-student-kofi"\]/);
  assert.equal(await actors.expire(), 0);
  assert.match(scripts[1]!, /purpose:"educateos-demo test"/);
  assert.throws(() => consoleActors(() => 0, 'x"; evil'), /Unsafe credential purpose/);
});
