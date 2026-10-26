// The URL layout of the public fakes: `<origin>/<slug>/<vendor>/…`, one base URL per fake a demo
// district's integration profile uses. Each fake serves its vendor's own paths below its base, so a
// client configured with the base works unchanged.
import { DEMO_DISTRICTS, type DemoDistrict, type DemoDistrictSlug } from "@educateos/fixtures";

/** The public origin, unless the `PUBLIC_ORIGIN` var names another. */
export const DEFAULT_PUBLIC_ORIGIN = "https://fakes.demo.educateos.io";

/**
 * The fakes a district can have, as their base URL's path below the district:
 * - `clever`: Clever SSO (OIDC) and the Clever Data API together, as at Clever, where the SSO
 *   userinfo and the Data API share api.clever.com. Paths under `/v3.0/` and `/v3.1/` are the Data
 *   API; everything else is the OIDC issuer.
 * - `classlink`, `google`: the ClassLink and Google OIDC issuers.
 * - `oneroster`: a OneRoster 1.2 REST server in ClassLink's OAuth2 profile.
 * - `classroom`: the Google Classroom API (its `/v1` is below the base).
 * - `lti/canvas`, `lti/schoology`: LTI 1.3 platforms.
 */
export const VENDORS = ["clever", "classlink", "google", "oneroster", "classroom", "lti/canvas", "lti/schoology"] as const;

/** A fake, by its path below the district. */
export type Vendor = (typeof VENDORS)[number];

/** The LTI platform flavours served. */
export type LtiFlavourName = "canvas" | "schoology";

/**
 * The fakes a demo district's profile calls for. A district on Google Classroom also gets Google
 * sign-in, whose access tokens Classroom accepts. Prairie keeps everything local and has none.
 */
export function vendorsOf(demo: DemoDistrict): Vendor[] {
  const { sso, roster, lms } = demo.profile;
  const classroom = roster === "google-classroom" || lms === "google-classroom";
  const wanted = new Set<Vendor>();
  if (sso === "clever" || roster === "clever") wanted.add("clever");
  if (sso === "classlink") wanted.add("classlink");
  if (sso === "google" || classroom) wanted.add("google");
  if (roster === "oneroster-rest" || roster === "oneroster-csv") wanted.add("oneroster");
  if (classroom) wanted.add("classroom");
  if (lms === "canvas-lti") wanted.add("lti/canvas");
  if (lms === "schoology-lti") wanted.add("lti/schoology");
  return VENDORS.filter((vendor) => wanted.has(vendor));
}

/** A demo district by slug, or undefined for anything else. */
export function districtOf(slug: string): DemoDistrict | undefined {
  return DEMO_DISTRICTS.find((d) => d.slug === slug);
}

/** A fake's base URL. */
export function baseUrlOf(origin: string, slug: DemoDistrictSlug, vendor: Vendor): string {
  return `${origin}/${slug}/${vendor}`;
}

/** Where a public request goes: its district and fake. */
export interface PublicTarget {
  readonly district: DemoDistrict;
  readonly vendor: Vendor;
}

/** The district and fake a public path names, or undefined when it names none the district has. */
export function publicTarget(pathname: string): PublicTarget | undefined {
  const [, slug, first, second] = pathname.split("/");
  const district = slug === undefined ? undefined : districtOf(slug);
  if (district === undefined || first === undefined) return undefined;
  const vendor = (first === "lti" ? `lti/${second ?? ""}` : first) as Vendor;
  return vendorsOf(district).includes(vendor) ? { district, vendor } : undefined;
}

/** The base URL of every fake of every district, for the index. Holds no credentials. */
export function publicIndex(origin: string): { districts: { slug: string; name: string; fakes: Partial<Record<Vendor, string>> }[] } {
  return {
    districts: DEMO_DISTRICTS.map((d) => ({
      slug: d.slug,
      name: d.directory.district.name,
      fakes: Object.fromEntries(vendorsOf(d).map((vendor) => [vendor, baseUrlOf(origin, d.slug, vendor)])),
    })),
  };
}
