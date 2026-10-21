import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd: the release stores against real Durable Object SQLite
 * storage, restarts and concurrent requests. The sibling `vitest.config.ts` keeps the release
 * logic in Node.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: {
          DISTRICT: { className: "TestDistrict", useSQLite: true },
          ROLLOUT: { className: "TestRollout", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
