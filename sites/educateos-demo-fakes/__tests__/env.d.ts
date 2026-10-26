/// <reference types="@cloudflare/vitest-plugin/types" />

// The workerd suite's bindings, declared in `vitest.config.ts`. The pool types `env` as
// `Cloudflare.Env`, so they are declared by augmenting that.

declare namespace Cloudflare {
  interface Env {
    FAKES_SECRET: string;
    ADMIN_ACCESS_AUD: string;
    PUBLIC_ORIGIN: string;
    OIDC_REDIRECT_URIS: string;
    RATE_LIMIT_PER_MINUTE: string;
    /** The district objects, so a test can evict one. */
    DISTRICTS: DurableObjectNamespace<import("./worker.ts").DemoFakesDistrict>;
    /** This run's Access key, as JWKs. */
    TEST_ACCESS_PRIVATE_JWK: string;
    TEST_ACCESS_PUBLIC_JWK: string;
    /** This run's LTI tool key, as JWKs. */
    TEST_TOOL_PRIVATE_JWK: string;
    TEST_TOOL_PUBLIC_JWK: string;
  }
}
