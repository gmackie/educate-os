// SCHO-202: the demo districts' OneRoster seeds (`oneRosterSeed` in @educateos/fixtures), served
// over REST and synced by the unchanged client and importer, rebuild each district's directory.
import { DistrictDirectorySnapshot, checkDirectoryIntegrity, externalIdentityKey } from "@educateos/contracts";
import { demoDistrict, lakeshoreLargeRemoval, oneRosterSeed, type DemoDistrict, type OneRosterSeed } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import { CREDENTIALS, FakeOneRosterServer, ORIGIN, TOKEN_URL, type Collections } from "./fixtures/northfield-rest.ts";

const START = Date.parse("2026-10-20T15:00:00Z");

function serve(seed: OneRosterSeed): FakeOneRosterServer {
  const { origin: _, ...collections } = seed;
  return new FakeOneRosterServer({ ...JSON.parse(JSON.stringify(collections)), demographics: [] } as Collections);
}

async function sync(demo: DemoDistrict, server: FakeOneRosterServer, state?: oneroster.RosterSyncState) {
  const source = oneroster.restRosterSource(new oneroster.OneRosterRestClient({
    config: { baseUrl: ORIGIN, tokenUrl: TOKEN_URL, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 5 },
    credentials: CREDENTIALS,
    fetch: server.fetch,
    sleep: async () => {},
  }));
  const { directory } = demo;
  const empty: oneroster.RosterSyncState = {
    roster: {
      snapshot: DistrictDirectorySnapshot.parse({ district: directory.district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
      sources: oneroster.EMPTY_SOURCE_MAP,
    },
  };
  let now = START;
  return oneroster.runRosterSync({
    state: state ?? empty,
    source,
    mode: "complete",
    config: { issuer: directory.district.trustedIssuers[0]!, subject: { field: "username" } },
    runId: "run-1",
    clock: () => new Date((now += 1000)),
  });
}

/** Each enrollment as `(subject, role, status)`, which survives the importer deriving its own IDs. */
function enrollmentKeys(snapshot: DistrictDirectorySnapshot): string[] {
  const subject = new Map(snapshot.principals.map((p) => [p.id, p.externalIdentities[0]!.subject]));
  const title = new Map(snapshot.courses.map((c) => [c.id, c.title]));
  const course = new Map(snapshot.offerings.map((o) => [o.id, title.get(o.courseId)]));
  return snapshot.enrollments
    .map((e) => `${subject.get(e.principalId)}|${course.get(e.offeringId)}|${e.role === "student" ? "student" : "staff"}|${e.status}`)
    .toSorted();
}

describe.each(["riverbend", "lakeshore", "northfield"] as const)("%s's OneRoster seed", (slug) => {
  it("syncs over REST into the directory it was derived from", async () => {
    const demo = demoDistrict(slug);
    const result = await sync(demo, serve(oneRosterSeed(demo)));
    expect(result.run.outcome, JSON.stringify(result.preview?.issues)).toBe("succeeded");
    const imported = result.state.roster.snapshot;
    expect(checkDirectoryIntegrity(imported)).toEqual([]);

    // EducateOS v1 imports no guardians; everyone else arrives under the same identity and kind.
    const people = (s: DistrictDirectorySnapshot) =>
      s.principals.filter((p) => p.kind !== "guardian").map((p) => `${externalIdentityKey(p.externalIdentities[0]!)}|${p.kind}|${p.displayName}`).toSorted();
    expect(people(imported)).toEqual(people(demo.directory));
    expect(enrollmentKeys(imported)).toEqual(enrollmentKeys(demo.directory));
    expect(imported.schools.map((s) => s.name).toSorted()).toEqual(demo.directory.schools.map((s) => s.name).toSorted());
    expect(imported.courses.map((c) => `${c.title}|${c.subject}`).toSorted())
      .toEqual(demo.directory.courses.map((c) => `${c.title}|${c.subject}`).toSorted());
  });
});

describe("Lakeshore's large removal", () => {
  it("would deactivate eight of ten students if applied unchecked", async () => {
    const demo = demoDistrict("lakeshore");
    const first = await sync(demo, serve(oneRosterSeed(demo)));
    const second = await sync(demo, serve(lakeshoreLargeRemoval()), first.state);
    expect(second.run.outcome).toBe("succeeded");
    const students = second.state.roster.snapshot.principals.filter((p) => p.kind === "student");
    expect(students.filter((p) => p.status === "active").map((p) => p.displayName).toSorted()).toEqual(["Hana Ito", "Iker Ruiz"]);
    expect(students.filter((p) => p.status === "inactive")).toHaveLength(8);
  });
});
