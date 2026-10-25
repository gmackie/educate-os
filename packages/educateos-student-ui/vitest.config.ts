import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["__tests__/setup.ts"],
    // The journeys tab through every header control, Kumo tooltips included, one key at a time,
    // which takes longer than vitest's 5 s default on a busy machine.
    testTimeout: 30_000,
  },
});
