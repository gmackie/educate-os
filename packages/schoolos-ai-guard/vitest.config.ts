import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";
import { TEST_CONFIG } from "./__tests__/fixtures.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The guard runs in workerd: its ledger is a real SQLite Durable Object, and Hall Monitor is a fake
 * Worker reached through a real service binding, as a district's own deployment is.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: { AI_GUARD_CONFIG: JSON.stringify(TEST_CONFIG) },
        durableObjects: {
          // The guard reaches the ledger through ctx.exports; the tests read it through this binding.
          AI_LEDGER: { className: "DistrictAiLedger", useSQLite: true },
        },
        serviceBindings: {
          AI_CALL_GUARD: { name: kCurrentWorker, entrypoint: "SchoolOsAiCallGuard" },
          HALL_MONITOR: { name: kCurrentWorker, entrypoint: "FakeHallMonitor" },
          SCHOOLOS_DISTRICT: { name: kCurrentWorker, entrypoint: "FakeDistrictDirectory" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
