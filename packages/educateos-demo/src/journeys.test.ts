import { describe, expect, it } from "vitest";
import { stepsDoneBy } from "./journeys.ts";

const request = (method: string, path: string) => ({ method, url: `https://district.demo.educateos.invalid${path}` });
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("journey steps", () => {
  it("counts a step only for a successful request of its own method and path", async () => {
    expect(await stepsDoneBy("teacher", request("POST", "/api/teacher/offerings/off_1/announcements"), answer(201), "#/")).toEqual(["teacher.announce"]);
    expect(await stepsDoneBy("teacher", request("GET", "/api/teacher/offerings/off_1/announcements"), answer(200), "#/")).toEqual([]);
    expect(await stepsDoneBy("teacher", request("POST", "/api/teacher/offerings/off_1/announcements"), answer(403), "#/")).toEqual([]);
    // A pattern segment stands for exactly one path segment.
    expect(await stepsDoneBy("admin", request("GET", "/api/admin/offerings"), answer(200), "#/")).toEqual(["admin.classes"]);
    expect(await stepsDoneBy("admin", request("GET", "/api/admin/offerings/off_1/roster"), answer(200), "#/")).toEqual(["admin.roster"]);
  });

  it("counts released feedback as read only when the activity's own page lists some", async () => {
    const feedback = request("GET", "/api/student/assignments/asg_1/feedback");
    const released = [{ submissionId: "sub_1", comments: [] }];
    // The course page asks too, to badge the activities that have some.
    expect(await stepsDoneBy("student", feedback, answer(200, released), "#/courses/off_1")).toEqual([]);
    expect(await stepsDoneBy("student", feedback, answer(200, released), "#/courses/off_1/activities/asg_1")).toEqual(["student.feedback"]);
    // An activity with nothing released answers an empty list.
    expect(await stepsDoneBy("student", feedback, answer(200, []), "#/courses/off_1/activities/asg_1")).toEqual([]);
  });

  it("leaves the response for the app to read", async () => {
    const response = answer(200, [{ submissionId: "sub_1" }]);
    await stepsDoneBy("student", request("GET", "/api/student/assignments/asg_1/feedback"), response, "#/courses/off_1/activities/asg_1");
    expect(await response.json()).toEqual([{ submissionId: "sub_1" }]);
  });

  it("counts a look at a child's class only on that class's page, not the child's page that summarizes each", async () => {
    const course = request("GET", "/api/guardian/children/prn_1/offerings/off_1");
    expect(await stepsDoneBy("guardian", course, answer(200), "#/family/children/prn_1")).toEqual([]);
    expect(await stepsDoneBy("guardian", course, answer(200), "#/family/children/prn_1/courses/off_1")).toEqual(["guardian.course"]);
  });

  it("counts the technology director's steps only on their own screens, not the Dashboard's or a school's reads", async () => {
    const tick = (method: string, path: string, screen: string) => stepsDoneBy("it-director", request(method, path), answer(200), screen);
    // The Dashboard reads the district's health and re-plans the configuration in force on load.
    expect(await tick("GET", "/api/admin/health", "#/dashboard")).toEqual([]);
    expect(await tick("GET", "/api/admin/health", "")).toEqual([]);
    expect(await tick("POST", "/api/admin/config/plan", "#/dashboard")).toEqual([]);
    // Modules and activation dry-runs two plans on load to survey the classes.
    expect(await tick("POST", "/api/admin/config/plan", "#/modules")).toEqual([]);
    // A school's page lists its classes too.
    expect(await tick("GET", "/api/admin/offerings", "#/schools/sch_1")).toEqual([]);

    expect(await tick("GET", "/api/admin/offerings", "#/classes")).toEqual(["it-director.classes"]);
    expect(await tick("GET", "/api/admin/authoring", "#/classes-people/sections/off_1")).toEqual(["it-director.people"]);
    expect(await tick("GET", "/api/admin/health", "#/roster")).toEqual(["it-director.roster"]);
    expect(await tick("POST", "/api/admin/config/plan", "#/policies")).toEqual(["it-director.preview"]);
    expect(await tick("POST", "/api/admin/config/apply", "#/policies")).toEqual(["it-director.apply"]);
    expect(await tick("GET", "/api/admin/ai/funding", "#/ai-budgets")).toEqual(["it-director.budgets"]);
    expect(await tick("GET", "/api/admin/ops/keys", "#/operations")).toEqual(["it-director.operations"]);
    expect(await tick("GET", "/api/admin/audit/decisions", "#/safety-decisions")).toEqual(["it-director.safety"]);
    expect(await tick("GET", "/api/admin/audit/admin-actions", "#/audit-log")).toEqual(["it-director.audit"]);
    expect(await tick("GET", "/api/admin/sign-in", "#/sign-in")).toEqual(["it-director.sign-in"]);
    // The same requests as the plain administrator tick only their own journey.
    expect(await stepsDoneBy("admin", request("GET", "/api/admin/ai/funding"), answer(200), "#/ai-budgets")).toEqual([]);
  });

  it("keeps each persona to its own steps", async () => {
    expect(await stepsDoneBy("guardian", request("GET", "/api/admin/offerings"), answer(200), "#/")).toEqual([]);
  });
});
