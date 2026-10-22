import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd: `D1AcademicStore` against a Miniflare D1 database built
 * from this package's own migrations, exactly as a district deployment applies them. The sibling
 * `vitest.config.ts` keeps the directory logic in Node.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        d1Databases: ["DB"],
        bindings: { MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname) },
      },
    })),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd", "./__tests__/workerd/apply-migrations.ts"],
  },
});
