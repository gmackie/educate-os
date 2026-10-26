#!/usr/bin/env node

// The DISTRICT_CONFIG of a demo district deployed at `<slug>.educateos.io` (SCHO-210), printed
// minified on stdout so it can be piped straight into its ForgeGraph secret:
//
//   node packages/educateos-district-worker/scripts/demo-district-config.ts <slug> \
//     --admin-subject <Access user_uuid> |
//     FG_APP=educateos-<slug> forge secret set DISTRICT_CONFIG --stage production --stdin
//
// A whole fixture directory is over the 5 KB a Workers secret holds, so the seed is the district
// and the one principal who populates it: the fixture's district administrator, signed in by the
// operator's Access identity. Everyone else arrives through the district's connectors, or is
// created by an administrator. No service principal is seeded: the district's `/api` surfaces
// answer only people (`SURFACE_KINDS` in @educateos/district-app). The district trusts only the
// Access team: behind
// Access, every sign-in (Clever, Google or a one-time PIN) carries the team's issuer and the
// person's Access subject, never the vendor's.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DEMO_DISTRICTS, type DemoDistrict } from "@educateos/fixtures";

/** The Access team every demo district trusts. */
export const DEMO_ACCESS_ISSUER = "https://gmacko.cloudflareaccess.com";

/** Clever's issuer, which Clever SSO resolves sign-ins under by default (`cleverSso`, SCHO-203). */
export const CLEVER_ISSUER = "https://clever.com";

/** Who signs in to administer a demo district. */
export interface DemoDistrictAdmins {
  /** The operator's Access `sub` (`user_uuid` from `/cdn-cgi/access/get-identity`). */
  adminSubject: string;
}

/** A demo district's `DISTRICT_CONFIG`, as a `DistrictWorkerConfig` document. */
export function demoDistrictConfig(demo: DemoDistrict, admins: DemoDistrictAdmins): Record<string, unknown> {
  const { district, principals, roleAssignments } = demo.directory;
  const districtId = district.id;
  const adminGrant = roleAssignments.find((r) => r.role === "district-admin" && r.scope.level === "district");
  const admin = principals.find((p) => p.id === adminGrant?.principalId);
  if (!adminGrant || !admin) throw new Error(`${demo.slug} has no district administrator`);
  const identity = (subject: string) => ({ districtId, issuer: DEMO_ACCESS_ISSUER, subject });
  const grant = (principalId: string) => ({ principalId, role: "district-admin", scope: { level: "district", districtId }, source: "local-grant" });
  return {
    directory: {
      // The Access team first: a roster import links people under the first trusted issuer. A Clever
      // district also trusts Clever's issuer, so that `cleverSso` (SCHO-203) can be turned on later
      // without editing a directory that is only seeded once; until it is, every sign-in is Access's.
      district: { ...district, trustedIssuers: [DEMO_ACCESS_ISSUER, ...demo.profile.sso === "clever" ? [CLEVER_ISSUER] : []] },
      schools: [],
      terms: [],
      courses: [],
      offerings: [],
      principals: [{ ...admin, externalIdentities: [identity(admins.adminSubject)] }],
      enrollments: [],
      roleAssignments: [grant(admin.id)],
    },
    // A district with no roster builds its own classes; every other one is owned by its roster.
    ...demo.profile.roster === "local" ? { authority: "local" } : {},
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "admin-subject": { type: "string" } },
  });
  const demo = DEMO_DISTRICTS.find((d) => d.slug === positionals[0]);
  if (!demo || !values["admin-subject"]) {
    console.error(`usage: demo-district-config.ts <${DEMO_DISTRICTS.map((d) => d.slug).join("|")}> --admin-subject <uuid>`);
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(demoDistrictConfig(demo, { adminSubject: values["admin-subject"] })));
  }
}
