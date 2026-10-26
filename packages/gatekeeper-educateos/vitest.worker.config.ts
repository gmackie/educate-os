import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The Worker itself in workerd: the connect flow, and the facet reading its subject from the
 * account, recording reads and queueing writes. The district is Northfield in process, behind a real
 * `EDUCATEOS_DISTRICT` service binding as a district deployment injects it.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: { BASE_URL: "https://district.example/gatekeeper/educateos" },
        durableObjects: {
          // Reached through ctx.exports in production; declared so the pool can construct them.
          EDUCATEOS_ACCOUNTS: { className: "EducateOsAccountObject", useSQLite: true },
          EDUCATEOS_GATEKEEPERS: { className: "EducateOsGatekeeper", useSQLite: true },
          // A DurableObjectClass carrying props is reachable only through ctx.facets, which is how
          // the overseer installs the gatekeeper; the tests drive it from this hook object.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        serviceBindings: {
          EDUCATEOS_DISTRICT: { name: kCurrentWorker, entrypoint: "FakeDistrict" },
        },
      },
    }),
  ],
  resolve: {
    // The School app bundle is built separately (build-app.ts); the Worker only embeds it.
    alias: [{
      find: /^\.\/generated\/app\.txt$/,
      replacement: fileURLToPath(new URL("./__tests__/workerd/app-stub.txt", import.meta.url)),
    }],
  },
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
