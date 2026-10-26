import { defineConfig } from "vitest/config";

/**
 * The guided install's suite runs in Node: it drives the real installer against the installer's
 * in-memory Cloudflare fake, with the installer's own signed test release, whose fixtures are read
 * from disk. The rest of the package's suite runs in workerd (`vitest.config.ts`).
 */
export default defineConfig({
  test: {
    include: ["__tests__/node/*.test.ts"],
    environment: "node",
  },
});
