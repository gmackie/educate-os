import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    // Each scenario boots whole district applications and drives them over HTTP.
    testTimeout: 30_000,
  },
});
