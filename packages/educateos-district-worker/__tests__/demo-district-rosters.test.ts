// The rosters @educateos/harness/demo-district gives the standalone roster demo districts (SCHO-326),
// through scripts/demo/seed-district.ts or the operator route: each fixture's OneRoster export,
// imported by the real importer into the directory that district's DISTRICT_CONFIG seeds, must add
// the fixture's classes and people without touching the seeded administrator, and importing it again
// must add nothing.

import { DEMO_DISTRICTS, type DemoDistrict } from "@educateos/fixtures";
import { oneroster } from "@educateos/integrations";
import { describe, expect, it } from "vitest";
import { AUTOMATION, isLocal, nonAdditive, rosterFiles, type RosterPreview } from "@educateos/harness/demo-district";
import { demoDistrictConfig } from "../scripts/demo-district-config.ts";
import { readDistrictWorkerConfig } from "../src/config.ts";

const ADMIN_SUBJECT = "00000000-0000-4000-8000-000000000001";
const AUTOMATION_SUBJECT = "adfd94dd-86a7-5838-b9a7-d1eb94227303";
const NOW = new Date("2026-11-03T12:00:00.000Z");

/** The directory a live demo district starts from, and how its roster import maps sign-ins (`ctx.rosterConfig()`). */
function liveSeed(demo: DemoDistrict) {
  const { directory } = readDistrictWorkerConfig(JSON.stringify(demoDistrictConfig(demo, { adminSubject: ADMIN_SUBJECT })));
  return { directory, config: { issuer: directory.district.trustedIssuers[0]!, subject: { field: "username" as const } } };
}

const asPreview = (preview: oneroster.OneRosterPreview) => preview as unknown as RosterPreview;

describe.each(DEMO_DISTRICTS.filter((d) => d.slug !== "northfield" && !isLocal(d)))("demo district $slug", (demo) => {
  it("imports its fixture's roster, adding only, and a rerun adds nothing", async () => {
    const { directory, config } = liveSeed(demo);
    const files = rosterFiles(demo);
    const applied = await oneroster.applyOneRosterImport({ current: { snapshot: directory, sources: oneroster.EMPTY_SOURCE_MAP }, files, config, now: NOW });
    expect(nonAdditive(asPreview(applied.preview))).toEqual([]);
    expect(applied.preview.quarantined).toEqual([]);
    if (!applied.applied) throw new Error("not applied");
    const next = applied.next.snapshot;
    expect(next.schools).toHaveLength(demo.directory.schools.length);
    expect(next.offerings).toHaveLength(demo.directory.offerings.length);
    expect(next.principals.filter((p) => p.kind === "student").length).toBe(demo.directory.principals.filter((p) => p.kind === "student").length);
    expect(next.enrollments.some((e) => e.status === "active" && e.role === "student")).toBe(true);
    // The seeded administrator is untouched, imported nowhere else, and still the only one.
    const admin = directory.principals[0]!;
    expect(next.principals.find((p) => p.id === admin.id)).toEqual(admin);
    expect(next.principals.filter((p) => p.displayName === admin.displayName)).toHaveLength(1);
    expect(next.roleAssignments.filter((r) => r.role === "district-admin").map((r) => r.principalId)).toEqual([admin.id]);

    const again = await oneroster.previewOneRosterImport({ current: applied.next, files, config, now: NOW });
    expect(nonAdditive(asPreview(again))).toEqual([]);
    expect(Object.values(again.changes).flatMap((c) => c.added)).toEqual([]);
  });
});

it("adds the automation person as staff signed in by the given subject, whom the import never makes an administrator", async () => {
  const demo = DEMO_DISTRICTS.find((d) => d.slug === "lakeshore")!;
  const { directory, config } = liveSeed(demo);
  const applied = await oneroster.applyOneRosterImport({
    current: { snapshot: directory, sources: oneroster.EMPTY_SOURCE_MAP },
    files: rosterFiles(demo, { admitSubject: AUTOMATION_SUBJECT }),
    config,
    now: NOW,
  });
  if (!applied.applied) throw new Error("not applied");
  const automation = applied.next.snapshot.principals.find((p) => p.displayName === AUTOMATION.displayName)!;
  expect(automation.kind).toBe("staff");
  expect(automation.externalIdentities.map((i) => i.subject)).toEqual([AUTOMATION_SUBJECT]);
  expect(applied.next.snapshot.roleAssignments.some((r) => r.principalId === automation.id && r.role === "district-admin")).toBe(false);
});
