import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ADMIN_AUDIENCE, ORIGIN, TEST_SECRET } from "./__tests__/constants.ts";

// Keys made for this run only: an Access signing key (the tests sign admin assertions with its
// private half; the test Worker trusts its public half instead of the team's certs) and an LTI
// tool's key (the test district object serves its public half as the tool's JWKS).
const jwkPair = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    private: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid, alg: "RS256" }),
    public: JSON.stringify({ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }),
  };
};
const access = jwkPair("test-access-key");
const tool = jwkPair("test-tool-key");

/**
 * The Worker runs in workerd from its own wrangler.jsonc: each district's fakes are a real SQLite
 * Durable Object, reached through the Worker's fetch handler as the public and the operator reach it.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          FAKES_SECRET: TEST_SECRET,
          ADMIN_ACCESS_AUD: ADMIN_AUDIENCE,
          PUBLIC_ORIGIN: ORIGIN,
          OIDC_REDIRECT_URIS: "https://{slug}.district.example/auth/callback",
          RATE_LIMIT_PER_MINUTE: "60",
          TEST_ACCESS_PRIVATE_JWK: access.private,
          TEST_ACCESS_PUBLIC_JWK: access.public,
          TEST_TOOL_PRIVATE_JWK: tool.private,
          TEST_TOOL_PUBLIC_JWK: tool.public,
        },
        // The Worker reaches the objects through ctx.exports; the tests evict them through this.
        durableObjects: { DISTRICTS: { className: "DemoFakesDistrict", useSQLite: true } },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    testTimeout: 30_000,
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
