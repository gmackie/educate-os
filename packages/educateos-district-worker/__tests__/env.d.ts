/// <reference types="@cloudflare/vitest-plugin/types" />

// The workerd suite's own bindings, declared in `vitest.config.ts`. The pool types `env` as
// `Cloudflare.Env`, so they are declared by augmenting that.

declare namespace Cloudflare {
  interface Env {
    /** The district objects, so a test can restart one. */
    DISTRICT: DurableObjectNamespace<import("./worker.ts").DistrictObject>;
    /** The guard entrypoint, over a real service binding. */
    GUARD: Service<import("../src/worker.ts").DistrictGuardDirectory>;
    /** The school tools entrypoint, over a real service binding. */
    TOOLS: Service<import("../src/worker.ts").DistrictSchoolTools>;
    /** The private half of this run's Access key, as a JWK. */
    TEST_ACCESS_PRIVATE_JWK: string;
    /** The public half of this run's Access key, as a JWK. */
    TEST_ACCESS_PUBLIC_JWK: string;
    /** The private half of the synthetic LMS's signing key, as a JWK (SCHO-177). */
    TEST_PLATFORM_PRIVATE_JWK: string;
    /** The public half of the synthetic LMS's signing key, as a JWK (SCHO-177). */
    TEST_PLATFORM_PUBLIC_JWK: string;
  }
}
