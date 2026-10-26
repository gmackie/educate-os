import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";
import { CLEVER_CLIENT } from "./__tests__/clever-fake.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./__tests__/fixtures.ts";

// A Cloudflare Access signing key made for this run only: the tests sign assertions with its
// private half, and the test Worker verifies them with its public half instead of the team's certs.
// A second key stands in for anyone else's.
const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-access-key";
const jwk = (key: { export(options: { format: "jwk" }): object }) => JSON.stringify({ ...key.export({ format: "jwk" }), kid: KID, alg: "RS256" });

/**
 * The site Worker runs in workerd: the store is a real SQLite Durable Object, reached through the
 * Worker's own fetch handler. The static site is a stand-in assets binding that names the path it
 * was asked for.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: {
          ACCESS_ISSUER,
          ACCESS_AUD,
          FG_COMMIT_HASH: "0".repeat(40),
          CLEVER_CLIENT_ID: CLEVER_CLIENT.clientId,
          CLEVER_CLIENT_SECRET: CLEVER_CLIENT.clientSecret,
          // A demo district that isn't a registered installation, and an entry that must be dropped.
          CLEVER_LAUNCH_DISTRICTS: JSON.stringify({ "abcdefabcdefabcdefabcdef": "demo-district.educateos.io", "fedcbafedcbafedcbafedcba": "evil.example.com" }),
          TEST_ACCESS_PRIVATE_JWK: jwk(access.privateKey),
          TEST_ACCESS_PUBLIC_JWK: jwk(access.publicKey),
          TEST_STRANGER_PRIVATE_JWK: jwk(stranger.privateKey),
        },
        durableObjects: {
          CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
        },
        serviceBindings: {
          ASSETS: (request: Request) => new Response(`static ${new URL(request.url).pathname}`, { status: 200 }),
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
