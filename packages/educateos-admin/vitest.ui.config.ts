import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The SPA's suite, in jsdom against a fake admin API. */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/ui/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    testTimeout: 30_000,
  },
});
