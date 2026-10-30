import { generateKeyPairSync, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// A Cloudflare Access signing key made for this run only: the tests sign assertions with its
// private half, and the test Worker verifies them with its public half instead of the team's certs.
// A second key stands in for anyone else's.
const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-access-key";
const jwk = (key: { export(options: { format: "jwk" }): object }) => JSON.stringify({ ...key.export({ format: "jwk" }), kid: KID, alg: "RS256" });

/**
 * The Worker's suite in workerd, against a real (local) D1 with the package's migrations applied,
 * so the SQL is the SQL that will run. Districts are fakes that verify signed ops requests with
 * the protocol's own verifier.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: {
          ACCESS_ISSUER: "https://educateos-test.cloudflareaccess.com",
          ACCESS_AUD: "b".repeat(64),
          ADMINS: "ops@educateos.io, viewer@educateos.io:viewer, sub-listed-by-id",
          EDITION: "hosted",
          ADMIN_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
          TEST_ACCESS_PRIVATE_JWK: jwk(access.privateKey),
          TEST_ACCESS_PUBLIC_JWK: jwk(access.publicKey),
          TEST_STRANGER_PRIVATE_JWK: jwk(stranger.privateKey),
          TEST_MIGRATIONS: await readD1Migrations(join(here, "migrations")),
        },
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd", "./__tests__/apply-migrations.ts"],
  },
});
