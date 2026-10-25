import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker, triggers,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";
import { DIGEST_CRON, NOTIFICATION_CRON } from "./src/schedule.ts";

/**
 * The district Worker. No D1 database or R2 bucket: the hosted deploy service does not yet accept a
 * service Worker's placeholders for them (SCHO-138), so every district store is in the
 * DistrictObject's SQLite.
 */
export default defineGadgetsWorker({
  name: "educateos-district-worker",
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  env: {
    // Communication (SCHO-189): notification and family digest email through Cloudflare Email
    // Service in the district's own account. Unrestricted: recipients are the district's own
    // principals, and the sender is `DISTRICT_CONFIG.email.from`.
    SEND_EMAIL: bindings.sendEmail(),
  },
  // Communication (SCHO-189): the hourly notification sweep and the weekly family digest
  // (src/schedule.ts). The district installer does not apply Cron Triggers yet (SCHO-148).
  triggers: [triggers.scheduled({ schedule: NOTIFICATION_CRON }), triggers.scheduled({ schedule: DIGEST_CRON })],
});

export const wrangler = {
  // The entrypoints' validators come from the Workers-typed program (tsconfig.validate.json), since
  // the package's own tsconfig.json leaves the Workers-only modules out.
  build: { ...CAPNWEB_VALIDATE_BUILD, command: `${CAPNWEB_VALIDATE_BUILD.command} --tsconfig tsconfig.validate.json` },
} satisfies WranglerExtras;

/** The district's object is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["DistrictObject"] },
];
