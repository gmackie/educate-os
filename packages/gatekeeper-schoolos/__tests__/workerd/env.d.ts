/// <reference types="@cloudflare/vitest-plugin/types" />

// The workerd suite's test-only bindings, declared in vitest.worker.config.ts rather than the
// Worker's config, so they are absent from the generated worker-configuration.d.ts.

import type { TestHooks } from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
