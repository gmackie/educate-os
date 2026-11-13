import { canvasQuizQuestion } from "./canvas-quiz.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityInstructions, canvasDemoPlan, CanvasClient, seedCanvasDemo } from "./seed-canvas-demo.ts";

test("the Canvas school covers every grade band with active teachers and students", () => {
  const plan = canvasDemoPlan();
  assert.equal(plan.accountId, 3);
  assert.equal(plan.courses.length, 12);
  assert.equal(new Set(plan.users.map(u => u.sisId)).size, plan.users.length);
  assert.deepEqual([...new Set(plan.courses.map(c => c.band))].toSorted(), ["3-5", "6-8", "9-12", "K-2"]);
  for (const course of plan.courses) {
    assert.ok(course.enrollments.some(e => e.role === "teacher"));
    assert.ok(course.enrollments.filter(e => e.role === "student").length >= 2);
  }
});

test("learner instructions escape HTML and never publish answer keys or student exemplars", () => {
  const original = canvasDemoPlan().courses.flatMap(c => c.activities).find(a => a.template === "problem-set")!;
  assert.equal(original.template, "problem-set");
  const html = activityInstructions({ ...original, overview: "<script>bad()</script>", problems: [{ prompt: "Find x", answer: "SECRET-ANSWER" }], work: { student: { stage: "submitted", text: "SECRET-WORK" } } });
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Find x"));
  assert.ok(!html.includes("SECRET"));
});

test("pagination refuses foreign links before sending credentials", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response("[]", { headers: { link: '<https://attacker.example/api/v1/users>; rel="next"' } });
  };
  await assert.rejects(new CanvasClient("secret", transport).list("accounts/3/users"), /outside the demo API/);
  assert.equal(calls, 1);
});

test("an ambiguous write fails without retrying it or leaking the provider body", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response("PRIVATE BODY", { status: 503 }); };
  await assert.rejects(new CanvasClient("secret", transport).request("POST", "accounts/3/courses", {}), error => {
    assert.match(String(error), /Check the provider before retrying/);
    assert.ok(!String(error).includes("PRIVATE BODY")); return true;
  });
  assert.equal(calls, 1);
});

