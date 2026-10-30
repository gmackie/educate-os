// The public school manifest at `/.well-known/educateos.json` (ADR-0014, SCHO-259): what the phone,
// an admin edition and the educateos.io directory need to find and present a district from its
// origin alone. It is public, carries no personal data and needs no sign-in, so a deployment exempts
// the path from Access. Like district.ts this module imports nothing Workers-only.
//
// Its values come from the district's deployment configuration (`DISTRICT_CONFIG`) where they exist,
// and otherwise from the optional `SCHOOL_MANIFEST` var (a JSON document, `SchoolManifestSettings`).
// It reads the seed's district name, not the Durable Object's, so serving it wakes nothing.
import { z } from "zod";
import { readDistrictWorkerConfig, type DistrictWorkerConfig } from "./config.ts";

/** The manifest's path. */
export const SCHOOL_MANIFEST_PATH = "/.well-known/educateos.json";

/**
 * The device API versions (`/api/m/*`) this district speaks. Version 2 adds the pairing relay's
 * self-rooms and the `/connect-phone` page, so a phone can sign in without a computer (SCHO-261).
 */
export const MOBILE_API_VERSIONS = { min: 1, max: 2 } as const;

/** How long clients and caches may keep the manifest, in seconds. */
export const SCHOOL_MANIFEST_MAX_AGE = 300;

const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);
const Origin = HttpsUrl.refine((text) => new URL(text).origin === text, "expected an origin, such as https://learn.example.org");
const Accent = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a hex colour such as #2458ac");
const SignInMethod = z.strictObject({
  /** A stable identifier, such as `google`, `clever`, `classlink` or `pin`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** What a sign-in button says. */
  label: z.string().trim().min(1).max(60),
});

/** Version 1 of the manifest, as served. */
export const SchoolManifest = z.strictObject({
  v: z.literal(1),
  /** The district's display name. */
  name: z.string().min(1).max(200),
  /** The district's origin, where its LMS, `/ai` and `/api` are. */
  origin: Origin,
  brand: z.strictObject({
    /** An https URL of the district's logo, or `null` for EducateOS's own. */
    logo: HttpsUrl.nullable(),
    /** The district's accent colour, or `null` for EducateOS's own. */
    accent: Accent.nullable(),
  }),
  /** The sign-in methods the district's sign-in page offers, in order. Empty when not published. */
  signIn: z.array(SignInMethod).max(10),
  features: z.strictObject({
    /** Whether `/ai` serves the AI workspace. */
    ai: z.boolean(),
    /** Whether the district admits the EducateOS mobile app. */
    mobile: z.boolean(),
    /** Whether guardians have the family view. */
    family: z.boolean(),
  }),
  /** The range of device API versions the district speaks. */
  mobileApi: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
  /** The release the district runs, such as `r000042-ade9299`, or `null` when unknown. */
  release: z.string().min(1).max(100).nullable(),
});
/** Version 1 of the manifest, as served. */
export type SchoolManifest = z.infer<typeof SchoolManifest>;

/** `SCHOOL_MANIFEST`: what the deployment says that `DISTRICT_CONFIG` doesn't. Every field is optional. */
export const SchoolManifestSettings = z.strictObject({
  /** The district's public origin. Defaults to the origin the request was made to. */
  origin: Origin.optional(),
  logo: HttpsUrl.optional(),
  accent: Accent.optional(),
  /** Defaults to Clever when the district signs in through Clever, and Google when it trusts Google. */
  signIn: z.array(SignInMethod).max(10).optional(),
  features: z.strictObject({
    /** Defaults to false: a district's router says otherwise by serving `/ai`. */
    ai: z.boolean().optional(),
    /** Defaults to true. */
    mobile: z.boolean().optional(),
    /** Defaults to true. */
    family: z.boolean().optional(),
  }).optional(),
  /** The release the district runs. Defaults to the Worker's version tag, when the deploy set one. */
  release: z.string().min(1).max(100).optional(),
});
/** `SCHOOL_MANIFEST`: what the deployment says that `DISTRICT_CONFIG` doesn't. */
export type SchoolManifestSettings = z.infer<typeof SchoolManifestSettings>;

/** Parses `SCHOOL_MANIFEST`. The error names invalid fields only. */
export function readSchoolManifestSettings(text: string | undefined): SchoolManifestSettings {
  if (text === undefined || text.trim() === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("SCHOOL_MANIFEST is not JSON");
  }
  const parsed = SchoolManifestSettings.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new Error(`SCHOOL_MANIFEST is invalid at: ${fields.join(", ")}`);
  }
  return parsed.data;
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/** The sign-in methods a district's configuration implies, when the deployment names none. */
function impliedSignIn(config: DistrictWorkerConfig): SchoolManifest["signIn"] {
  const issuers = [...config.directory.district.trustedIssuers, ...config.additionalTrustedIssuers ?? []];
  const methods: SchoolManifest["signIn"] = [];
  if (issuers.includes(GOOGLE_ISSUER)) methods.push({ id: "google", label: "Google" });
  if (config.cleverSso !== undefined) methods.push({ id: "clever", label: "Clever" });
  return methods;
}

/** What the manifest is built from. */
export interface SchoolManifestInputs {
  /** `DISTRICT_CONFIG`. */
  districtConfig: string | undefined;
  /** `SCHOOL_MANIFEST`. */
  settings: string | undefined;
  /** The origin the request was made to. */
  requestOrigin: string;
  /** The Worker's version tag, if the deploy set one (`CF_VERSION_METADATA.tag`). */
  versionTag?: unknown;
}

/** Builds the manifest. Throws when either configuration is invalid. */
export function schoolManifest(inputs: SchoolManifestInputs): SchoolManifest {
  const config = readDistrictWorkerConfig(inputs.districtConfig);
  const settings = readSchoolManifestSettings(inputs.settings);
  const tag = typeof inputs.versionTag === "string" && inputs.versionTag !== "" ? inputs.versionTag : null;
  return SchoolManifest.parse({
    v: 1,
    name: config.directory.district.name,
    origin: settings.origin ?? inputs.requestOrigin,
    brand: { logo: settings.logo ?? null, accent: settings.accent ?? null },
    signIn: settings.signIn ?? impliedSignIn(config),
    features: {
      ai: settings.features?.ai ?? false,
      mobile: settings.features?.mobile ?? true,
      family: settings.features?.family ?? true,
    },
    mobileApi: { ...MOBILE_API_VERSIONS },
    release: settings.release ?? tag,
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
} as const;

/** Serves `/.well-known/educateos.json`: GET and HEAD, with a CORS preflight answer. */
export function serveSchoolManifest(request: Request, inputs: Omit<SchoolManifestInputs, "requestOrigin">): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...CORS, allow: "GET, HEAD, OPTIONS" } });
  }
  let manifest: SchoolManifest;
  try {
    manifest = schoolManifest({ ...inputs, requestOrigin: new URL(request.url).origin });
  } catch {
    // A misconfigured deployment fails closed, without saying how: the configuration is not public.
    return new Response("The school manifest is not available.", {
      status: 503,
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const body = request.method === "HEAD" ? null : JSON.stringify(manifest);
  return new Response(body, {
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${SCHOOL_MANIFEST_MAX_AGE}`,
      "x-content-type-options": "nosniff",
    },
  });
}
