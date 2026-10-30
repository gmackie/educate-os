import { defineGadgetsWorker, type DurableObjectMigration } from "@gadgets/scripts/worker-config";

/** School release MCP transport; the public router forwards only MCP and discovery paths. */
export default defineGadgetsWorker({
  name: "educateos-external-mcp",
  entrypoint: "src/worker.ts",
  observability: { enabled: false },
});

/** District-local durable token and approval state. */
export const migrations: DurableObjectMigration[] = [{ tag: "v1", new_sqlite_classes: ["McpDistrict"] }];
