import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["__tests__/*.test.tsx", "src/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["__tests__/setup.ts"],
    // The journeys type into many fields one keystroke at a time.
    testTimeout: 60_000,
  },
});
