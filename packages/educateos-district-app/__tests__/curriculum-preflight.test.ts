// A curriculum-wide quality report is NOT evidence of educational efficacy,
// legal publishing rights, accessibility certification, or permission to install.
// It must never write classroom state or reveal student records.
import { describe, expect, it } from "vitest";
import { SigningIdentity } from "@educateos/fleet";
import { PublisherTrust } from "../src/index.ts";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const TRUST = PublisherTrust.parse({ localDomains: [], publishers: [publisher] });
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" } as const;
const params = { offeringId: NF.eng9 };

async function setup(standards: readonly string[] = ["ccss-ela", "ccss-math"]) {
  const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST, standards });
  const admin = district.tokenFor(NF.admin);
  await district.ok(admin, "admin.importCourseBundle", { body: structuredClone(bundle) as never });
  return { district, teacher: district.tokenFor(NF.rivera), admin };
}

describe("curriculum-wide read-only OCS preflight", () => {
  it("reports integrity, reviewer-only unknowns, and restricted teacher notes without changing a classroom", async () => {
    const { district, teacher } = await setup();
    const before = await district.ok(teacher, "teacher.listModules", { params });
    const installsBefore = await district.stores.courseLibrary.loadInstalls(params.offeringId);
    const report = await district.ok(teacher, "teacher.previewCurriculumPreflight", { params, body: COURSE });
    expect(report).toMatchObject({ ...COURSE, readOnly: true, publicationApproved: false, summary: {
      passed: expect.any(Number), attention: expect.any(Number), notVerified: expect.any(Number),
    } });
    expect(report.checks).toHaveLength(10);
    expect(report.checks.find((c) => c.id === "package-integrity")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "copyright-rights")?.status).toBe("not-verified");
    expect(report.checks.find((c) => c.id === "accessibility")?.status).toBe("not-verified");
    expect(report.checks.find((c) => c.id === "educational-effectiveness")?.status).toBe("not-verified");
    expect(report.checks.find((c) => c.id === "instructor-material")).toMatchObject({ status: "attention" });
    expect(report.checks.find((c) => c.id === "publisher-trust")).toMatchObject({ status: "not-verified" });
    expect(report.summary.passed + report.summary.attention + report.summary.notVerified).toBe(10);
    expect(await district.ok(teacher, "teacher.listModules", { params })).toStrictEqual(before);
    expect(await district.stores.courseLibrary.loadInstalls(params.offeringId)).toStrictEqual(installsBefore);
    expect(JSON.stringify(report)).not.toContain("Amara");
  });

  it("reports unapproved standards and refuses students and untrusted publisher copies", async () => {
    const { district, teacher } = await setup([]);
    const report = await district.ok(teacher, "teacher.previewCurriculumPreflight", { params, body: COURSE });
    expect(report.checks.find((c) => c.id === "standards")?.status).toBe("attention");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.previewCurriculumPreflight", { params, body: COURSE }), 403, "forbidden");
    // Prevent metadata existence leaks before checking the teacher's offering access.
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.previewCurriculumPreflight", {
      params, body: { ...COURSE, version: "9.9.9" },
    }), 403, "forbidden");
    expectError(await district.call(teacher, "teacher.previewCurriculumPreflight", {
      params, body: { ...COURSE, version: "9.9.9" },
    }), 404, "not-found");
    // A different key for the publisher cannot import the same signed bundle.
    const unknown = await SigningIdentity.generate();
    const other = await bootDistrict(undefined, { courseLibraryTrust: {
      localDomains: [], publishers: [{
        domain: "educateos.io",
        keys: [{ keyId: unknown.keyId, publicKey: unknown.publicKey }],
      }],
    } });
    expectError(await other.call(other.tokenFor(NF.admin), "admin.importCourseBundle", {
      body: structuredClone(bundle) as never,
    }), 401, "unauthenticated");
  });
});
