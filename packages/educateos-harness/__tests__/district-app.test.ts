import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient } from "@educateos/api-client";
import { bootDistrictApp, bootHarness, harnessFetch, seedDemo, type HarnessDistrict } from "../src/index.ts";

async function seeded() {
  return Promise.all((await bootHarness()).map(async (entry) => {
    const app = await bootDistrictApp(entry);
    return { entry, app, demo: await seedDemo(entry, app), fetch: harnessFetch(entry, app) };
  }));
}

const clientFor = async (entry: HarnessDistrict, fetch: (request: Request) => Promise<Response>, subject: string) =>
  createDistrictApiClient({ baseUrl: "http://district.harness", token: await entry.identity.issueToken(subject), fetch });

describe("the harness district app", () => {
  // Seeding all six districts takes several seconds, so they are seeded once; every test only reads.
  let districts: Awaited<ReturnType<typeof seeded>>;
  beforeAll(async () => {
    districts = await seeded();
  }, 60_000);

  it("seeds an approved resource and an installed activity in every active class, a student artifact and a submission", async () => {
    for (const { entry, demo, fetch } of districts) {
      const { directory } = entry.district;
      const teacher = await clientFor(entry, fetch, demo.teacher.externalIdentities[0]!.subject);
      const offerings = await teacher.call("teacher.listOfferings");
      expect(offerings.length).toBeGreaterThan(0);

      const admin = await clientFor(entry, fetch, demo.admin.externalIdentities[0]!.subject);
      const health = await admin.call("admin.health");
      const activeClasses = directory.offerings.filter((o) => directory.terms.find((t) => t.id === o.termId)?.state === "active");
      expect(health.work).toMatchObject({ installedActivities: activeClasses.length, submissions: 1 });
      expect(health.content.releases).toBe(activeClasses.length);
      expect(health.config.revisions).toBe(1);
      expect(health.aiRequests).toBe(1);

      const student = await clientFor(entry, fetch, demo.student.externalIdentities[0]!.subject);
      const workspaces = await student.call("student.listWorkspaces");
      expect(workspaces.map((w) => w.kind).toSorted()).toStrictEqual(["course", "personal"]);
      const course = workspaces.find((w) => w.kind === "course")!;
      if (course.kind !== "course") throw new Error("expected a course workspace");
      const [activity] = await student.call("student.listActivities", { params: { offeringId: course.offeringId } });
      expect(activity!.activity.view).toBe("student");
      expect(await student.call("student.listSubmissions", { params: { assignmentId: activity!.assignment.id } })).toHaveLength(1);
    }
  });

  it("covers writing, science and history in each district, and mathematics or the arts", async () => {
    for (const { entry, demo, fetch } of districts) {
      const admin = await clientFor(entry, fetch, demo.admin.externalIdentities[0]!.subject);
      expect((await admin.call("admin.health")).work.installedActivities).toBeGreaterThanOrEqual(4);
      const subjects = new Set(entry.district.directory.courses.map((c) => c.subject));
      for (const subject of ["english-language-arts", "science", "history-social-studies"] as const) expect(subjects.has(subject)).toBe(true);
      expect(subjects.has("mathematics") || subjects.has("arts")).toBe(true);
    }
  });

  it("serves /api on the district app and keeps /health on the instance, and rejects the other district's tokens", async () => {
    const [northfield, riverbend] = districts;
    expect((await northfield!.fetch(new Request("http://district.harness/health"))).status).toBe(200);
    const token = await northfield!.entry.identity.issueToken(northfield!.demo.student.externalIdentities[0]!.subject);
    const authorized = { headers: { authorization: `Bearer ${token}` } };
    expect((await northfield!.fetch(new Request("http://district.harness/api/me", authorized))).status).toBe(200);
    expect((await riverbend!.fetch(new Request("http://district.harness/api/me", authorized))).status).toBe(401);
  });
});
