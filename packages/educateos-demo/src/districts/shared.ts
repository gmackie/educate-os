// What every demo district shares: who a visitor can be, the booted district the UIs talk to, and
// the in-page plumbing that stands in for sign-in and the network. Nothing here reaches the network.
import { createDistrictApiClient, type DistrictApiClient, type RouteResponse } from "@educateos/api-client";
import { catalogSeedRelease, type CatalogRelease } from "@educateos/catalog";
import type { DistrictDirectorySnapshot, VerifiedIdentity } from "@educateos/contracts";

/** The districts a visitor can open, as `?district=` names them. */
export type DistrictKey = "northfield" | "cedarvalley";

/** The four people a visitor can be. */
export type PersonaId = "student" | "teacher" | "guardian" | "admin";

/** Someone a visitor can be, and what they will see. */
export interface Persona {
  id: PersonaId;
  /** Their name in the district. */
  name: string;
  /** What they are, such as "Grade 9 student". */
  role: string;
  /** One line on what they can do here. */
  description: string;
  /** Their IdP subject, which is what the demo signs them in as. */
  subject: string;
  /** Whether they reach the district only through its roster sync, so they are unknown until it runs. */
  rostered?: true;
}

/** Sees each request a client sends and the district's answer. */
export type ResponseListener = (request: Request, response: Response) => void;

/** What running a roster sync did, as the district answers `admin.runRosterSync`. */
export type RosterSyncResult = RouteResponse<"admin.runRosterSync">;

/** A district's roster sync, for a district whose people arrive through one the visitor runs. */
export interface DemoRoster {
  /** The roster's provider, as the district's configuration names it. */
  provider: "clever";
  /** Whether a sync has brought the roster in, so its people can sign in and have work waiting. */
  synced(): boolean;
  /** Runs a sync now as the district's administrator, as the admin console's "sync now" would. */
  sync(): Promise<RosterSyncResult>;
}

/** A booted, seeded demo district. */
export interface DemoDistrict {
  key: DistrictKey;
  /**
   * A client signed in as `subject`. `onResponse` sees each request it sends and the district's
   * answer, which is how the demo notices a visitor finishing a step of a journey.
   */
  clientFor(subject: string, onResponse?: ResponseListener): DistrictApiClient;
  /** The district's roster sync, when its people arrive through one the visitor runs. */
  roster?: DemoRoster;
}

/** The base URL the UIs' clients address. It is never fetched: requests go to the in-page app. */
const DEMO_ORIGIN = "https://district.demo.educateos.invalid";

/** {@link DemoDistrict.clientFor} over `fetch`, the in-page app's handler. */
export const clientsOver = (fetch: (request: Request) => Promise<Response>) =>
  (subject: string, onResponse?: ResponseListener): DistrictApiClient => createDistrictApiClient({
    baseUrl: DEMO_ORIGIN,
    token: subject,
    fetch: async (request) => {
      const response = await fetch(request);
      onResponse?.(request, response);
      return response;
    },
  });

const seedReleases = new Map<string, Promise<CatalogRelease>>();

/**
 * The catalog's own release of a framework, built once per page. Building one takes seconds, and
 * the district's default verifier rebuilds it on every install, which the demo, booting a fresh
 * district on every reset, cannot afford; this verifies the same thing, the seed's digest.
 */
export function seedRelease(key: string): Promise<CatalogRelease> {
  let release = seedReleases.get(key);
  if (release === undefined) {
    release = catalogSeedRelease(key);
    seedReleases.set(key, release);
  }
  return release;
}

/** A `verifyCatalogRelease` that accepts exactly the catalog's seed releases. */
export const verifySeedRelease = async (release: CatalogRelease): Promise<boolean> => {
  const seed = await seedRelease(release.frameworkKey);
  return seed.version === release.version && seed.contentDigest === release.contentDigest;
};

/**
 * The demo has no sign-in: a request's bearer is the IdP subject of the persona the visitor
 * picked, and this verifier takes it as that person's verified identity at the district's issuer.
 * Resolving it to a principal is still the district's own resolver's job, so a guardian who has not
 * yet been approved is refused exactly as they would be anywhere.
 */
export const personaVerifier = (directory: DistrictDirectorySnapshot) => async (request: Request): Promise<VerifiedIdentity | undefined> => {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return undefined;
  return { issuer: directory.district.trustedIssuers[0]!, subject: header.slice("Bearer ".length), credential: "person" };
};
