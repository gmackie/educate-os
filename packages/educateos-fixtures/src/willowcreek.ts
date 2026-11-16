import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { person } from "./builders.ts";

const D = "dst_willowcreek";
const IDP = "https://idp.willowcreek.example";

/**
 * Willow Creek Learning Community: a dedicated community installation for home learning
 * (ADR-0016). It has no schools, terms, courses or classes: families sign up, and each family's
 * adult is a guardian principal whose authority covers only their own family's home learning. One
 * community organizer administers the installation. Every person here is invented.
 *
 * - Jordan Rivers runs a family with two children (set up in tests and the harness).
 * - Priya Nair runs another family; she must never see the Rivers family's children.
 * - Sam Ortiz has signed in and been admitted, but hasn't set up a family yet.
 */
export const WILLOWCREEK = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Willow Creek Learning Community (synthetic)",
    timeZone: "America/Chicago",
    trustedIssuers: [IDP],
  },
  schools: [],
  terms: [],
  courses: [],
  offerings: [],
  principals: [
    person(D, IDP, "prn_wc-organizer", "staff", "Dana Okafor", "wc-organizer", "dana@willowcreek.example"),
    person(D, IDP, "prn_wc-parent-rivers", "guardian", "Jordan Rivers", "wc-parent-rivers", "jordan@family.example"),
    person(D, IDP, "prn_wc-parent-nair", "guardian", "Priya Nair", "wc-parent-nair", "priya@family.example"),
    person(D, IDP, "prn_wc-parent-ortiz", "guardian", "Sam Ortiz", "wc-parent-ortiz", "sam@family.example"),
  ],
  enrollments: [],
  roleAssignments: [
    { principalId: "prn_wc-organizer", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
  ],
});
