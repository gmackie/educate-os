import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, triggers,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "schoolos-ai-guard",
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  // Nightly reconciliation (src/reconciliation.ts), after the UTC day it closes.
  triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

/** The district ledger is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["DistrictAiLedger"] },
];
