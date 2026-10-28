// Project-specific Env augmentation for Wrangler's generated types. These are deploy inputs, so none
// is in the config.

declare namespace Cloudflare {
  interface Env {
    /** The district's configuration as JSON (see `DistrictWorkerConfig` in config.ts). */
    DISTRICT_CONFIG: string;
    /** The Access team domain assertions are verified against, as the kernel's `CF_ACCESS_ISS`. */
    CF_ACCESS_ISS?: string;
    /**
     * The audiences of the Access applications whose assertions are accepted, comma-separated: the
     * district's own, and the instance Workshop's when its EducateOS connector forwards sign-ins.
     */
    CF_ACCESS_AUD?: string;
    /**
     * The LTI 1.3 Tool's public https origin, such as `https://district.example.org` (SCHO-177).
     * Unset, the district serves no LTI routes.
     */
    LTI_TOOL_ORIGIN?: string;
    /**
     * The district-app bearer token Clever issued for the district (SCHO-203), a Worker secret.
     * Unset, no Clever roster syncs.
     */
    CLEVER_DISTRICT_TOKEN?: string;
    /** JSON key for the district-authorized Classroom DWD service account. */
    GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY?: string;
    /**
     * The public school manifest's settings as JSON (`SchoolManifestSettings` in school-manifest.ts,
     * ADR-0014): origin, brand, sign-in methods, features. Unset, the manifest uses its defaults.
     */
    SCHOOL_MANIFEST?: string;
    /**
     * This Worker's version, when the service that deployed it injects one. Typed structurally, as
     * the router types it, since its shape is not ours to guarantee.
     */
    CF_VERSION_METADATA?: { tag?: unknown };
    /**
     * The key device access tokens are MACed with (SCHO-261), a Worker secret of at least 32
     * characters. Unset, device sign-in is off and `/api/m/*` answers 503.
     */
    DEVICE_TOKEN_SECRET?: string;
    /**
     * The AI-enabled demo district the "AI isn't enabled" page at `/ai` links to (ai-disabled.ts), on a
     * district with no Workshop that serves `/ai` itself. Unset, the page has no link.
     */
    AI_DEMO_URL?: string;
  }
}
