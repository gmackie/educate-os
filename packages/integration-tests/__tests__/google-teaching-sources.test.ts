// A personal teacher reads pre-existing Classroom instructions through the real Google binding.
// Only Google's REST service and the model are faked; OAuth, consent, RPC and observations are real.
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeClassroom } from "../../gatekeeper-google/__tests__/classroom-fixture.ts";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import { FakeGoogle, googleGatekeeper } from "./google-fake.js";

const classroom = new FakeClassroom();
const google = new FakeGoogle();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler,
  (url, _method, _headers, request) => url.hostname === "classroom.googleapis.com" ? classroom.fetch(request) : null,
  google.handler,
] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [googleGatekeeper()], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally { network.uninstall(); }
});

it("brings a teacher's existing coursework into model context without changing or grading it", async () => {
  const [username] = nextUsernames("teachingsources");
  if (!username) throw new Error("Missing test user");
  using client = connect(harness.url);
  using api = await signUp(client, username);
  const account = await google.connect(harness, api, username);
  await google.grant(harness, api, account, username, ["https://classroom.googleapis.com/courses/:courseId"]);
  const existing = classroom.courseWork.find(work => work.id === "202")!;
  Object.assign(existing, {
    description: "Investigate food chains using the lesson I already teach.",
    materials: [{ driveFile: { driveFile: { title: "My existing slides", alternateLink: "https://drive.google.com/file/d/lesson/view" } } }],
  });
  const model = models.script([
    { toolCall: { id: "sources", name: "executeCode", arguments: { code: `export default async function(self, env) {
      return JSON.stringify(await env.CLASSROOM.listTeachingMaterials());
    }` } } },
    { text: "Here are three ways to reuse your existing lesson. The linked slides need their own Drive connection." },
    { text: "Reusing the instructions changes the least." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newWorkspace();
  using reader = await ws.createGadget("Personal lesson", undefined, "LESSON");
  using connection = await ws.newGatekeeper(account.id, "https://classroom.googleapis.com/courses/101");
  if (!connection) throw new Error("Missing Classroom binding");
  await reader.bind("CLASSROOM", await connection.getId());
  const chat = await ws.newChat("Compare ways to reuse my existing Classroom lesson. Read materials only.", SCRIPTED_MODEL_ID);
  await waitFor("teaching sources in the model request", async () => model.requests.length >= 2 || null);
  await waitForIdleChat(ws, chat);
  await ws.sendChatMessage(chat, "Which option changes the least?", SCRIPTED_MODEL_ID);
  await waitFor("the later teaching-source turn", async () => model.requests.length >= 3 || null);
  await waitForIdleChat(ws, chat);
  for (const request of model.requests.slice(1)) {
    expect(request).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "sources", content: expect.stringContaining("Investigate food chains") }),
    ]) });
    expect(JSON.stringify(request)).toContain("My existing slides");
    expect(JSON.stringify(request)).not.toContain("assignedGrade");
  }
  const observations = await ws.listActions({ filter: "observation" });
  expect(observations.entries.some(entry => entry.description.title === "Read existing Classroom teaching materials")).toBe(true);
  expect((await ws.listActions({ filter: "pending" })).entries).toEqual([]);
  expect(classroom.requests.every(request => request.method === "GET")).toBe(true);
  expect(classroom.requests.some(request => request.path.endsWith("/students") || request.path.includes("studentSubmissions"))).toBe(false);
});
