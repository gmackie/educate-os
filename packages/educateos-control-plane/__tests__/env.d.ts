/// <reference types="@cloudflare/vitest-plugin/types" />

// The suite's bindings, declared in `vitest.config.ts`. The pool types `env` as `Cloudflare.Env`,
// so they are declared by augmenting that.

import type { ControlPlaneEnv } from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface Env extends ControlPlaneEnv {
      TEST_ACCESS_PRIVATE_JWK: string;
      TEST_ACCESS_PUBLIC_JWK: string;
      TEST_STRANGER_PRIVATE_JWK: string;
    }
  }
}
