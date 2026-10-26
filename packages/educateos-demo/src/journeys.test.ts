import { describe, expect, it } from "vitest";
import { stepsDoneBy } from "./journeys.ts";

const request = (method: string, path: string) => ({ method, url: `https://district.demo.educateos.invalid${path}` });

describe("journey steps", () => {
  it("counts a step only for a successful request of its own method and path", () => {
    expect(stepsDoneBy("teacher", request("POST", "/api/teacher/offerings/off_1/announcements"), 201, "#/")).toEqual(["teacher.announce"]);
    expect(stepsDoneBy("teacher", request("GET", "/api/teacher/offerings/off_1/announcements"), 200, "#/")).toEqual([]);
    expect(stepsDoneBy("teacher", request("POST", "/api/teacher/offerings/off_1/announcements"), 403, "#/")).toEqual([]);
    // A pattern segment stands for exactly one path segment.
    expect(stepsDoneBy("admin", request("GET", "/api/admin/offerings"), 200, "#/")).toEqual(["admin.classes"]);
    expect(stepsDoneBy("admin", request("GET", "/api/admin/offerings/off_1/roster"), 200, "#/")).toEqual(["admin.roster"]);
  });

  it("counts released feedback as read only on the activity's own page, not the course list that badges it", () => {
    const feedback = request("GET", "/api/student/submissions/sub_1/feedback");
    expect(stepsDoneBy("student", feedback, 200, "#/courses/off_1")).toEqual([]);
    expect(stepsDoneBy("student", feedback, 200, "#/courses/off_1/activities/asg_1")).toEqual(["student.feedback"]);
    // Unreleased feedback answers not-found.
    expect(stepsDoneBy("student", feedback, 404, "#/courses/off_1/activities/asg_1")).toEqual([]);
  });

  it("keeps each persona to its own steps", () => {
    expect(stepsDoneBy("guardian", request("GET", "/api/admin/offerings"), 200, "#/")).toEqual([]);
  });
});
