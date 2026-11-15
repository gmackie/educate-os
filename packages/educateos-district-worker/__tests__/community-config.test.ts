// The seeds of community installations (ADR-0016), built by scripts/community-config.ts. Each is a
// district Worker's DISTRICT_CONFIG secret, so each must parse, fit in one secret, trust only the
// Access team, and turn home learning on with local authority.

import { describe, expect, it } from "vitest";
import { ACCESS_ISSUER, communityConfig } from "../scripts/community-config.ts";
import { COMMUNITY_DEPLOYMENTS } from "../../../scripts/production/communities.ts";
import { readDistrictWorkerConfig } from "../src/config.ts";

describe.each(COMMUNITY_DEPLOYMENTS)("community $slug", ({ slug }) => {
  const text = JSON.stringify(communityConfig({
    slug, name: "A family", timeZone: "America/Chicago", signup: "open",
    organizerSubject: "00000000-0000-0000-0000-000000000000", organizerName: "Organizer",
  }));
  const config = readDistrictWorkerConfig(text);

  it("fits in one Workers secret and parses as a district config", () => {
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(5000);
    expect(config.directory.district.id).toBe(`dst_${slug}`);
    expect(config.directory.district.trustedIssuers).toEqual([ACCESS_ISSUER]);
  });

  it("offers home learning with local authority and one organizer, and no school records", () => {
    expect(config.homeLearning).toEqual({ signup: "open" });
    expect(config.authority).toBe("local");
    expect(config.directory.schools).toEqual([]);
    expect(config.directory.principals.map((p) => p.kind)).toEqual(["staff"]);
    expect(config.directory.roleAssignments.map((r) => r.role)).toEqual(["district-admin"]);
  });
});

it("refuses a bad slug or time zone", () => {
  const base = { slug: "safranek", name: "F", timeZone: "America/Chicago", signup: "open" as const, organizerSubject: "x", organizerName: "O" };
  expect(() => communityConfig({ ...base, slug: "Bad Slug" })).toThrow();
  expect(() => communityConfig({ ...base, timeZone: "Mars/Olympus" })).toThrow();
});
