// Record parsing: only the fields the gatekeeper names cross out of the client, so a user record's
// email, credentials, contacts and demographics never reach a projection, however the district's
// data carries them.

import { describe, expect, it } from "vitest";
import { parseSection, parseSubmission, parseUser } from "../src/clever-api";
import { districtToken } from "../src/clever-env";
import { rolesOf, toRosterMember } from "../src/clever-model";

const USER = {
  id: "0123456789abcdef01234567",
  district: "fedcba9876543210fedcba98",
  email: "ada@school.example",
  name: { first: "Ada", last: "Brightwater", middle: "" },
  roles: {
    student: {
      grade: "9", schools: ["aaaaaaaaaaaaaaaaaaaaaaaa"], sis_id: "S1", student_number: "1001",
      credentials: { district_username: "ada" }, ell_status: "N", gender: "F", dob: "2011-01-01", race: "x",
      enrollments: [], ext: { secret: true },
    },
    contact: null,
  },
};

describe("parsing", () => {
  it("keeps a user's ID, name, district, roles, grade and schools, and nothing else", () => {
    const user = parseUser(USER);
    expect(user).toEqual({
      id: USER.id, district: USER.district, first: "Ada", last: "Brightwater",
      roles: { student: { grade: "9", schools: ["aaaaaaaaaaaaaaaaaaaaaaaa"] } },
    });
    expect(toRosterMember(user)).toEqual({ id: USER.id, name: "Ada Brightwater", grade: "9" });
    expect(rolesOf(user)).toEqual(["student"]);
    expect(JSON.stringify(user)).not.toMatch(/school\.example|1001|2011|ell|gender|race|district_username/);
  });

  it("reads a district that renders nulls", () => {
    const section = parseSection({
      id: "0123456789abcdef01234567", district: "fedcba9876543210fedcba98", school: "aaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Biology", course: null, term_id: null, subject: null, grade: null, teacher: null, teachers: [], students: null,
    });
    expect(section).toEqual({
      id: "0123456789abcdef01234567", district: "fedcba9876543210fedcba98", school: "aaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Biology", teachers: [], students: [],
    });
    expect(parseSubmission({ user_id: "u", state: "returned", grade_points: 8, grade_comment: null })).toEqual({
      userId: "u", state: "returned", gradePoints: 8,
    });
  });

  it("reads a district's token from the deployment's map, and no other", () => {
    const env = { CLEVER_DISTRICT_TOKENS: JSON.stringify({ d1: "t1", d2: "" }) } as never;
    expect(districtToken(env, "d1")).toBe("t1");
    expect(districtToken(env, "d2")).toBeUndefined();
    expect(districtToken(env, "toString")).toBeUndefined();
    expect(districtToken({ CLEVER_DISTRICT_TOKENS: "not json" } as never, "d1")).toBeUndefined();
  });
});
