import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-educateos",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  // EDUCATEOS_DISTRICT, the district's service binding, is injected by the district deployment.
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** Both are reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["EducateOsAccountObject", "EducateOsGatekeeper"] },
];
