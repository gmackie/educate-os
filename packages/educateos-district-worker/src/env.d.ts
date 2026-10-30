// Project-specific Env augmentation for Wrangler's generated types. These are deploy inputs, so none
// is in the config.

declare namespace Cloudflare {
  interface Env {
    /** Optional installer binding to the configured Workshop's WorkshopAssessmentReleases entrypoint. */
    WORKSHOP_ASSESSMENT_RELEASES?: import("./district.ts").DistrictSeams["workshopReleases"];
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
  }
}
