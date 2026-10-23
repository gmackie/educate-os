// The district seed the schoolos.gmac.io production instance runs with, as its public example
// (deploy/schoolos-gmac-io/district-config.example.json). The deployed copy differs only in the
// administrator's Access subject, and is the district Worker's DISTRICT_CONFIG secret (see
// docs/schoolos/runbooks/production-instance.md). Synthetic: a co-op with no roster, whose one
// seeded principal builds everything else through the admin console.

import { describe, expect, it } from "vitest";
import { readDistrictWorkerConfig } from "../src/config.ts";
import demoConfig from "../../../deploy/schoolos-gmac-io/district-config.example.json";

const ISSUER = "https://gmacko.cloudflareaccess.com";
const text = JSON.stringify(demoConfig);
const config = readDistrictWorkerConfig(text);

describe("schoolos.gmac.io demo district seed", () => {
  it("fits in one Workers secret", () => {
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(5000);
  });

  it("is a local co-op that trusts the instance's Access team", () => {
    expect(config.authority).toBe("local");
    expect(config.directory.district.trustedIssuers).toEqual([ISSUER]);
  });

  it("seeds one district administrator, matched by Access subject on the trusted issuer", () => {
    const [admin, ...others] = config.directory.principals;
    expect(others).toEqual([]);
    expect(admin?.kind).toBe("staff");
    expect(admin?.externalIdentities).toEqual([
      { districtId: "dst_gmacko-coop", issuer: ISSUER, subject: "00000000-0000-0000-0000-000000000000" },
    ]);
    expect(config.directory.roleAssignments).toEqual([expect.objectContaining({
      principalId: admin?.id, role: "district-admin", scope: { level: "district", districtId: "dst_gmacko-coop" },
    })]);
  });

  it("names no email address, since this repository is public", () => {
    expect(text).not.toMatch(/@/);
  });
});
