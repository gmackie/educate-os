import { describe, expect, it } from "vitest";
import {
  Fake,
  GoogleClassroomFake,
  SAMPLE_DISTRICT,
  CleverDataFake,
  cleverLegacyId,
  cleverUserId,
  googleSubjectId,
  SeedError,
  enrollmentsOf,
  hexId,
  numericId,
  routeFetch,
  studentsToRemove,
  tokenId,
  validateSeed,
  withoutPeople,
} from "../src/index.ts";

class EchoFake extends Fake {
  removed: number[] = [];
  protected async serve(request: Request): Promise<Response> {
    return Response.json({ path: new URL(request.url).pathname, malformed: this.takeMalformed(request) });
  }
  protected errorResponse(status: number, reason: string): Response {
    return Response.json({ reason }, { status });
  }
  protected removeLargeShare(fraction: number): void {
    this.removed.push(fraction);
  }
}

describe("seeds", () => {
  it("accepts the sample district", () => {
    expect(validateSeed(SAMPLE_DISTRICT)).toBe(SAMPLE_DISTRICT);
  });

  it("refuses an address off .example, and broken references", () => {
    const bad = {
      ...SAMPLE_DISTRICT,
      people: [...SAMPLE_DISTRICT.people, { ...SAMPLE_DISTRICT.people[0]!, id: "x", email: "someone@gmail.com" }],
      sections: [{ ...SAMPLE_DISTRICT.sections[0]!, id: "y", studentIds: ["mw-t-okafor", "nobody"] }],
    };
    expect(() => validateSeed(bad)).toThrow(SeedError);
    expect(() => validateSeed(bad)).toThrow(/someone@gmail.com.*|nobody/);
    expect(() => validateSeed({ ...SAMPLE_DISTRICT, domain: "maplewood.org" })).toThrow(/not a .example domain/);
  });

  it("derives enrollments, teachers first and the first teacher primary", () => {
    const eng = enrollmentsOf(SAMPLE_DISTRICT).filter((e) => e.section.id === "mw-eng9-p1");
    expect(eng.slice(0, 2).map((e) => [e.personId, e.role, e.primary])).toEqual([
      ["mw-t-quill", "teacher", true],
      ["mw-t-reyes", "teacher", false],
    ]);
    expect(eng).toHaveLength(7);
  });

  it("removes the same students every time, with their roster places", () => {
    const removed = studentsToRemove(SAMPLE_DISTRICT, 0.3);
    expect([...removed]).toEqual(["mw-s-01", "mw-s-02", "mw-s-03"]);
    const after = withoutPeople(SAMPLE_DISTRICT, removed);
    expect(after.people.some((p) => removed.has(p.id))).toBe(false);
    expect(after.sections[0]!.studentIds).toEqual(["mw-s-04", "mw-s-05", "mw-s-06"]);
    expect(after.people.find((p) => p.id === "mw-g-brightwater")!.guardianOf).toEqual([]);
  });
});

