// SCHO-203: the district Worker builds a Clever roster source from its token and runs whichever
// roster sync is due on its hourly Cron Trigger, skipping quietly when it has nothing to run.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { readDistrictWorkerConfig } from "../src/config.ts";
import { TEST_CONFIG } from "./fixtures.ts";
import { workerClassroomGrades, workerRosterSource } from "../src/district.ts";
import { NOTIFICATION_CRON } from "../src/schedule.ts";

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);
const CLEVER = { provider: "clever", mode: "apply-automatically", clever: { districtId: "6650c1a0e1b2c3d4e5f6d001" } } as const;
const unused: typeof fetch = async () => {
  throw new Error("no request is made while building a source");
};

describe("the Worker's roster source", () => {
  it("reads a Clever roster with the district's token", () => {
    const built = workerRosterSource("district-token", unused)(CLEVER);
    expect("source" in built && built.source.kind).toBe("clever");
  });

  it("says why it has none: no token, no Clever district, or a provider it does not sync", () => {
    expect(workerRosterSource(undefined, unused)(CLEVER)).toEqual({ reason: "no CLEVER_DISTRICT_TOKEN secret is set" });
    expect(workerRosterSource("", unused)(CLEVER)).toEqual({ reason: "no CLEVER_DISTRICT_TOKEN secret is set" });
    expect(workerRosterSource("district-token", unused)({ provider: "clever", mode: "apply-automatically" })).toEqual({ reason: "the roster names no Clever district" });
    expect(workerRosterSource("district-token", unused)({ provider: "oneroster-api", mode: "apply-automatically" }))
      .toEqual({ reason: "the district Worker has no roster source for oneroster-api" });
  });
});

describe("the hourly roster sync", () => {
  it("skips without a Clever token or roster configuration, and the hourly job still completes", async () => {
    expect(env.CLEVER_DISTRICT_TOKEN).toBeUndefined();
    expect(await district().scheduledRosterSync()).toMatchObject({ ran: false, reason: expect.any(String) });
    await district().runScheduled(NOTIFICATION_CRON);
  });
});


