// Project-specific Env augmentation for Wrangler's generated types. These are deploy inputs or
// deployment-specific bindings, so none is in the config.

declare namespace Cloudflare {
  interface Env {
    /** The guard's configuration as JSON (see `GuardConfig` in config.ts). */
    AI_GUARD_CONFIG: string;
    /**
     * A district's own Hall Monitor Worker, bound by service binding (ADR-0007 §2). Its target is
     * no Worker of this release, so it is added by the deployment rather than the config.
     */
    HALL_MONITOR?: Fetcher;
    /**
     * The district app's guard read model (`GuardDirectory` in `@educateos/district-app`), bound by
     * service binding to an entrypoint only the guard is given. Absent, the guard derives context
     * from the directory in its configuration. Its target is no Worker of this release, so it is
     * added by the deployment rather than the config.
     */
    EDUCATEOS_DISTRICT?: import("./context.ts").GuardDirectoryPort;
    /** The Cloudflare account owning the district's AI Gateway, for reading its logs' costs. */
    AI_GATEWAY_ACCOUNT_ID?: string;
    /** The district's AI Gateway ID. */
    AI_GATEWAY_ID?: string;
    /** An API token that may read the gateway's logs. Without all three, costs are estimated. */
    AI_GATEWAY_LOGS_TOKEN?: string;
    /** Hall Monitor's HTTPS origin, for a managed tenant reaching it with a service token. */
    HALL_MONITOR_URL?: string;
    /** The private JWK (Ed25519 or P-256) service tokens are signed with. */
    HALL_MONITOR_SIGNING_KEY?: string;
    /** The `iss` claim of service tokens; Hall Monitor must trust it with the key's public half. */
    HALL_MONITOR_ISSUER?: string;
    /** The `aud` claim of service tokens. Defaults to `hall-monitor`. */
    HALL_MONITOR_AUDIENCE?: string;
  }
}
