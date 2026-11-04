#!/usr/bin/env node

// The in-repo curriculum's tooling (SCHO-330). `curriculum/README.md` is the authoring guide.
//
//   node scripts/curriculum/curriculum.ts validate          every course and export, with a report per course
//   node scripts/curriculum/curriculum.ts pack              update portable digests, lockfiles and bundles
//   node scripts/curriculum/curriculum.ts sign              sign what is unsigned, with the publisher key
//   node scripts/curriculum/curriculum.ts check             validate + pack is current + every bundle verifies (CI)
//   node scripts/curriculum/curriculum.ts standards <framework> [code prefix]
//                                                           real competency URIs in the built-in catalog
//
// `--root <dir>` reads another curriculum directory (the tests use one). `sign` takes the key from
// EDUCATEOS_OCS_PUBLISHER_KEY or, on macOS, the Keychain item educateos-marketplace-publisher-key
// (account educateos). The key is never printed.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkTree,
  CURRICULUM_ROOT,
  findStandards,
  formatReport,
  type Issue,
  packTree,
  publisherKey,
  readTree,
  signTree,
  validateTree,
  writeOutput,
} from "./lib.ts";

const USAGE = "usage: node scripts/curriculum/curriculum.ts validate|pack|sign|check|standards <framework> [prefix] [--root <dir>]";

function printIssues(issues: readonly Issue[], out: (line: string) => void): number {
  const errors = issues.filter((issue) => issue.severity === "error");
  for (const issue of issues.toSorted((a, b) => (a.severity === b.severity ? (a.where < b.where ? -1 : 1) : a.severity === "error" ? -1 : 1))) {
    out(`${issue.severity === "error" ? "error" : "warning"}: ${issue.where}: ${issue.message}`);
  }
  return errors.length;
}

/** Runs one command. Returns the exit code. */
export async function main(argv: readonly string[], out: (line: string) => void = console.log, env: Record<string, string | undefined> = process.env): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { root: { type: "string" } } });
  const root = values.root ?? CURRICULUM_ROOT;
  const [command, ...rest] = positionals;
  switch (command) {
    case "validate": {
      const validation = await validateTree(readTree(root));
      for (const report of validation.reports) for (const line of formatReport(report)) out(line);
      out(`${validation.reports.length} course(s), ${validation.exports.size} export(s)`);
      return printIssues(validation.issues, out) > 0 ? 1 : 0;
    }
    case "pack": {
      const tree = readTree(root);
      const validation = await validateTree(tree);
      if (printIssues(validation.issues.filter((issue) => issue.fix !== "pack"), out) > 0) {
        out("not packed: fix the errors above first");
        return 1;
      }
      const packed = await packTree(tree, validation);
      if (printIssues(packed.issues, out) > 0) return 1;
      writeOutput(root, packed.files);
      for (const path of [...packed.files.keys()].toSorted()) out(`wrote ${path}`);
      if (packed.files.size === 0) out("already packed");
      return 0;
    }
    case "sign": {
      const tree = readTree(root);
      const { identity, source } = await publisherKey(env);
      out(`signing with ${identity.keyId} from ${source}`);
      const { files, signed } = await signTree(tree, identity);
      writeOutput(root, files);
      for (const part of signed) out(`signed ${part}`);
      if (signed.length === 0) out("everything is already signed");
      return 0;
    }
    case "check": {
      const { validation, issues } = await checkTree(readTree(root));
      const errors = printIssues(issues, out);
      out(`${validation.reports.length} course(s), ${validation.exports.size} export(s): ${errors === 0 ? "ok" : `${errors} error(s)`}`);
      return errors > 0 ? 1 : 0;
    }
    case "standards": {
      const [framework, prefix] = rest;
      if (framework === undefined) {
        out(USAGE);
        return 2;
      }
      for (const item of await findStandards(framework, prefix)) out(`${item.code}\t${item.uri}\t${item.statement.slice(0, 120)}`);
      return 0;
    }
    default:
      out(USAGE);
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
