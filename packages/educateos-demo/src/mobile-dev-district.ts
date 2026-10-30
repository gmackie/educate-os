/// <reference types="node" />
// The mobile dev district (SCHO-272): the demo's seeded Northfield, served on localhost with phone
// pairing turned on, so a development build of the app in the iOS Simulator (or an Android
// emulator, through `adb reverse`) can sign in as any demo persona and see real class data.
//
//   pnpm educateos:mobile-district     serve on http://localhost:4810 until interrupted
//
// In the app, choose "I have a web address", enter http://localhost:4810, then "Sign in with a demo
// person": the /connect-phone page asks which persona you are and approves the phone. English 9 also
// gets a module, an announcement, a discussion and a quiz, so every native screen has something. Development
// builds accept loopback school addresses (apps/mobile/src/security.ts); release builds never do.
// Nothing is persisted: restarting the server signs every phone out.
//
// EDUCATEOS_MOBILE_DISTRICT_PORT changes the port. This is development tooling, never deployed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DistrictApiClient } from "@educateos/api-client";
import { bootNorthfield, NORTHFIELD_PERSONAS as PERSONAS } from "./districts/northfield.ts";

const PORT = Number(process.env.EDUCATEOS_MOBILE_DISTRICT_PORT ?? 4810);
const ORIGIN = `http://localhost:${PORT}`;
const COOKIE = "eos_dev_persona";

/** The school manifest the app reads first (apps/mobile/src/manifest.ts). */
const MANIFEST = {
  v: 1,
  name: "Northfield (dev)",
  origin: ORIGIN,
  brand: { logo: null, accent: null },
  signIn: [{ id: "demo", label: "a demo person" }],
  features: { ai: false, mobile: true, family: true },
  mobileApi: { min: 1, max: 2 },
  release: null,
};

function cookieSubject(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE && value) return decodeURIComponent(value);
  }
  return undefined;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in this district stands in for: pick who you are, then carry on to `next`. */
