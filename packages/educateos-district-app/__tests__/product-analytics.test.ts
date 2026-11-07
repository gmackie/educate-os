// Product analytics (SCHO-350): a district administrator's audited switch, off by default, that
// only a deployment naming an analytics service can turn on; and what signed-in pages are told.
import { describe, expect, it } from "vitest";
import { readProductAnalyticsDeployment, type ProductAnalyticsDeployment } from "../src/index.ts";
import { bootDistrict, expectError, NF } from "./support.ts";

const DATAFLARE: ProductAnalyticsDeployment = {
  host: "https://glass-educateos-district.dataflare-district.workers.dev",
  project: "educateos-district",
};
const GUARDIAN = "prn_nf-guardian-rosa";

describe("PRODUCT_ANALYTICS", () => {
  it("names a service only when set, as an https origin and a project", () => {
    expect(readProductAnalyticsDeployment(undefined)).toBeUndefined();
    expect(readProductAnalyticsDeployment("  ")).toBeUndefined();
    expect(readProductAnalyticsDeployment(JSON.stringify(DATAFLARE))).toStrictEqual(DATAFLARE);
  });

  it("refuses anything else, naming the field but never the value", () => {
    expect(() => readProductAnalyticsDeployment("{not json")).toThrow("PRODUCT_ANALYTICS is not JSON");
    const invalid = [
      { ...DATAFLARE, host: "http://glass.example.workers.dev" },
      { ...DATAFLARE, host: "https://glass.example.workers.dev/e" },
      { ...DATAFLARE, project: "Not A Project" },
      { ...DATAFLARE, token: "secret-value" },
      { host: DATAFLARE.host },
    ];
    for (const value of invalid) {
      let message = "";
      try {
        readProductAnalyticsDeployment(JSON.stringify(value));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(value)).toMatch(/^PRODUCT_ANALYTICS is invalid at: /);
      expect(message).not.toContain("secret-value");
      expect(message).not.toContain("Not A Project");
    }
  });
});

describe("a deployment that names no analytics service", () => {
  it("keeps analytics off: administrators cannot turn it on, and every page is told it is off", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    expect(await district.ok(admin, "admin.productAnalytics")).toStrictEqual({ configured: false, enabled: false, changedAt: null, changedBy: null });
    expectError(await district.call(admin, "admin.setProductAnalytics", { body: { enabled: true } }), 409, "conflict");
    // A teacher is refused before learning whether the deployment names anything.
    expectError(await district.call(district.tokenFor(NF.rivera), "admin.setProductAnalytics", { body: { enabled: true } }), 403, "forbidden");
    // Turning it off always works, and changes nothing that was not already so.
    expect(await district.ok(admin, "admin.setProductAnalytics", { body: { enabled: false } })).toStrictEqual({ configured: false, enabled: false, changedAt: null, changedBy: null });
    expect((await district.stores.directory.load()).snapshot.district.productAnalytics).toBeUndefined();
    for (const principal of [NF.amara, NF.rivera, NF.admin, GUARDIAN]) {
      expect(await district.ok(district.tokenFor(principal), "me.productAnalytics"), principal).toStrictEqual({ enabled: false });
    }
  });
});

describe("a deployment that names an analytics service", () => {
  it("starts off, and is on for every signed-in page only after an administrator turns it on, audited", async () => {
    const district = await bootDistrict(undefined, { productAnalytics: DATAFLARE, now: () => new Date("2026-11-07T12:00:00.000Z") });
    const admin = district.tokenFor(NF.admin);
    expect(await district.ok(admin, "admin.productAnalytics")).toStrictEqual({ configured: true, enabled: false, changedAt: null, changedBy: null });
    expect(await district.ok(district.tokenFor(NF.amara), "me.productAnalytics")).toStrictEqual({ enabled: false });

    const on = await district.ok(admin, "admin.setProductAnalytics", { body: { enabled: true } });
    expect(on).toStrictEqual({ configured: true, enabled: true, changedAt: on.changedAt, changedBy: NF.admin });
    expect(on.changedAt).not.toBeNull();
    expect(await district.ok(admin, "admin.productAnalytics")).toStrictEqual(on);
    const decisions = district.audit.events().filter((e) => e.action === "update" && e.resourceKind === "district");
    expect(decisions.map((e) => [e.principalId, e.effect])).toStrictEqual([[NF.admin, "allow"]]);

    // Students, staff and guardians alike learn only where to send events, never who decided.
    for (const principal of [NF.amara, NF.rivera, NF.admin, GUARDIAN]) {
      expect(await district.ok(district.tokenFor(principal), "me.productAnalytics"), principal).toStrictEqual({ enabled: true, ...DATAFLARE });
    }
    expectError(await district.call(undefined, "me.productAnalytics"), 401, "unauthenticated");

    const off = await district.ok(admin, "admin.setProductAnalytics", { body: { enabled: false } });
    expect(off).toMatchObject({ configured: true, enabled: false, changedBy: NF.admin });
    expect(await district.ok(district.tokenFor(NF.amara), "me.productAnalytics")).toStrictEqual({ enabled: false });
  });

  it("is an administrator's decision only", async () => {
    const district = await bootDistrict(undefined, { productAnalytics: DATAFLARE });
    // Staff who are not district administrators reach the admin surface and are refused there.
    for (const principal of [NF.rivera, NF.morgan]) {
      const token = district.tokenFor(principal);
      expectError(await district.call(token, "admin.setProductAnalytics", { body: { enabled: true } }), 403, "forbidden");
      expectError(await district.call(token, "admin.productAnalytics"), 403, "forbidden");
    }
    // Students and guardians do not reach the admin surface at all.
    for (const principal of [NF.amara, GUARDIAN]) {
      const status = (await district.call(district.tokenFor(principal), "admin.setProductAnalytics", { body: { enabled: true } })).status;
      expect([403, 404], principal).toContain(status);
    }
    expectError(await district.call(district.tokenFor(NF.admin), "admin.setProductAnalytics", { body: { enabled: true, host: "https://elsewhere.example" } as never }), 400, "validation-failed");
    expect((await district.stores.directory.load()).snapshot.district.productAnalytics).toBeUndefined();
  });
});
