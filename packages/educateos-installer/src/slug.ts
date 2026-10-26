// District slugs: the label of a district's managed default hostname, `<slug>.educateos.io`
// (ADR-0013 decision 4, SCHO-207). The hostname is routing only. It is an alias of the district's
// own hostname, never its identity, so a slug can be released without moving any data.
import { z } from "zod";

/** The zone managed default hostnames are on. */
export const MANAGED_ZONE = "educateos.io";

/**
 * Labels no district may take: names educateos.io serves or may serve itself, names mail and
 * certificate authorities treat as administrative, and names that would read as official.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // educateos.io's own services
  "www", "api", "app", "apps", "admin", "dashboard", "dash", "console", "portal", "account",
  "accounts", "billing", "pay", "checkout", "store", "shop", "market", "marketplace", "install",
  "installer", "releases", "release", "download", "downloads", "registry", "fleet", "root",
  "demo", "demos", "docs", "doc", "help", "support", "status", "blog", "news", "community",
  "forum", "learn", "about", "legal", "privacy", "terms", "security", "trust", "careers", "press",
  // identity and sign-in
  "auth", "login", "logout", "signin", "signup", "register", "sso", "oauth", "oidc", "saml", "id",
  "identity", "access",
  // mail and DNS administration
  "mail", "email", "smtp", "imap", "pop", "pop3", "mx", "webmail", "autodiscover", "autoconfig",
  "postmaster", "hostmaster", "webmaster", "abuse", "noreply", "no-reply", "ns", "ns1", "ns2",
  "dns", "ftp", "sftp",
  // infrastructure and environments
  "cdn", "static", "assets", "media", "files", "img", "images", "edge", "origin", "fallback",
  "customers", "saas", "proxy", "gateway", "ws", "wss", "git", "ci", "dev", "development",
  "staging", "stage", "beta", "alpha", "canary", "test", "testing", "qa", "prod", "production",
  "preview", "previews", "sandbox", "internal", "localhost", "local", "system", "health",
  "healthz", "metrics", "monitor",
  // names that would read as official
  "educateos", "schoolos", "cloudflare", "official", "district", "districts", "school", "schools",
  "example", "invalid", "null", "undefined",
]);

/** The shortest and longest slug. Three characters keeps out two-letter codes such as `us`. */
export const SLUG_LENGTH = { min: 3, max: 32 } as const;

/**
 * A district slug: a lowercase DNS label of {@link SLUG_LENGTH} characters, starting with a letter,
 * with no leading, trailing or doubled hyphen (so never an IDN `xn--` label), and not in
 * {@link RESERVED_SLUGS}. Uniqueness is the managed zone's: a slug is taken while its hostname
 * routes to another instance, which planning reports and applying refuses.
 */
export const DistrictSlug = z
  .string()
  .min(SLUG_LENGTH.min)
  .max(SLUG_LENGTH.max)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "expected lowercase letters, digits and hyphens, starting with a letter")
  .refine((slug) => !slug.includes("--"), "a slug may not contain two hyphens in a row")
  .refine((slug) => !RESERVED_SLUGS.has(slug), "that slug is reserved");
/** A district slug, as parsed. */
export type DistrictSlug = z.infer<typeof DistrictSlug>;

/** The managed default hostname of a slug, e.g. `northfield.educateos.io`. */
export function managedHostname(slug: DistrictSlug): string {
  return `${slug}.${MANAGED_ZONE}`;
}
