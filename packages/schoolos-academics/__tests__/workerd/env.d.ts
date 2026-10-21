/// <reference types="@cloudflare/vitest-plugin/types" />

// The workerd suite's bindings, declared in `vitest.worker.config.ts`. The pool types `env` as
// `Cloudflare.Env`, so they are declared by augmenting that.

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MIGRATIONS: D1Migration[];
    }
  }
}
