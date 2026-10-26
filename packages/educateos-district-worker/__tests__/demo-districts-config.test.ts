// The seeds of the demo districts deployed at `<slug>.educateos.io` (SCHO-210), built by
// scripts/demo-district-config.ts from @educateos/fixtures. Each is a district Worker's
// DISTRICT_CONFIG secret, so each must parse, fit in one secret, and trust only the Access team.

import { DEMO_DISTRICTS } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { CLEVER_ISSUER, DEMO_ACCESS_ISSUER, demoDistrictConfig } from "../scripts/demo-district-config.ts";
import { readDistrictWorkerConfig } from "../src/config.ts";

const ADMIN_SUBJECT = "00000000-0000-0000-0000-000000000000";

describe.each(DEMO_DISTRICTS.filter((d) => d.slug !== "northfield"))("demo district $slug", (demo) => {
  const text = JSON.stringify(demoDistrictConfig(demo, { adminSubject: ADMIN_SUBJECT }));
  const config = readDistrictWorkerConfig(text);

  it("fits in one Workers secret", () => {
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(5000);
  });

  it("is the fixture's district, trusting the Access team first, and Clever's issuer in a Clever district", () => {
    expect(config.directory.district.id).toBe(demo.directory.district.id);
    expect(config.directory.district.trustedIssuers)
      .toEqual(demo.profile.sso === "clever" ? [DEMO_ACCESS_ISSUER, CLEVER_ISSUER] : [DEMO_ACCESS_ISSUER]);
    // Clever SSO stays off until the district can sign people in through Clever alone.
    expect(config.cleverSso).toBeUndefined();
    expect(config.authority).toBe(demo.profile.roster === "local" ? "local" : undefined);
  });

  it("seeds only the fixture's district administrator, a person, matched by Access subject", () => {
    const [admin, ...others] = config.directory.principals;
    expect(others).toEqual([]);
    expect(admin?.id).toBe(demo.directory.roleAssignments.find((r) => r.role === "district-admin")?.principalId);
    // The district's /api surfaces answer people only, so the administrator must be staff.
    expect(admin?.kind).toBe("staff");
    expect(admin?.externalIdentities.map((i) => [i.issuer, i.subject])).toEqual([[DEMO_ACCESS_ISSUER, ADMIN_SUBJECT]]);
    expect(config.directory.roleAssignments.map((r) => [r.principalId, r.role, r.scope.level]))
      .toEqual([[admin?.id, "district-admin", "district"]]);
  });
});
