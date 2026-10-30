import { defineGadgetsWorker, type DurableObjectMigration } from "@gadgets/scripts/worker-config";

/** Standalone district deployment, intentionally outside the Workshop installer manifest. */
export default defineGadgetsWorker({
  name: "educateos-external-mcp",
  entrypoint: "../src/worker.ts",

  observability: { enabled: false },
});

/** District state stays within the district's Cloudflare account. */
export const migrations: DurableObjectMigration[] = [{ tag: "v1", new_sqlite_classes: ["McpDistrict"] }];
