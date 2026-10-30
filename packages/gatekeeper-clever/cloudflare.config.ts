import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * No `vars`: every setting has an in-code default or is a secret. A deployment sets the secrets
 * `CLIENT_ID`, `CLIENT_SECRET` and `CLEVER_DISTRICT_TOKENS`, and may point `CLEVER_API_BASE` and
 * `CLEVER_OAUTH_BASE` at a Clever other than clever.com (the demo's fakes).
 */
export default defineGadgetsWorker({
  name: "gatekeeper-clever",
  entrypoint: ".wrangler/validate/src/clever.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

/** All three are reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "CleverGatekeeperImpl", "CleverDistrictLedger"] },
];
