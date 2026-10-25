/// <reference types="@cloudflare/vitest-plugin/types" />

// The test-only bindings declared in `vitest.config.ts`, which are absent from the generated
// `worker-configuration.d.ts`.

import type { DistrictAiLedger, EducateOsAiCallGuard } from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      AI_LEDGER: DurableObjectNamespace<DistrictAiLedger>;
      AI_CALL_GUARD: Service<EducateOsAiCallGuard>;
    }
  }
}
