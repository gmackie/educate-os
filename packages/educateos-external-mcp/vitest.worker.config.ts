import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";
import { CONFIG } from "./__tests__/config.ts";
export default defineConfig({
  plugins: [cloudflareTest({ main: "./__tests__/workerd/worker.ts", miniflare: {
    compatibilityDate: COMPATIBILITY_DATE,
    bindings: { MCP_CONFIG: JSON.stringify(CONFIG) },
    durableObjects: { MCP_DISTRICT: { className: "TestMcpDistrict", useSQLite: true } },
  } })],
  test: { include: ["__tests__/workerd/*.test.ts"], setupFiles: ["@gadgets/scripts/assert-workerd"], testTimeout: 30000 },
});
