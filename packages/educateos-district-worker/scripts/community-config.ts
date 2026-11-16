#!/usr/bin/env node

// The DISTRICT_CONFIG of a community installation for home learning (ADR-0016), printed minified on
// stdout so it can be piped straight into its ForgeGraph secret:
//
//   node packages/educateos-district-worker/scripts/community-config.ts safranek \
//     --name "Safranek Family" --time-zone America/Chicago --signup open \
//     --organizer-subject <Access user_uuid> --organizer-name "EducateOS operations" --retention-days 730 |
//     FG_APP=educateos-safranek forge secret set DISTRICT_CONFIG --stage production --stdin
//
// The directory is the community and its one organizer, a district administrator signed in by the
// given Access identity. Families arrive through sign-up as guardians; an organizer never sees their
// practice. Local authority (no roster), home learning on, and the Access team as the only issuer.
// Read on the Durable Object's first start only, except `homeLearning`, read on every start.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** The Access team every owner-hosted installation trusts. */
export const ACCESS_ISSUER = "https://gmacko.cloudflareaccess.com";

/** What a community's config is made from. */
export interface CommunityConfigInput {
  slug: string;
  name: string;
  timeZone: string;
  signup: "open" | "approval" | "invite-only";
  organizerSubject: string;
  organizerName: string;
  /** Days practice is kept; unset keeps it until the family deletes it. */
  retentionDays?: number;
}

/** A community's `DISTRICT_CONFIG`, as a `DistrictWorkerConfig` document. */
export function communityConfig(input: CommunityConfigInput): Record<string, unknown> {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(input.slug)) throw new Error(`${input.slug} is not a community slug`);
  if (!Intl.supportedValuesOf("timeZone").includes(input.timeZone)) throw new Error(`${input.timeZone} is not a time zone`);
  const districtId = `dst_${input.slug}`;
  const organizerId = `prn_${input.slug}-organizer`;
  return {
    directory: {
      district: { id: districtId, name: input.name, timeZone: input.timeZone, trustedIssuers: [ACCESS_ISSUER] },
      schools: [],
      terms: [],
      courses: [],
      offerings: [],
      principals: [{
        id: organizerId, districtId, kind: "staff", status: "active", displayName: input.organizerName,
        externalIdentities: [{ districtId, issuer: ACCESS_ISSUER, subject: input.organizerSubject }],
      }],
      enrollments: [],
      roleAssignments: [{ principalId: organizerId, role: "district-admin", scope: { level: "district", districtId }, source: "local-grant" }],
    },
    authority: "local",
    homeLearning: { signup: input.signup, ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      "time-zone": { type: "string" },
      signup: { type: "string", default: "open" },
      "organizer-subject": { type: "string" },
      "organizer-name": { type: "string", default: "Community organizer" },
      "retention-days": { type: "string" },
    },
  });
  const signup = values.signup as CommunityConfigInput["signup"];
  if (positionals.length !== 1 || !values.name || !values["time-zone"] || !values["organizer-subject"] || !["open", "approval", "invite-only"].includes(signup)) {
    console.error("usage: community-config.ts <slug> --name <name> --time-zone <IANA zone> --organizer-subject <uuid> [--organizer-name <name>] [--signup open|approval|invite-only]");
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(communityConfig({
      slug: positionals[0]!, name: values.name, timeZone: values["time-zone"], signup,
      organizerSubject: values["organizer-subject"], organizerName: values["organizer-name"]!,
      ...(values["retention-days"] === undefined ? {} : { retentionDays: Number(values["retention-days"]) }),
    })));
  }
}
