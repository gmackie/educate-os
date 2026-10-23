#!/usr/bin/env node

// Stamps the commit being deployed into a production Wrangler config, as `vars.FG_COMMIT_HASH`,
// in the deployer's checkout. ForgeGraph's source-order guard refuses a deploy over a serving
// version with no `FG_COMMIT_HASH`, and its agent stamps the var only into a config with a
// standard name (`wrangler.jsonc`, ...), never into the `-c wrangler.production.jsonc` these
// targets deploy (FORGE-212). So each target's `buildCommand` runs this first, from its package
// directory. Remove it once the agent stamps the config named by `-c`.
//
// The committed configs never carry the var: a committed file cannot name its own commit.
//
// Usage: node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** The var ForgeGraph reads a serving Worker version's source commit from. */
export const COMMIT_VAR = "FG_COMMIT_HASH";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The config text with `vars.FG_COMMIT_HASH` set to `commit`. Refuses a malformed commit, a config
 * that is not valid JSONC, and a config that already names a different commit.
 */
export function stampCommit(text: string, commit: string): string {
  if (!COMMIT_SHA.test(commit)) throw new Error(`not a full commit SHA: ${JSON.stringify(commit)}`);
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true }) as { vars?: Record<string, unknown> };
  if (errors.length > 0 || config === null || typeof config !== "object") {
    throw new Error("the Wrangler config is not valid JSONC");
  }
  const existing = config.vars?.[COMMIT_VAR];
  if (existing !== undefined && existing !== commit) {
    throw new Error(`the Wrangler config already names commit ${String(existing)}`);
  }
  const edits = modify(text, ["vars", COMMIT_VAR], commit, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return applyEdits(text, edits);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: stamp-commit.ts <wrangler config>");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path, stampCommit(readFileSync(path, "utf8"), commit));
  console.log(`stamped ${COMMIT_VAR}=${commit} into ${path}`);
}
