// A browser's sign-in rides along on every request a page makes, so the district refuses a change
// any other site's page sends (SCHO-306), bodiless ones included.
import { describe, expect, it } from "vitest";
import { bootDistrict, expectError, NF } from "./support.ts";

const CROSS_SITE = [
  { origin: "https://evil.example" },
  { origin: "null" },
  { origin: "https://other-tenant.educateos.example" },
  { "sec-fetch-site": "cross-site" },
  { "sec-fetch-site": "same-site" },
];

describe("cross-site requests (SCHO-306)", () => {
  it.each(CROSS_SITE)("refuses a bodiless administrator change sent from another site: %o", async (headers) => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    const result = await district.call(admin, "admin.grantDistrictAdmin", { params: { principalId: NF.rivera }, body: {} }, headers);
    expectError(result, 403, "forbidden");
    expect((await district.ok(admin, "admin.authoring")).principals.find((p) => p.id === NF.rivera)).toMatchObject({ districtAdmin: false });
    // The same request from the district's own page goes through.
    expect((await district.call(admin, "admin.grantDistrictAdmin", { params: { principalId: NF.rivera }, body: {} }, { origin: "https://district.example" })).status).toBe(200);
  });

  it("accepts a change from the district's own pages, or from a client that is no browser", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const topic = { params: { offeringId: NF.eng9 }, body: { title: "Debate", prompt: "Go." } };
    for (const headers of [{ origin: "https://district.example", "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
      expect((await district.call(rivera, "teacher.createTopic", topic, headers)).status).toBe(201);
    }
  });

  it("still answers reads from anywhere: the same-origin policy keeps their answers from the other site", async () => {
    const district = await bootDistrict();
    const result = await district.call(district.tokenFor(NF.amara), "student.listOfferings", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(result.status).toBe(200);
  });
});
