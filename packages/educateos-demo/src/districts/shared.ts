// What every demo district shares: who a visitor can be, the booted district the UIs talk to, and
// the in-page plumbing that stands in for sign-in and the network. Nothing here reaches the network.
import { createDistrictApiClient, type DistrictApiClient, type RouteResponse } from "@educateos/api-client";
import { catalogSeedRelease, type CatalogRelease } from "@educateos/catalog";
import type { DistrictDirectorySnapshot, VerifiedIdentity } from "@educateos/contracts";
import type { DemoGradebooks } from "../grades/types.ts";

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

/** The admin console's Roster sync screen, as a hash route: where the visitor runs a district's syncs. */
export const ROSTER_SYNC_ROUTE = "#/roster-sync";

/** A district's roster sync, for a district whose people arrive through one the visitor runs. */
export interface DemoRoster {
  /** The roster's provider, as the district's configuration names it. */
  provider: "clever";
  /** Whether a sync has brought the roster in, so its people can sign in and have work waiting. */
  synced(): boolean;
  /** Runs a sync now as the district's administrator, as the admin console's "sync now" would. */
  sync(): Promise<RosterSyncResult>;
  /**
   * Calls `listener` with what each sync did, however it was run (the admin console's Roster sync
   * screen or {@link sync}), once the district has applied it. Returns the unsubscribe.
   */
  onSync(listener: (result: RosterSyncResult) => void): () => void;
}

/** A booted, seeded demo district. */
export interface DemoDistrict {
  key: DistrictKey;
  /**
   * A client that sends `bearer` with each request: the persona's IdP subject in a district with no
   * sign-in, or a session its sign-in started (Cedar Valley's, see {@link DemoSessions}).
   * `onResponse` sees each request it sends and the district's answer, which is how the demo
   * notices a visitor finishing a step of a journey.
   */
  clientFor(bearer: string, onResponse?: ResponseListener): DistrictApiClient;
  /** The district's roster sync, when its people arrive through one the visitor runs. */
  roster?: DemoRoster;
  /** Where its teachers' approved grades go, when the demo passes them back to an LMS gradebook. */
  grades?: DemoGradebooks;
}

/** The base URL the UIs' clients address. It is never fetched: requests go to the in-page app. */
const DEMO_ORIGIN = "https://district.demo.educateos.invalid";

/** {@link DemoDistrict.clientFor} over `fetch`, the in-page app's handler. */
export const clientsOver = (fetch: (request: Request) => Promise<Response>) =>
  (bearer: string, onResponse?: ResponseListener): DistrictApiClient => createDistrictApiClient({
    baseUrl: DEMO_ORIGIN,
    token: bearer,
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
export const personaVerifier = (directory: DistrictDirectorySnapshot, subjectOf?: (request: Request) => string | undefined) => async (request: Request): Promise<VerifiedIdentity | undefined> => {
  const header = request.headers.get("authorization") ?? "";
  const subject = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : subjectOf?.(request);
  if (!subject) return undefined;
  return { issuer: directory.district.trustedIssuers[0]!, subject, credential: "person" };
};

/**
 * The sessions a district's sign-in starts, for a district whose requests carry one rather than a
 * bare subject. A session is an opaque bearer standing for the identity that signed in, and only
 * {@link DemoSessions.start} makes one, so a request naming someone's subject is refused.
 */
export interface DemoSessions {
  /** Starts a session for an identity the district's sign-in has verified, and returns its bearer. */
  start(identity: VerifiedIdentity): string;
}

/** {@link DemoSessions}, and the `verifyRequest` that accepts their bearers and nothing else. */
export function demoSessions(): DemoSessions & { verifyRequest: (request: Request) => Promise<VerifiedIdentity | undefined> } {
  const live = new Map<string, VerifiedIdentity>();
  return {
    start: (identity) => {
      const token = `ses_${crypto.randomUUID()}`;
      live.set(token, identity);
      return token;
    },
    verifyRequest: async (request) => {
      const header = request.headers.get("authorization") ?? "";
      return header.startsWith("Bearer ") ? live.get(header.slice("Bearer ".length)) : undefined;
    },
  };
}
