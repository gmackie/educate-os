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

  it("keeps each persona to its own steps", async () => {
    expect(await stepsDoneBy("guardian", request("GET", "/api/admin/offerings"), answer(200), "#/")).toEqual([]);
  });
});