describe("the Classroom roster source", () => {
  const rostering = {
    provider: "google-classroom", mode: "apply-automatically",
    identityMapping: { issuer: "https://accounts.google.com", subject: { field: "username" } },
  } as const;
  const connection = () => readDistrictWorkerConfig(JSON.stringify({ ...TEST_CONFIG, classroom: {
    admin: "admin@example.edu", rosterScopes: "readonly",
    roster: {
      term: { sourcedId: "fall", title: "Fall", startDate: "2026-09-01", endDate: "2026-12-31" },
      schools: [{ sourcedId: "school", name: "School", grades: ["08"], courses: ["123"] }],
      courseSelection: "listed",
    },
  } })).classroom!;

  it("does not attempt provider calls without deployment credentials", () => {
    expect(workerRosterSource(undefined, unused)(rostering)).toEqual({ reason: "no Classroom connection is configured" });
    expect(workerRosterSource(undefined, unused, { config: connection(), key: undefined })(rostering))
      .toEqual({ reason: "no GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY secret is set" });
  });

  it("uses delegated read scopes and imports only listed courses", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.hostname === "oauth2.googleapis.com") {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        const claims = JSON.parse(atob(assertion.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
        expect(claims.sub).toBe("admin@example.edu");
        expect(claims.scope).toContain("classroom.courses.readonly");
        expect(claims.scope).not.toContain("classroom.coursework.students");
        return Response.json({ access_token: "delegated", token_type: "Bearer", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer delegated");
      if (url.pathname === "/v1/courses") return Response.json({ courses: [
        { id: "123", name: "Selected", courseState: "ACTIVE", ownerId: "111" },
        { id: "456", name: "Other district", courseState: "ACTIVE", ownerId: "222" },
      ] });
      if (url.pathname === "/v1/courses/123/teachers") return Response.json({ teachers: [] });
      if (url.pathname === "/v1/courses/123/students") return Response.json({ students: [] });
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const built = workerRosterSource(undefined, fetcher, {
      config: connection(),
      key: JSON.stringify({ type: "service_account", client_email: "sync@example.iam.gserviceaccount.com", private_key: pem }),
    })(rostering);
    if (!("source" in built)) throw new Error("source missing");
    const batch = await built.source.read({ mode: "complete" });
    expect(batch.issues?.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(calls).toEqual(["/token", "/v1/courses", "/v1/courses/123/teachers", "/v1/courses/123/students"]);
  });
});

// SCHO-403: the read-only "From Google Classroom" panel reads over the same connection.
describe("the Classroom grade source", () => {
  const connection = (rosterScopes: "readonly" | "read-write") => readDistrictWorkerConfig(JSON.stringify({ ...TEST_CONFIG, classroom: {
    admin: "admin@example.edu", rosterScopes,
    roster: { term: { sourcedId: "fall", title: "Fall", startDate: "2026-09-01", endDate: "2026-12-31" }, schools: [{ sourcedId: "school", name: "School", grades: ["08"] }] },
  } })).classroom!;

  it("is absent without a Classroom connection or its key, so the panel's routes answer not-connected", () => {
    expect(workerClassroomGrades(undefined, unused)).toBeUndefined();
    expect(workerClassroomGrades({ config: connection("readonly"), key: undefined }, unused)).toBeUndefined();
    expect(workerClassroomGrades({ config: connection("readonly"), key: "" }, unused)).toBeUndefined();
  });

  it("reads as the course owner with the delegated scope form, and only reads", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const scopes: string[] = [];
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method ?? "GET").toMatch(/^(GET|POST)$/);
      if (url.hostname === "oauth2.googleapis.com") {
        const claims = JSON.parse(atob(new URLSearchParams(String(init?.body)).get("assertion")!.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
        scopes.push(`${claims.sub} ${claims.scope}`);
        return Response.json({ access_token: `token-${claims.sub}`, token_type: "Bearer", expires_in: 3600 });
      }
      expect(init?.method ?? "GET").toBe("GET");
      calls.push(`${new Headers(init?.headers).get("authorization")} ${url.pathname}${url.search}`);
      if (url.pathname === "/v1/courses/123") return Response.json({ id: "123", name: "Science", courseState: "ACTIVE", ownerId: "111", alternateLink: "https://classroom.google.com/c/MTIz" });
      if (url.pathname === "/v1/courses/123/teachers/111") return Response.json({ userId: "111", profile: { emailAddress: "owner@example.edu" } });
      if (url.pathname === "/v1/courses/123/courseWork") return Response.json({ courseWork: [{ id: "9", title: "Quiz", state: "PUBLISHED", maxPoints: 10 }] });
      if (url.pathname === "/v1/courses/123/courseWork/-/studentSubmissions") {
        return Response.json({ studentSubmissions: [{ id: "s1", courseWorkId: "9", userId: "222", state: "RETURNED", assignedGrade: 8 }] });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const key = JSON.stringify({ type: "service_account", client_email: "sync@example.iam.gserviceaccount.com", private_key: pem });
    const source = workerClassroomGrades({ config: connection("read-write"), key }, fetcher)!;
    const read = await source.student("123", "222");
    expect(read).toMatchObject({ courseLink: "https://classroom.google.com/c/MTIz", courseWork: [{ id: "9", maxPoints: 10 }], submissions: [{ userId: "222", assignedGrade: 8 }], truncated: false });
    // The read-write scopes the demo tenant delegated, never their `.readonly` forms.
    for (const granted of scopes) {
      expect(granted).toContain("classroom.coursework.students");
      expect(granted).not.toContain(".readonly");
    }
    expect(calls.filter((c) => c.includes("studentSubmissions"))).toEqual(["Bearer token-owner@example.edu /v1/courses/123/courseWork/-/studentSubmissions?userId=222&states=RETURNED&pageSize=100"]);
  });
});
