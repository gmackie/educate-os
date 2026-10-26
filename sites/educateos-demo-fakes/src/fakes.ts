// One district's fakes, built from its fixture seed (`fakeSeed(demoDistrict(slug))`) with the
// credentials derived from the Worker secret, the signing keys its object stores, and the LTI tools
// registered with it. Nothing else is kept: the fakes' state lives in memory and starts again from
// the seed whenever the object does.
import { demoDistrict, fakeSeed } from "@educateos/fixtures";
import {
  CLASSROOM_SCOPES,
  CleverDataFake,
  GoogleClassroomFake,
  LtiPlatformFake,
  OIDC_PRESETS,
  OidcFake,
  OneRosterFake,
  PlatformKeyRing,
  ROSTER_CORE_READONLY,
  ROSTER_DEMOGRAPHICS_READONLY,
  ROSTER_READONLY,
  canvasFlavour,
  rebasePreset,
  schoologyFlavour,
  type DistrictSeed,
  type LtiFlavour,
  type LtiPrivacyLevel,
  type LtiTool,
  type OidcPresetName,
  type PlatformKey,
  type ProviderFake,
} from "@educateos/provider-fakes";
import type { DemoDistrictSlug } from "@educateos/fixtures";
import type { DistrictCredentials } from "./credentials.ts";
import { baseUrlOf, type LtiFlavourName, type Vendor } from "./layout.ts";

/** The header a district object puts the caller's IP in, for the Clever fake's per-client budget. */
export const CLIENT_HEADER = "x-demo-fakes-client";

/** The OIDC issuers, by the vendor that serves each. */
export type OidcVendor = Extract<OidcPresetName, Vendor>;

/** One district's fakes. Only those its profile uses are present. */
export interface DistrictFakes {
  readonly slug: DemoDistrictSlug;
  readonly origin: string;
  readonly vendors: readonly Vendor[];
  readonly credentials: DistrictCredentials;
  readonly redirectUris: readonly string[];
  readonly oidc: Partial<Record<OidcVendor, OidcFake>>;
  readonly cleverData?: CleverDataFake;
  readonly oneroster?: OneRosterFake;
  readonly classroom?: GoogleClassroomFake;
  readonly lti: Partial<Record<LtiFlavourName, LtiPlatformFake>>;
}

/** An LTI tool as stored, to be registered again when the district's fakes are rebuilt. */
export interface StoredTool {
  readonly clientId: string;
  readonly deploymentIds: readonly string[];
  readonly name: string;
  readonly initiateLoginUri: string;
  readonly redirectUris: readonly string[];
  readonly targetLinkUri: string;
  readonly jwksUri?: string;
  readonly scopes: readonly string[];
  readonly custom: Readonly<Record<string, string>>;
  readonly privacyLevel: LtiPrivacyLevel;
}

/** What building a district's fakes needs beyond its slug. */
export interface BuildInputs {
  readonly slug: DemoDistrictSlug;
  readonly origin: string;
  readonly vendors: readonly Vendor[];
  readonly credentials: DistrictCredentials;
  readonly redirectUris: readonly string[];
  /** The stored signing key of an issuer or platform, made and stored on first use. */
  readonly key: (name: string) => Promise<PlatformKey>;
  /** The LTI tools registered with a platform. */
  readonly tools: (flavour: LtiFlavourName) => Promise<readonly StoredTool[]>;
  /** How a platform fetches a tool's JWKS. */
  readonly fetch: typeof globalThis.fetch;
}

// A deployed fake records nothing: `requests` holds headers and bodies, client secrets included,
// and nothing reads it here.
const RECORD_NOTHING = { maxRecordedRequests: 0 } as const;

const seeds = new Map<DemoDistrictSlug, DistrictSeed>();

/** A district's seed, the same every time: `fakeSeed` of its fixture. */
export function seedOf(slug: DemoDistrictSlug): DistrictSeed {
  let seed = seeds.get(slug);
  if (seed === undefined) {
    seed = fakeSeed(demoDistrict(slug));
    seeds.set(slug, seed);
  }
  return seed;
}

function randomDigits(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => String(b % 10)).join("");
}

