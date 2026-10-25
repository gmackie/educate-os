// Running the EducateOS AI call guard (packages/educateos-ai-guard) outside a release: in
// `pnpm dev-server --with-ai-guard` and in PR previews. Both run the guard's development
// entrypoint (src/dev-worker.ts), which is the production guard and ledger with an in-process
// fake Hall Monitor and a synthetic default config, and both bind it to the backend exactly as a
// release does (manifest-lib's `backendBinding`). The pure halves live here so they are tested.

import type { ServiceBinding, WranglerConfig } from "./release/manifest-lib.ts";
import { serviceBackendBinding } from "./release/manifest-lib.ts";

/** The guard's package (and worker) name. */
export const AI_GUARD_PACKAGE = "educateos-ai-guard";

/** The guard's development entrypoint, where its capnweb-validate build writes it. */
export const AI_GUARD_DEV_MAIN = ".wrangler/validate/src/dev-worker.ts";

/** The command-line flag that adds the guard to the dev server. */
export const AI_GUARD_DEV_FLAG = "--with-ai-guard";

/** The environment variable (shell or root `.dev.vars`) that does the same as the flag. */
export const AI_GUARD_DEV_ENV = "EDUCATEOS_DEV_AI_GUARD";

/**
 * Whether the dev server should run the guard. Off by default, so the dev server stays upstream's;
 * on with {@link AI_GUARD_DEV_FLAG}, or with {@link AI_GUARD_DEV_ENV} set to `1` or `true`. Any
 * other non-empty value is refused rather than read as off, since a typo would otherwise leave a
 * developer testing an unguarded backend while believing it guarded.
 */
export function aiGuardRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes(AI_GUARD_DEV_FLAG)) return true;
  const value = env[AI_GUARD_DEV_ENV]?.trim().toLowerCase();
  if (!value || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${AI_GUARD_DEV_ENV} must be 1, true, 0 or false, not "${env[AI_GUARD_DEV_ENV]}"`);
}

/** The backend's binding to the guard, as the release manifest declares it. */
export function backendAiGuardBinding(): ServiceBinding {
  const binding = serviceBackendBinding(AI_GUARD_PACKAGE);
  if (!binding) throw new Error(`${AI_GUARD_PACKAGE} is no longer a service package in manifest-lib.ts`);
  return { binding: binding.name, service: AI_GUARD_PACKAGE, entrypoint: binding.entrypoint };
}

/**
 * The guard's config for the dev server: the committed one, running the development entrypoint.
 * `AI_GUARD_CONFIG` from the shell or `.dev.vars` replaces the built-in dev config, for example to
 * price a model the dev config does not know; unset, the dev entrypoint uses its own. The release's
 * Cron Triggers are dropped: the nightly reconciliation reads AI Gateway logs, and the development
 * entrypoint has no scheduled handler.
 */
export function devAiGuardConfig(committed: WranglerConfig, env: NodeJS.ProcessEnv): WranglerConfig {
  const config: WranglerConfig = { ...structuredClone(committed), main: AI_GUARD_DEV_MAIN };
  delete config.triggers;
  if (env.AI_GUARD_CONFIG) config.vars = { ...config.vars, AI_GUARD_CONFIG: env.AI_GUARD_CONFIG };
  return config;
}
