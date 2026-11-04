// SCHO-331: the reference course, imported from its committed signed bundle into a harness
// Northfield whose showcase is seeded, installs into the Grade 1 Reading showcase class as the
// course was written to: units 1 and 2 are the showcase's own modules and are skipped, untouched;
// units 3 to 6 arrive as draft modules with their activities assigned.
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { PublisherTrust } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrictApp, bootHarness, seedShowcase, showcaseResourceUrl } from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" };
/** The Grade 1 Reading showcase class, whose two modules are the reference course's units 1 and 2. */
const G1_READING = NORTHFIELD_SHOWCASE.courses.find((course) => course.offeringId === "off_nf-g1read-fall-r7")!;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;

describe("the reference course in the Northfield showcase", () => {
  let actAs: (id: string) => Promise<DistrictApiClient>;
  beforeAll(async () => {
    const [entry] = await bootHarness([NORTHFIELD]);
    const app = await bootDistrictApp(entry!, undefined, { courseLibraryTrust: PublisherTrust.parse({ localDomains: [], publishers: [publisher] }) });
    actAs = async (id) => {
      const subject = NORTHFIELD.principals.find((p) => p.id === id)!.externalIdentities[0]!.subject;
      return createDistrictApiClient({ baseUrl: "http://district.harness", token: await entry!.identity.issueToken(subject), fetch: (request) => app.fetch(request) });
    };
    await seedShowcase({
      showcase: NORTHFIELD_SHOWCASE,
      adminId: ADMIN,
      actAs,
      guardians: NORTHFIELD_GUARDIANS,
      guardianNames: Object.fromEntries(NORTHFIELD_GUARDIANS.map((g) => [g.guardianPrincipalId, name(g.guardianPrincipalId)])),
      resourceUrl: showcaseResourceUrl,
    });
  }, 120_000);

  it("imports the bundle, offers it to the Grade 1 Reading teacher, and installs only the units the class lacks", async () => {
    const admin = await actAs(ADMIN);
    const imported = await admin.call("admin.importCourseBundle", { body: bundle as never });
    expect(imported.publisher).toStrictEqual({ domain: "educateos.io", signed: true });

    const teacher = await actAs(G1_READING.teacherId);
    const params = { offeringId: G1_READING.offeringId };
    const [offered] = await teacher.call("teacher.libraryCourses", { params });
    expect(offered).toMatchObject({ ...COURSE, matchesClass: true });
    const before = (await teacher.call("teacher.listModules", { params })).outline;
    const assignedBefore = (await teacher.call("teacher.listAssignments", { params })).length;

    const preview = await teacher.call("teacher.previewCourseInstall", { params, body: COURSE });
    expect(preview.problems).toStrictEqual([]);
    expect(preview.units.map((unit) => unit.status)).toStrictEqual(["exists", "exists", "new", "new", "new", "new"]);

    const installed = await teacher.call("teacher.installCourse", { params, body: COURSE });
    expect(installed.done).toBe(true);
    expect(installed.units.map((unit) => unit.status)).toStrictEqual(["exists", "exists", "installed", "installed", "installed", "installed"]);

    const after = (await teacher.call("teacher.listModules", { params })).outline;
    // The showcase's modules are exactly as they were; the course's units follow them, as drafts.
    expect(after.modules.slice(0, before.modules.length)).toStrictEqual(before.modules);
    const added = after.modules.slice(before.modules.length);
    expect(added.map((module) => module.title)).toStrictEqual(installed.units.slice(2).map((unit) => unit.title));
    expect(added.every((module) => !module.published && module.source?.kind === "course")).toBe(true);
    const activities = installed.units.slice(2).flatMap((unit) => unit.items.filter((item) => item.kind === "activity"));
    expect((await teacher.call("teacher.listAssignments", { params })).length).toBe(assignedBefore + activities.length);
  });
});
