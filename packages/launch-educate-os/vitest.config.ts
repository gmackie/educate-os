import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    // The end-to-end suite spawns the bundled CLI and `npm pack`s the package.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
