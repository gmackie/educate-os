import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd: `DurableObjectIdentityLinkStore` against real Durable
 * Object SQLite storage, restarts and concurrent requests. The sibling `vitest.config.ts` keeps the
 * store logic and the admin service in Node, where they are far cheaper.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: {
          IDENTITY_CONTROL: { className: "TestIdentityControl", useSQLite: true },
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
