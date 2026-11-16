// The demo-district run (SCHO-326) against a fake roster district whose fixture roster is already
// there under other sourcedIds, as harbor's is: the roster import is skipped, the pack installed and
// verified, and a district holding only some of the fixture's classes is still refused. The real
// importer is exercised in packages/educateos-district-worker/__tests__/demo-operator.test.ts.
import { describe, expect, it } from "vitest";
import { DEMO_DISTRICTS } from "@educateos/fixtures";
import {
  DEMO_STARTER_PACK,
  fixtureClassesListed,
  listingOf,
  rosteredUnderOtherIds,
  seedDemoDistrict,
  type DistrictAdminClient,
  type InstalledPack,
  type ListedClass,
  type RosterPreview,
} from "../src/demo-district.ts";

const harbor = DEMO_DISTRICTS.find((d) => d.slug === "harbor")!;
const empty = { added: [] as string[], updated: [] as string[], deactivated: [] as string[], retained: [] as string[] };

/** Harbor's fixture classes as the admin console lists them, under the IDs an earlier import gave them. */
function listedClasses(skip = 0): ListedClass[] {
  const courses = new Map(harbor.directory.courses.map((c) => [c.id, c.title]));
  return harbor.directory.offerings.slice(skip).map((o, i) => ({ offering: { id: `off_or-${i}`, sectionName: o.sectionName }, course: { title: courses.get(o.courseId)! }, students: 2 }));
}

/** The preview the fixture export gets there: every class added again, every existing one retained. */
const swapPreview = (listed: ListedClass[]): RosterPreview => ({
  canApply: true, issues: [], integrity: [], quarantined: [], linked: [],
  changes: {
    offerings: { ...empty, added: harbor.directory.offerings.map((o) => o.id), retained: listed.map((l) => l.offering.id) },
    principals: { ...empty, added: ["prn_x"], deactivated: ["prn_or-x"] },
  },
});

function fakeRosteredDistrict(listed: ListedClass[]) {
  const posts: string[] = [];
  const packs: InstalledPack[] = [];
  const client: DistrictAdminClient = {
    get: async <T>(path: string) => {
      const answers: Record<string, unknown> = {
        "/api/admin/health": { districtId: "dst_harbor", directory: { schools: 2, terms: 1, offerings: listed.length, students: 6, staff: 3, activeEnrollments: 14 } },
        "/api/admin/authoring": { authority: { principal: "external:oneroster" }, trustedIssuers: [], schools: [], terms: [], courses: [], offerings: [], principals: [] },
        "/api/admin/offerings": listed,
        "/api/admin/marketplace/packs": [...packs],
      };
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return answers[path] as T;
    },
    post: async <T>(path: string, body: unknown) => {
      posts.push(path);
      if (path === "/api/admin/roster/preview") return swapPreview(listed) as T;
      if (path === "/api/admin/marketplace/packs") {
        packs.push(listingOf(body));
        return listingOf(body) as T;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { client, posts };
}

const run = (client: DistrictAdminClient, extra: { dryRun?: boolean; admitSubject?: string } = {}) => {
  const log: string[] = [];
  return seedDemoDistrict({ client, demo: harbor, dryRun: false, pack: DEMO_STARTER_PACK, saveBefore: async () => {}, log: (l) => void log.push(l), ...extra }).then((r) => ({ ...r, log }));
};

describe("a roster district already holding its fixture roster under other IDs", () => {
  it("is recognised only when every fixture class is listed and the preview would add the classes again", () => {
    expect(fixtureClassesListed(harbor, listedClasses())).toStrictEqual({ matched: 4, total: 4 });
    expect(rosteredUnderOtherIds(harbor, listedClasses(), swapPreview(listedClasses()))).toBe(true);
    expect(rosteredUnderOtherIds(harbor, listedClasses(1), swapPreview(listedClasses(1)))).toBe(false);
    expect(rosteredUnderOtherIds(harbor, listedClasses(), { ...swapPreview(listedClasses()), changes: { offerings: empty } })).toBe(false);
  });

  it("skips the roster and the admit, installs the pack, verifies, and a rerun installs nothing", async () => {
    const { client, posts } = fakeRosteredDistrict(listedClasses());
    const first = await run(client, { admitSubject: "adfd94dd-86a7-5838-b9a7-d1eb94227303" });
    expect(first.problems).toStrictEqual([]);
    expect(first.log).toContain("roster: already present (4 classes match the fixture); skipped");
    expect(first.log.some((l) => l.startsWith("admit: skipped;"))).toBe(true);
    expect(posts).toStrictEqual(["/api/admin/roster/preview", "/api/admin/marketplace/packs"]);

    const again = await run(client);
    expect(again.problems).toStrictEqual([]);
    expect(again.log.join("\n")).toMatch(/already installed/);
    expect(posts.filter((p) => p !== "/api/admin/roster/preview")).toStrictEqual(["/api/admin/marketplace/packs"]);
  });

  it("is still refused, writing nothing, when only some of the fixture's classes are there", async () => {
    const { client, posts } = fakeRosteredDistrict(listedClasses(1));
    const { problems, log } = await run(client);
    expect(problems).toContain("roster: it would deactivate 1 principals");
    expect(log.join("\n")).not.toMatch(/already present/);
    expect(posts).toStrictEqual(["/api/admin/roster/preview"]);
  });
});
