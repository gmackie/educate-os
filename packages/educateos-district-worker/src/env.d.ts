// Project-specific Env augmentation for Wrangler's generated types. These are deploy inputs, so none
// is in the config.

declare namespace Cloudflare {
  interface Env {
    /** The district's configuration as JSON (see `DistrictWorkerConfig` in config.ts). */
    DISTRICT_CONFIG: string;
    /** The Access team domain assertions are verified against, as the kernel's `CF_ACCESS_ISS`. */
    CF_ACCESS_ISS?: string;
    /** The Access application audience assertions are verified against, as the kernel's `CF_ACCESS_AUD`. */
    CF_ACCESS_AUD?: string;
  }
}
