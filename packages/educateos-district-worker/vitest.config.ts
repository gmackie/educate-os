import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";
import { ACCESS_AUDIENCES, ACCESS_ISSUER, DEVICE_TOKEN_SECRET, HALL_MONITOR_URL, LTI_TOOL_ORIGIN, TEST_CONFIG } from "./__tests__/fixtures.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// A Cloudflare Access signing key made for this run only: the tests sign assertions with its
// private half, and the test district verifies them with its public half instead of the team's certs.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-access-key";
// The synthetic LMS's signing key (SCHO-177): the tests sign launches with its private half, and the
// test district's platform fetch publishes its public half as the platform's JWKS.
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PLATFORM_KID = "test-platform-key";
// The key the district signs Hall Monitor service tokens with (SCHO-305), for this run only.
const hallMonitorKey = generateKeyPairSync("ed25519");
// The synthetic authorization server's access-token key (SCHO-174), for this run only.
const mcpIssuerKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
// The release key marketplace publisher credentials are signed with (SCHO-209), for this run only:
// the district pins its public half in MARKETPLACE_TRUST, and the tests sign with its private half.
const marketplaceKey = generateKeyPairSync("ed25519");
const pinned = (key: KeyObject) => {
  const x = key.export({ format: "jwk" }).x!;
  return { keyId: `ed25519-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url")}`, publicKey: x };
};
const MARKETPLACE_TRUST = JSON.stringify({
  root: { threshold: 1, keys: [pinned(generateKeyPairSync("ed25519").publicKey)] },
  keySetVersion: 0,
  keys: [pinned(marketplaceKey.publicKey)],
});

// The course library's publisher pin (SCHO-331): the committed educateos.io key, so the tests import
// the committed reference course bundle exactly as a deployed district would.
const COURSE_LIBRARY_TRUST = JSON.stringify({
  localDomains: [],
  publishers: [JSON.parse(readFileSync(new URL("../../curriculum/educateos.io/publisher.json", import.meta.url), "utf8"))],
});

/**
 * The Worker runs in workerd: the district is a real SQLite Durable Object, reached through the
 * Worker's own fetch handler and through its two entrypoints over real service bindings, as the AI
 * call guard and the EducateOS gatekeeper reach it.
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
          CF_ACCESS_AUD: ACCESS_AUDIENCES,
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }),
          TEST_ACCESS_PUBLIC_JWK: JSON.stringify({ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }),
          LTI_TOOL_ORIGIN: LTI_TOOL_ORIGIN,
          // The LTI Platform (SCHO-179) is on here; every production configuration leaves it off.
          LTI_PLATFORM: "on",
          // Device sign-in (SCHO-261): a test-only key; production sets none until the cutover.
          DEVICE_TOKEN_SECRET: DEVICE_TOKEN_SECRET,
          // The ops analytics proxy (SCHO-263): test-only values; the test object answers Cloudflare's API.
          CF_ANALYTICS_TOKEN: "test-analytics-token",
          CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          ANALYTICS_SCRIPTS: "educateos-district-worker",
          // Discussion screening (SCHO-305): the test object answers Hall Monitor with the guard's fake.
          HALL_MONITOR_URL,
          HALL_MONITOR_SIGNING_KEY: JSON.stringify({ ...hallMonitorKey.privateKey.export({ format: "jwk" }), kid: "test-hall-monitor-key" }),
          HALL_MONITOR_ISSUER: "educateos",
          TEST_PLATFORM_PRIVATE_JWK: JSON.stringify({ ...platform.privateKey.export({ format: "jwk" }), kid: PLATFORM_KID, alg: "RS256" }),
          TEST_PLATFORM_PUBLIC_JWK: JSON.stringify({ ...platform.publicKey.export({ format: "jwk" }), kid: PLATFORM_KID, alg: "RS256", use: "sig" }),
          // The organization MCP endpoint (SCHO-174): the test object trusts the public half.
          TEST_MCP_ISSUER_PRIVATE_JWK: JSON.stringify({ ...mcpIssuerKey.privateKey.export({ format: "jwk" }), kid: "test-mcp-key", alg: "ES256" }),
          TEST_MCP_ISSUER_PUBLIC_JWK: JSON.stringify({ ...mcpIssuerKey.publicKey.export({ format: "jwk" }), kid: "test-mcp-key", alg: "ES256" }),
          // Marketplace installs (SCHO-209).
          MARKETPLACE_TRUST,
          // Course library imports (SCHO-331).
          COURSE_LIBRARY_TRUST,
          // The demo showcase (SCHO-326), which TEST_CONFIG.demo names too.
          DEMO_SHOWCASE: "northfield",
          TEST_MARKETPLACE_RELEASE_JWK: JSON.stringify(marketplaceKey.privateKey.export({ format: "jwk" })),
        },
        durableObjects: {
          // The Worker reaches the district through ctx.exports; the tests restart it through this binding.
          DISTRICT: { className: "DistrictObject", useSQLite: true },
        },
        serviceBindings: {
          WORKSHOP_POLICY: { name: kCurrentWorker, entrypoint: "DistrictWorkshopCapabilityPolicy" },
          GUARD: { name: kCurrentWorker, entrypoint: "DistrictGuardDirectory" },
          TOOLS: { name: kCurrentWorker, entrypoint: "DistrictSchoolTools" },
          PRINCIPALS: { name: kCurrentWorker, entrypoint: "DistrictPrincipalResolver" },
          WORKSHOP_ASSESSMENT_RELEASES: { name: kCurrentWorker, entrypoint: "TestWorkshopReleases" },
          TEST_WORKSHOP_RELEASES: { name: kCurrentWorker, entrypoint: "TestWorkshopReleases" },
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