describe("vendor IDs a seed carries", () => {
  const CLEVER = "6650c1a0e1b2c3d4e5f62001";
  const GOOGLE = "104000000000000002001";
  const seed = {
    ...SAMPLE_DISTRICT,
    people: SAMPLE_DISTRICT.people.map((p) => (p.id === "mw-s-01" ? { ...p, vendorIds: { clever: CLEVER, google: GOOGLE } } : p)),
  };

  it("replace the derived ones in sign-in and roster alike, and only for that person", () => {
    expect(cleverUserId(seed, "mw-s-01")).toBe(CLEVER);
    expect(cleverLegacyId(seed, "mw-s-01", "student")).toBe(CLEVER);
    expect(googleSubjectId(seed, "mw-s-01")).toBe(GOOGLE);
    expect(new CleverDataFake({ seed }).userId("mw-s-01")).toBe(CLEVER);
    expect(new GoogleClassroomFake({ seed }).userId("mw-s-01")).toBe(GOOGLE);
    expect(cleverUserId(seed, "mw-s-02")).toBe(cleverUserId(SAMPLE_DISTRICT, "mw-s-02"));
  });

  it("must be shaped like the vendor's and belong to one person", () => {
    const withIds = (ids: Record<string, { clever?: string; google?: string }>) => ({
      ...SAMPLE_DISTRICT,
      people: SAMPLE_DISTRICT.people.map((p) => (ids[p.id] === undefined ? p : { ...p, vendorIds: ids[p.id] })),
    });
    expect(() => validateSeed(withIds({ "mw-s-01": { clever: "not-hex" } }))).toThrow(/not 24 hex digits/);
    expect(() => validateSeed(withIds({ "mw-s-01": { google: "0123" } }))).toThrow(/not a decimal ID/);
    expect(() => validateSeed(withIds({ "mw-s-01": { clever: CLEVER }, "mw-s-02": { clever: CLEVER } }))).toThrow(/shares clever ID/);
  });
});

describe("ids", () => {
  it("are deterministic, shaped like the vendor's, and namespaced", () => {
    expect(hexId("clever:user", "a")).toMatch(/^[0-9a-f]{24}$/);
    expect(hexId("clever:user", "a")).toBe(hexId("clever:user", "a"));
    expect(hexId("clever:user", "a")).not.toBe(hexId("clever:section", "a"));
    expect(numericId("google:course", "a")).toMatch(/^[1-9]\d{11}$/);
    expect(tokenId("google:submission", "a")).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

describe("faults", () => {
  it("serves outages, rate limits and network errors a set number of times", async () => {
    const fake = new EchoFake();
    fake.inject({ kind: "outage", status: 502, times: 1, match: { path: "/a" } });
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 7, times: 1 });
    expect((await fake.fetch("https://x.example/a")).status).toBe(502);
    const limited = await fake.fetch("https://x.example/a");
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "7"]);
    expect((await fake.fetch("https://x.example/a")).status).toBe(200);

    const remove = fake.inject({ kind: "network-error", match: { method: "POST" } });
    await expect(fake.fetch("https://x.example/b", { method: "POST" })).rejects.toThrow(TypeError);
    expect((await fake.fetch("https://x.example/b")).status).toBe(200);
    remove();
    expect((await fake.fetch("https://x.example/b", { method: "POST" })).status).toBe(200);
    expect(fake.requests).toHaveLength(6);
  });

  it("hands data faults to the fake", async () => {
    const fake = new EchoFake();
    fake.inject({ kind: "malformed-record", times: 1 });
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    expect(await (await fake.fetch("https://x.example/l")).json()).toMatchObject({ malformed: true });
    expect(await (await fake.fetch("https://x.example/l")).json()).toMatchObject({ malformed: false });
    expect(fake.removed).toEqual([0.5]);
  });

  it("routes by origin, and fails other origins as unreachable", async () => {
    const fetch = routeFetch({ "https://a.example": new EchoFake() });
    expect((await fetch("https://a.example/z")).status).toBe(200);
    await expect(fetch("https://b.example/z")).rejects.toThrow(TypeError);
    expect(() => routeFetch({ "https://a.example": new EchoFake(), "https://a.example/other": new EchoFake() })).toThrow(/two fakes serve/);
  });

  it("applies a global path pattern to every matching request, not every other one", async () => {
    const fake = new EchoFake();
    fake.inject({ kind: "outage", match: { path: /\/a/g } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fake.fetch("https://x.example/a")).status);
    expect(statuses).toEqual([503, 503, 503]);
  });

  it("keeps a bounded number of recorded requests", async () => {
    const fake = new EchoFake({ maxRecordedRequests: 2 });
    for (const path of ["/1", "/2", "/3"]) await fake.fetch(`https://x.example${path}`);
    expect(fake.requests.map((r) => r.url.pathname)).toEqual(["/2", "/3"]);
  });
});