test("a second run creates nothing and verification leaves unrelated account records intact", async () => {
  type Row = Record<string, any>;
  const users: Row[] = [{ id: 2, login_id: "existing-admin" }];
  const courses: Row[] = [{ id: 2, course_code: "EDU-LTI", workflow_state: "available" }];
  const assignments = new Map<string, Row[]>();
  const enrollments = new Map<string, Row[]>();
  const collections = new Map<string, Row[]>();
  let nextId = 1000;
  let writes = 0;
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let value: unknown;
    if (method !== "GET") writes++;
    if (path === "accounts/3/users") {
      if (method === "GET") value = users;
      else { const user = { id: nextId++, ...body.user, login_id: body.pseudonym.unique_id, sis_user_id: body.pseudonym.sis_user_id }; users.push(user); value = user; }
    } else if (path === "accounts/3/courses") {
      if (method === "GET") value = courses;
      else { const course = { id: nextId++, ...body.course, workflow_state: "unpublished" }; courses.push(course); value = course; }
    } else if (/^courses\/\d+\/assignments$/.test(path)) {
      const rows = assignments.get(path) ?? []; assignments.set(path, rows);
      if (method === "GET") value = rows;
      else { const row = { id: nextId++, ...body.assignment }; rows.push(row); value = row; }
    } else if (/^courses\/\d+\/enrollments$/.test(path)) {
      const rows = enrollments.get(path) ?? []; enrollments.set(path, rows);
      if (method === "GET") value = rows;
      else { rows.push(body.enrollment); value = body.enrollment; }
    } else if (/^courses\/\d+\/(modules|pages|discussion_topics|quizzes)$/.test(path) || /^courses\/\d+\/modules\/\d+\/items$/.test(path)) {
      const rows = collections.get(path) ?? []; collections.set(path, rows);
      if (method === "GET") value = rows;
      else {
        const row = { id: nextId++, ...body.quiz, ...body.module, ...body.module_item, ...body.wiki_page, ...(path.endsWith("discussion_topics") ? body : {}) };
        if (body.wiki_page) { row.page_id = row.id; row.url = `page-${row.id}`; }
        rows.push(row); value = row;
      }
    } else if (/^courses\/\d+\/quizzes\/\d+\/questions$/.test(path)) {
      const rows = collections.get(path) ?? []; collections.set(path, rows);
      if (method === "GET") value = rows;
      else { const row = { id: nextId++, ...body.question }; rows.push(row); value = row; }
    } else if (/^courses\/\d+\/quizzes\/\d+$/.test(path) && method === "PUT") {
      const prefix = path.split("/").slice(0, 3).join("/");
      const row = collections.get(prefix)!.find(r => r.id === Number(path.split("/")[3]))!;
      Object.assign(row, body.quiz, { question_count: collections.get(`${path}/questions`)!.length }); value = row;
    } else if (/^courses\/\d+\/modules\/\d+$/.test(path) && method === "PUT") {
      const [prefix, id] = [path.split("/").slice(0, 3).join("/"), Number(path.split("/")[3])];
      const row = collections.get(prefix)!.find(r => r.id === id)!;
      Object.assign(row, body.module); value = row;
    } else if (/^courses\/\d+$/.test(path) && method === "PUT") {
      const course = courses.find(c => c.id === Number(path.split("/")[1]))!;
      course.workflow_state = "available"; value = course;
    } else throw new Error(`Unexpected ${method} ${path}`);
    return Response.json(value);
  };
  const client = new CanvasClient("secret", transport);
  assert.deepEqual((await seedCanvasDemo(client, "run")).problems, []);
  const topics = [...collections.entries()].filter(([path]) => path.endsWith("/discussion_topics")).flatMap(([, rows]) => rows);
  assert.equal(topics.filter(t => t.is_announcement).length, canvasDemoPlan().courses.reduce((n, c) => n + c.announcements.length, 0));
  assert.equal(topics.filter(t => !t.is_announcement).length, canvasDemoPlan().courses.reduce((n, c) => n + c.discussions.length, 0));
  assert.ok(topics.every(t => t.published && t.message.includes("managed by seed-canvas-demo.ts")));
  assert.ok([...collections.values()].flat().some(row => row.type === "Discussion"));
  const firstWrites = writes;
  assert.ok(firstWrites > 50);
  assert.deepEqual((await seedCanvasDemo(client, "run")).problems, []);
  assert.equal(writes, firstWrites);
  assert.deepEqual((await seedCanvasDemo(client, "verify")).problems, []);
  assert.equal(writes, firstWrites);
  const quiz = [...collections.entries()].find(([path]) => path.endsWith("/quizzes"))![1][0]!;
  quiz.published = false;
  assert.ok((await seedCanvasDemo(client, "run")).problems.some(p => p.startsWith("Quiz configuration drift:")));
  assert.equal(writes, firstWrites, "incomplete quizzes require inspection, never blind recreation");
  quiz.published = true;
  quiz.description = "Teacher-owned content";
  await assert.rejects(seedCanvasDemo(client, "run"), /Unowned quiz collision/);
  assert.equal(writes, firstWrites);
  assert.deepEqual(courses[0], { id: 2, course_code: "EDU-LTI", workflow_state: "available" });
  assert.deepEqual(users[0], { id: 2, login_id: "existing-admin" });
});


test("all-or-nothing multiple select stays teacher scored without exposing its key", () => {
  const question = canvasQuizQuestion({ type: "multiple-select", prompt: "Choose <one>", points: 2,
    choices: [{ id: "a", text: "Choice A" }, { id: "b", text: "Choice B" }], correctChoiceIds: ["a"], scoring: "all-or-nothing" }, 1);
  assert.equal(question.question_type, "essay_question");
  assert.ok(question.question_text.includes("&lt;one&gt;"));
  assert.ok(question.question_text.includes("teacher will score"));
  assert.ok(!("answers" in question));
});

test("numeric tolerance and multiple-choice keys are preserved in Canvas question fields", () => {
  const numeric = canvasQuizQuestion({ type: "numeric", prompt: "Measure", points: 3, answer: 12, tolerance: 0.5 }, 2);
  assert.ok("answers" in numeric);
  assert.deepEqual(numeric.answers, [{ numerical_answer_type: "exact_answer", answer_exact: 12, answer_error_margin: 0.5, answer_weight: 100 }]);
  const choice = canvasQuizQuestion({ type: "multiple-choice", prompt: "Pick", points: 1, choices: [{ id: "x", text: "X" }, { id: "y", text: "Y" }], correctChoiceId: "y" }, 1);
  assert.ok("answers" in choice);
  assert.deepEqual(choice.answers.map(a => a.answer_weight), [0, 100]);
});