function pickPersona(next: string): Response {
  const rows = PERSONAS.map((p) => `<a class="row" href="/dev/sign-in?as=${encodeURIComponent(p.subject)}&amp;next=${encodeURIComponent(next)}">
    <strong>${escape(p.name)}</strong><span>${escape(p.role)}</span></a>`).join("\n");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Northfield (dev)</title><style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:28px 20px;background:#f5f7fb;color:#14213d}
h1{font-size:24px;margin:0 0 6px}p{color:#5b6475;margin:0 0 20px}
.row{display:flex;flex-direction:column;gap:3px;padding:16px;margin-bottom:10px;border-radius:14px;background:#fff;border:1px solid #e3e7ef;color:inherit;text-decoration:none}
.row span{color:#5b6475;font-size:14px}
</style></head><body><h1>Who are you?</h1><p>Northfield (dev) has no real sign-in. Choose a demo person to connect this phone as.</p>
${rows}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Sam Rivera, who teaches the demo's English 9, and Elena Sato, Amara's classmate there. */
const TEACHER = "nf-0101";
const CLASSMATE = "nf-s-2004";

/**
 * What the browser demo leaves out but the phone shows: a published module with a page and the
 * open assignment, an announcement, a discussion with a classmate's post, and a quiz. All in
 * English 9, made through the district API as Sam would make them.
 */
async function seedCourseContent(teacher: DistrictApiClient, classmate: DistrictApiClient): Promise<void> {
  const english = (await teacher.call("teacher.listOfferings")).find(({ course }) => course.title === "English 9");
  if (english === undefined) throw new Error("the demo has no English 9");
  const params = { offeringId: english.offering.id };
  const assignments = await teacher.call("teacher.listAssignments", { params });
  const reflection = assignments.find((a) => a.title === "Reading reflection") ?? assignments[0]!;

  const unit = await teacher.call("teacher.createModule", { params, body: { title: "Unit 2: Making an argument" } });
  const moduleParams = { ...params, moduleId: unit.id };
  await teacher.call("teacher.addPage", {
    params: moduleParams,
    body: {
      title: "Claims, evidence and counterclaims",
      body: "## Build the argument\n\nA strong argument makes a **claim**, supports it with **evidence**, and answers the best **counterclaim**.\n\n- State your claim in one sentence.\n- Give two pieces of evidence.\n- Name one objection and answer it.",
    },
  });
  await teacher.call("teacher.placeActivity", { params: moduleParams, body: { activityId: reflection.activityId } });
  await teacher.call("teacher.updateModule", { params: moduleParams, body: { published: true } });

  await teacher.call("teacher.createAnnouncement", {
    params,
    body: { title: "Library visit on Friday", body: "We meet in the library on Friday. Bring the book you are reading for your reflection." },
  });

  const topic = await teacher.call("teacher.createTopic", {
    params,
    body: { title: "Should homework be banned?", prompt: "Take a side and give **one** reason. Reply to a classmate you disagree with." },
  });
  await classmate.call("student.createPost", { params: { ...params, topicId: topic.id }, body: { body: "No. Practice at home is how I get better at math." } });

  const quiz = await teacher.call("teacher.createQuiz", {
    params,
    body: {
      title: "Argument terms",
      assignmentId: reflection.id,
      items: [
        { type: "multiple-choice", prompt: "What answers the best objection to your position?", points: 2, choices: [{ id: "a", text: "A claim" }, { id: "b", text: "A rebuttal" }, { id: "c", text: "A hook" }], correctChoiceId: "b" },
        { type: "short-answer", prompt: "One word for the facts and quotations that support a claim.", points: 1, acceptedAnswers: ["evidence"] },
        { type: "essay", prompt: "In two or three sentences, state a claim about school start times and support it.", points: 5 },
      ],
      settings: { attemptsAllowed: 2, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" },
    },
  });
  await teacher.call("teacher.publishQuiz", { params: { ...params, quizId: quiz.id }, body: { published: true } });
}

async function handle(request: Request, district: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/educateos.json") return Response.json(MANIFEST, { headers: { "cache-control": "no-store" } });
  if (url.pathname === "/dev/sign-in") {
    const subject = url.searchParams.get("as") ?? "";
    const next = url.searchParams.get("next") ?? "";
    if (!PERSONAS.some((p) => p.subject === subject) || !next.startsWith("/connect-phone?")) return new Response("bad request", { status: 400 });
    return new Response(null, { status: 303, headers: { location: next, "set-cookie": `${COOKIE}=${encodeURIComponent(subject)}; Path=/; HttpOnly; SameSite=Lax` } });
  }
  // Each pairing starts at the picker, so one browser can connect phones as different people.
  if (url.pathname === "/connect-phone" && !url.searchParams.has("as")) return pickPersona(`${url.pathname}${url.search}&as=1`);
  return district.fetch(request);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", ORIGIN), { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  console.log("Seeding Northfield (dev)…");
  const district = await bootNorthfield({
    deviceTokenSecret: crypto.randomUUID() + crypto.randomUUID(),
    subjectOf: cookieSubject,
  });
  await seedCourseContent(district.clientFor(TEACHER), district.clientFor(CLASSMATE));
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    toRequest(req)
      .then((request) => handle(request, district))
      .then((response) => writeResponse(res, response))
      .catch((error: unknown) => {
        console.error("request failed", error);
        res.writeHead(500).end();
      });
  };
  // "localhost" is ::1 or 127.0.0.1 depending on who asks; answer on both, and only on loopback.
  await Promise.all(["127.0.0.1", "::1"].map((host) => new Promise<void>((resolve, reject) => {
    const server = createServer(listener);
    server.once("error", reject);
    server.listen(PORT, host, () => resolve());
  })));
  console.log(`Northfield (dev) at ${ORIGIN}`);
  for (const p of PERSONAS) console.log(`  ${p.name.padEnd(14)} ${p.role}`);
  console.log("In the app: I have a web address → " + ORIGIN + " → Sign in with a demo person. Ctrl-C to stop.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
