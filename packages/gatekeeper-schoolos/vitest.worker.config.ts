import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The Worker itself in workerd: the connect flow, and the facet reading its subject from the
 * account, recording reads and queueing writes. The district is Northfield in process, behind a real
 * `SCHOOLOS_DISTRICT` service binding as a district deployment injects it.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: { BASE_URL: "https://district.example/gatekeeper/schoolos" },
        durableObjects: {
          // Reached through ctx.exports in production; declared so the pool can construct them.
          SCHOOLOS_ACCOUNTS: { className: "SchoolOsAccountObject", useSQLite: true },
          SCHOOLOS_GATEKEEPERS: { className: "SchoolOsGatekeeper", useSQLite: true },
          // A DurableObjectClass carrying props is reachable only through ctx.facets, which is how
          // the overseer installs the gatekeeper; the tests drive it from this hook object.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        serviceBindings: {
          SCHOOLOS_DISTRICT: { name: kCurrentWorker, entrypoint: "FakeDistrict" },
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
