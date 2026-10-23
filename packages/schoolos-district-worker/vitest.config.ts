import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, TEST_CONFIG } from "./__tests__/fixtures.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// A Cloudflare Access signing key made for this run only: the tests sign assertions with its
// private half, and the test district verifies them with its public half instead of the team's certs.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-access-key";

/**
 * The Worker runs in workerd: the district is a real SQLite Durable Object, reached through the
 * Worker's own fetch handler and through its two entrypoints over real service bindings, as the AI
 * call guard and the SchoolOS gatekeeper reach it.
 */
export default defineConfig({
  plugins: [
    capnwebValidate({ tsconfig: "./tsconfig.validate.json" }),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: {
          DISTRICT_CONFIG: JSON.stringify(TEST_CONFIG),
          CF_ACCESS_ISS: ACCESS_ISSUER,
          CF_ACCESS_AUD: ACCESS_AUDIENCE,
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }),
          TEST_ACCESS_PUBLIC_JWK: JSON.stringify({ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }),
        },
        durableObjects: {
          // The Worker reaches the district through ctx.exports; the tests restart it through this binding.
          DISTRICT: { className: "DistrictObject", useSQLite: true },
        },
        serviceBindings: {
          GUARD: { name: kCurrentWorker, entrypoint: "DistrictGuardDirectory" },
          TOOLS: { name: kCurrentWorker, entrypoint: "DistrictSchoolTools" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Each test drives whole journeys through the Worker, several requests deep.
    testTimeout: 30_000,
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
