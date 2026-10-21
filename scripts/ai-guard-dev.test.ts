// The pure half of running the AI call guard in `pnpm dev-server` (scripts/ai-guard-dev.ts): when
// it runs, which entrypoint it runs, and how the backend binds it. Uses the repo's real guard
// config and release manifest rules, so a renamed entrypoint or binding fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import {
  AI_GUARD_DEV_ENV, AI_GUARD_DEV_MAIN, AI_GUARD_PACKAGE, aiGuardRequested, backendAiGuardBinding,
  devAiGuardConfig,
} from "./ai-guard-dev.ts";
import type { WranglerConfig } from "./release/manifest-lib.ts";

const GUARD_DIR = join("packages", AI_GUARD_PACKAGE);
const committed = (): WranglerConfig => parse(readFileSync(join(GUARD_DIR, "wrangler.jsonc"), "utf8"));

test("the guard is off by default and on with the flag or the env var", () => {
  assert.equal(aiGuardRequested(["--port", "9000"], {}), false);
  assert.equal(aiGuardRequested(["--with-ai-guard"], {}), true);
  assert.equal(aiGuardRequested([], { [AI_GUARD_DEV_ENV]: "1" }), true);
  assert.equal(aiGuardRequested([], { [AI_GUARD_DEV_ENV]: "TRUE" }), true);
  assert.equal(aiGuardRequested([], { [AI_GUARD_DEV_ENV]: "0" }), false);
  assert.equal(aiGuardRequested([], { [AI_GUARD_DEV_ENV]: "" }), false);
  // A typo must not silently leave the backend unguarded.
  assert.throws(() => aiGuardRequested([], { [AI_GUARD_DEV_ENV]: "yes" }), /must be 1, true, 0 or false/);
});

test("the backend binds the guard exactly as a release does", () => {
  assert.deepEqual(backendAiGuardBinding(), {
    binding: "AI_CALL_GUARD",
    service: AI_GUARD_PACKAGE,
    entrypoint: "SchoolOsAiCallGuard",
  });
});

test("the dev config runs the development entrypoint and keeps everything else", () => {
  const base = committed();
  const config = devAiGuardConfig(base, {});

  assert.equal(config.main, AI_GUARD_DEV_MAIN);
  // The development entrypoint is in the guard's sources, where its validate build writes it.
  assert.equal(base.main?.replace("worker.ts", "dev-worker.ts"), AI_GUARD_DEV_MAIN);
  readFileSync(join(GUARD_DIR, "src", "dev-worker.ts"));
  assert.deepEqual(config.migrations, base.migrations, "the ledger's Durable Object migrations");
  assert.deepEqual(config.build, base.build);
  assert.equal(config.vars?.AI_GUARD_CONFIG, undefined, "the entrypoint's own dev config applies");
  assert.notEqual(base.main, AI_GUARD_DEV_MAIN, "the committed config is not modified");
});

test("AI_GUARD_CONFIG from the environment replaces the built-in dev config", () => {
  const config = devAiGuardConfig(committed(), { AI_GUARD_CONFIG: "{\"districtId\":\"dst_x\"}" });
  assert.equal(config.vars?.AI_GUARD_CONFIG, "{\"districtId\":\"dst_x\"}");
});
