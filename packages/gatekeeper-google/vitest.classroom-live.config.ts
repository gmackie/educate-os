import { defineConfig } from "vitest/config";

/** Explicit opt-in only: never included in the normal offline suite or CI. */
export default defineConfig({ test: { include: ["live/classroom.test.ts"], testTimeout: 60_000, environment: "node" } });
