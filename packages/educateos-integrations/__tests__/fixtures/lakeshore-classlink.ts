// Lakeshore (ClassLink for SSO and OneRoster) served by the SCHO-201 provider fakes: a ClassLink
// Roster Server holding exactly the records `oneRosterSeed` derives from the district, and a
// ClassLink OIDC IdP whose people are the district's, each signing in with their directory subject
// as `preferred_username`.
//
// The people come from SCHO-203's `districtSeed` adapter, with one change: ClassLink asserts the
// directory subject as `preferred_username`, so each person's login ID is their subject rather than
// the adapter's ID-derived username.
import { demoDistrict, districtSeed, oneRosterSeed, type DemoDistrict } from "@educateos/fixtures";
import {
  OIDC_PRESETS,
  OidcFake,
  OneRosterFake,
  classlinkTenantId,
  routeFetch,
  type DistrictSeed,
  type OidcPreset,
} from "@educateos/provider-fakes";

/** When every scenario starts. */
export const START = Date.parse("2026-10-20T15:00:00Z");

/** Lakeshore's Roster Server. */
export const ROSTER_SERVER = "https://lakeshore-vn-v2.rosterserver.example";

/** The district's ClassLink sign-in app. Synthetic credentials. */
export const SSO_CLIENT = {
  clientId: "c1736927409822ls",
  clientSecret: "SYNTHETIC-CLASSLINK-SSO-SECRET-7c1e",
  redirectUris: ["https://lakeshore.educateos.example/auth/classlink/callback"],
} as const;

/** Another ClassLink app, whose tokens the district's app must not accept. Synthetic credentials. */
export const OTHER_APP = { clientId: "c9000000000001xx", clientSecret: "SYNTHETIC-OTHER-APP-SECRET-5d20", redirectUris: ["https://other.example/callback"] } as const;

/** The district's Roster Server OAuth client. Synthetic credentials. */
export const ROSTER_CLIENT = { clientId: "lakeshore-educateos", clientSecret: "SYNTHETIC-CLASSLINK-ROSTER-SECRET-91b4" } as const;

/** A demo district as a provider-fakes seed, each person signing in as their directory subject. */
export function providerSeed(demo: DemoDistrict): DistrictSeed {
  const seed = districtSeed(demo);
  const subjects = new Map(demo.directory.principals.map((p) => [p.id as string, p.externalIdentities[0]!.subject]));
  return { ...seed, people: seed.people.map((person) => ({ ...person, username: subjects.get(person.id)! })) };
}

/** The ClassLink preset under the district's own issuer, with ClassLink's real endpoints. */
export function lakeshorePreset(demo: DemoDistrict): OidcPreset {
  return { ...OIDC_PRESETS.classlink, issuer: demo.directory.district.trustedIssuers[0]! };
}

/** Lakeshore's ClassLink Roster Server and IdP, behind one fetch, on one clock. */
export function lakeshoreClassLink() {
  const demo = demoDistrict("lakeshore");
  const seed = providerSeed(demo);
  const clock = { ms: START };
  const now = () => clock.ms;
  const roster = new OneRosterFake({ seed, now, baseUrl: ROSTER_SERVER, clients: [ROSTER_CLIENT] });
  // Serve exactly the records the fixture derives, dropped enrollment included, instead of the
  // fake's own projection of the seed.
  const records = oneRosterSeed(demo, ROSTER_SERVER);
  for (const collection of ["orgs", "academicSessions", "courses", "classes", "users", "enrollments"] as const) {
    for (const record of roster.records(collection)) roster.purge(collection, record.sourcedId);
    for (const record of records[collection]) roster.upsert(collection, structuredClone(record) as never, { keepDate: true });
  }
  const idp = new OidcFake({ seed, preset: lakeshorePreset(demo), clients: [SSO_CLIENT, OTHER_APP], now });
  const fetch = routeFetch({ [new URL(ROSTER_SERVER).origin]: roster, ...Object.fromEntries(idp.origins.map((origin) => [origin, idp])) });
  return { demo, seed, clock, roster, idp, fetch, tenantId: classlinkTenantId(seed) };
}