function randomHex(length: number): string {
  return [...crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

/**
 * A flavour whose new client and deployment IDs are random in the platform's own shape, rather than
 * counted from 1 as in tests: a deployed platform's tools are stored and registered again on every
 * rebuild, so a counter would hand a new tool an ID a stored one already holds.
 */
function deployedFlavour(flavour: LtiFlavour): LtiFlavour {
  if (flavour.name === "canvas") {
    return { ...flavour, clientId: () => `1${randomDigits(13)}`, deploymentId: (_seed, n) => `${n}:${randomHex(40)}` };
  }
  return { ...flavour, clientId: () => `7${randomDigits(9)}`, deploymentId: (seed, n) => `${flavour.deploymentId(seed, n).split("-")[0]}-${randomDigits(10)}` };
}

/** A stored tool as the platform registers it. */
function registerStored(platform: LtiPlatformFake, tool: StoredTool): void {
  const [first, ...more] = tool.deploymentIds;
  platform.registerTool({
    clientId: tool.clientId,
    ...(first === undefined ? {} : { deploymentId: first }),
    name: tool.name,
    initiateLoginUri: tool.initiateLoginUri,
    redirectUris: tool.redirectUris,
    targetLinkUri: tool.targetLinkUri,
    ...(tool.jwksUri === undefined ? {} : { jwksUri: tool.jwksUri }),
    scopes: tool.scopes,
    custom: tool.custom,
    privacyLevel: tool.privacyLevel,
  });
  for (const id of more) platform.addDeployment(tool.clientId, id);
}

/** A registered tool, as stored. */
export function storedTool(tool: LtiTool): StoredTool {
  return {
    clientId: tool.clientId,
    deploymentIds: [...tool.deploymentIds],
    name: tool.name,
    initiateLoginUri: tool.initiateLoginUri,
    redirectUris: [...tool.redirectUris],
    targetLinkUri: tool.targetLinkUri,
    ...(tool.jwksUri === undefined ? {} : { jwksUri: tool.jwksUri }),
    scopes: [...tool.scopes],
    custom: { ...tool.custom },
    privacyLevel: tool.privacyLevel,
  };
}

/** Builds a district's fakes. */
export async function buildFakes(inputs: BuildInputs): Promise<DistrictFakes> {
  const { slug, origin, vendors, credentials, redirectUris } = inputs;
  const seed = seedOf(slug);
  const base = (vendor: Vendor) => baseUrlOf(origin, slug, vendor);
  const oidc: Partial<Record<OidcVendor, OidcFake>> = {};
  const issuer = async (vendor: OidcVendor, client: { clientId: string; clientSecret: string }, acceptedScopes?: readonly string[]) => {
    const preset = rebasePreset(OIDC_PRESETS[vendor], base(vendor));
    oidc[vendor] = new OidcFake({
      ...RECORD_NOTHING,
      seed,
      preset: acceptedScopes === undefined ? preset : { ...preset, acceptedScopes },
      clients: [{ ...client, redirectUris: [...redirectUris] }],
      signingKey: await inputs.key(`oidc:${vendor}`),
    });
  };
  if (credentials.clever !== undefined) await issuer("clever", credentials.clever.oidc);
  if (credentials.classlink !== undefined) await issuer("classlink", credentials.classlink.oidc);
  // Google sign-in grants the Classroom scopes too, as Google does, so its tokens reach Classroom.
  if (credentials.google !== undefined) await issuer("google", credentials.google.oidc, Object.values(CLASSROOM_SCOPES));

  const cleverData = credentials.clever === undefined ? undefined : new CleverDataFake({
    ...RECORD_NOTHING,
    seed,
    baseUrl: base("clever"),
    districtTokens: [credentials.clever.districtToken],
    // Each caller gets its own budget: the token is shared by everyone the district gives it to.
    clientKey: (request) => request.headers.get(CLIENT_HEADER) ?? "",
  });
  const oneroster = credentials.oneroster === undefined ? undefined : new OneRosterFake({
    ...RECORD_NOTHING,
    seed,
    baseUrl: base("oneroster"),
    clients: [{ ...credentials.oneroster, scopes: [ROSTER_CORE_READONLY, ROSTER_READONLY, ROSTER_DEMOGRAPHICS_READONLY] }],
  });
  const google = oidc.google;
  const classroom = !vendors.includes("classroom") ? undefined : new GoogleClassroomFake({
    ...RECORD_NOTHING,
    seed,
    baseUrl: `${base("classroom")}/v1`,
    resolveToken: (token) => {
      const grant = google?.accessGrant(token);
      return grant === undefined ? undefined : { userId: grant.personId, scopes: grant.scopes };
    },
  });

  const lti: Partial<Record<LtiFlavourName, LtiPlatformFake>> = {};
  for (const name of ["canvas", "schoology"] as const) {
    if (!vendors.includes(`lti/${name}`)) continue;
    const at = base(`lti/${name}`);
    const flavour = name === "canvas" ? canvasFlavour({ issuer: at, sso: at, domain: at }) : schoologyFlavour({ issuer: at, service: at });
    const platform = await LtiPlatformFake.create({
      ...RECORD_NOTHING,
      flavour: deployedFlavour(flavour),
      seed,
      keys: new PlatformKeyRing(await inputs.key(`lti:${name}`)),
      fetch: inputs.fetch,
    });
    for (const tool of await inputs.tools(name)) registerStored(platform, tool);
    lti[name] = platform;
  }
  return { slug, origin, vendors, credentials, redirectUris, oidc, ...(cleverData === undefined ? {} : { cleverData }), ...(oneroster === undefined ? {} : { oneroster }), ...(classroom === undefined ? {} : { classroom }), lti };
}

/** Every fake a vendor's base serves. */
export function fakesOf(fakes: DistrictFakes, vendor: Vendor): ProviderFake[] {
  switch (vendor) {
    case "clever":
      return [fakes.oidc.clever, fakes.cleverData].filter((f) => f !== undefined);
    case "classlink":
    case "google":
      return [fakes.oidc[vendor]].filter((f) => f !== undefined);
    case "oneroster":
      return [fakes.oneroster].filter((f) => f !== undefined);
    case "classroom":
      return [fakes.classroom].filter((f) => f !== undefined);
    case "lti/canvas":
      return [fakes.lti.canvas].filter((f) => f !== undefined);
    case "lti/schoology":
      return [fakes.lti.schoology].filter((f) => f !== undefined);
  }
}

/**
 * The fake that serves `pathname` below a vendor's base. Clever's base serves two: the Data API
 * under `/v3.0/` and `/v3.1/`, and the OIDC issuer for everything else.
 */
export function fakeFor(fakes: DistrictFakes, vendor: Vendor, pathname: string): ProviderFake | undefined {
  if (vendor === "clever") {
    const below = pathname.slice(new URL(baseUrlOf(fakes.origin, fakes.slug, "clever")).pathname.length);
    return /^\/v3\.[01](\/|$)/.test(below) ? fakes.cleverData : fakes.oidc.clever;
  }
  return fakesOf(fakes, vendor)[0];
}
