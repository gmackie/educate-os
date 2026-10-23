import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * The district Worker. No D1 database or R2 bucket: the hosted deploy service does not yet accept a
 * service Worker's placeholders for them (SCHO-138), so every district store is in the
 * DistrictObject's SQLite.
 */
export default defineGadgetsWorker({
  name: "schoolos-district-worker",
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
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
