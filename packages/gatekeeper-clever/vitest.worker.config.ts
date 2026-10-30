import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the account Durable Object's sign-in, and the gatekeeper Durable Object
 * reached through a `TestHooks` facet as the overseer reaches it, against the wire-faithful Clever
 * fakes of @educateos/provider-fakes installed at `fetch`. The `@validateRpc()` decorators are
 * applied in memory by the capnweb-validate plugin, since `.wrangler/validate` is not built for
 * tests.
 *
 * The district ID is the sample district's Clever ID (`cleverDistrictId(SAMPLE_DISTRICT)`); the
 * fakes are given the token below, so the two must stay in step with `__tests__/workerd/fake-clever.ts`.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          CLEVER_GATEKEEPER: { className: "CleverGatekeeperImpl", useSQLite: true },
          CLEVER_LEDGER: { className: "CleverDistrictLedger", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
          BASE_URL: "http://localhost:8787/gatekeeper/clever",
          CLEVER_LOGIN_HINT_FORM: "true",
          CLEVER_DISTRICT_TOKENS: JSON.stringify({ be36e9f30702df9abe36eaf3: "test-district-token" }),
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
