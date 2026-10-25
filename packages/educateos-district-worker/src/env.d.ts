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
  }
}
