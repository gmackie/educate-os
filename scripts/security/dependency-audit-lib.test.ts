import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type Advisory,
  type BaselineEntry,
  countBySeverity,
  evaluate,
  lockfileHas,
  parseAudit,
  validateBaseline,
} from "./dependency-audit-lib.ts";

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "GHSA-aaaa-bbbb-cccc",
    module: "left-pad",
    severity: "high",
    versions: ["1.0.0"],
    patched: ">=1.0.1",
    title: "Example advisory",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    path: ".>left-pad",
    ...overrides,
  };
}

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    id: "GHSA-aaaa-bbbb-cccc",
    lockfile: "pnpm-lock.yaml",
    package: "left-pad",
    severity: "high",
    reason: "Build-time only; never bundled into a Worker.",
    issue: "SCHO-1",
    ...overrides,
  };
}

const lockWith = (name: string, version: string): string =>
  `lockfileVersion: '9.0'\n\npackages:\n\n  ${name}@${version}:\n    resolution: {integrity: sha512-x}\n`;

const TODAY = "2026-11-13";

describe("parseAudit", () => {
  it("reads pnpm audit's JSON report", () => {
    const report = JSON.stringify({
      advisories: {
        "1": {
          github_advisory_id: "GHSA-jmr9-qjv8-65gv",
          module_name: "extract-zip",
          severity: "high",
          patched_versions: ">=2.0.2",
          title: "t",
          url: "u",
          findings: [{ version: "2.0.1", paths: ["a>b>extract-zip"] }, { version: "2.0.1", paths: [] }],
        },
      },
      metadata: {},
    });
    assert.deepEqual(parseAudit(report), [{
      id: "GHSA-jmr9-qjv8-65gv",
      module: "extract-zip",
      severity: "high",
      versions: ["2.0.1"],
      patched: ">=2.0.2",
      title: "t",
      url: "u",
      path: "a>b>extract-zip",
    }]);
  });

  it("refuses a registry error instead of reading it as a clean report", () => {
    assert.throws(() => parseAudit(JSON.stringify({ error: { code: "pnpm", message: "fetch failed" } })), /no advisories/);
    assert.throws(() => parseAudit("ERR_PNPM_AUDIT_BAD_RESPONSE"), /no JSON report/);
  });
});

describe("countBySeverity", () => {
  it("counts every severity, including absent ones", () => {
    assert.deepEqual(countBySeverity([advisory(), advisory({ severity: "low" })]), { info: 0, low: 1, moderate: 0, high: 1, critical: 0 });
  });
});

describe("lockfileHas", () => {
  it("matches package keys, quoted scoped keys and snapshot keys with peer suffixes", () => {
    assert.ok(lockfileHas(lockWith("vite", "7.3.6"), "vite", "7.3.6"));
    assert.ok(lockfileHas("snapshots:\n\n  vite@7.3.6(@types/node@26.1.0):\n", "vite", "7.3.6"));
    assert.ok(lockfileHas("packages:\n\n  '@scope/pkg@1.2.3':\n", "@scope/pkg", "1.2.3"));
  });

  it("does not match a different version, a version prefix or a dependency line", () => {
    assert.ok(!lockfileHas(lockWith("vite", "7.3.7"), "vite", "7.3.6"));
    assert.ok(!lockfileHas(lockWith("vite", "7.3.60"), "vite", "7.3.6"));
    assert.ok(!lockfileHas("packages:\n\n  other@1.0.0:\n    dependencies:\n      vite: 7.3.6\n", "vite", "7.3.6"));
  });
});

describe("validateBaseline", () => {
  it("accepts a complete entry", () => {
    const { entries, errors } = validateBaseline({ advisories: [entry()] });
    assert.deepEqual(errors, []);
    assert.equal(entries.length, 1);
  });

  it("requires a reason and an issue or an expiry", () => {
    const { errors } = validateBaseline({ advisories: [{ ...entry({ reason: "ok" }), issue: undefined }] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reason/);
    assert.match(errors[0], /issue.*expires|expires.*issue/);
  });

  it("rejects bad IDs, dates, severities and duplicates", () => {
    const { errors } = validateBaseline({
      advisories: [
        entry({ id: "CVE-2026-1" }),
        entry({ expires: "13/02/2027" }),
        { ...entry(), severity: "severe" },
        entry(),
        entry(),
      ],
    });
    assert.equal(errors.length, 4);
    assert.match(errors[3], /duplicate/);
  });

  it("rejects a file without an advisories array", () => {
    assert.equal(validateBaseline({}).errors.length, 1);
  });

  it("accepts the checked-in baseline", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("./dependency-audit-baseline.json", import.meta.url), "utf8"));
    assert.deepEqual(validateBaseline(raw).errors, []);
  });
});

describe("evaluate", () => {
  const base = { lockfile: "pnpm-lock.yaml", today: TODAY };

  it("fails a pull request that introduces a high advisory", () => {
    const a = advisory();
    const result = evaluate({ ...base, prod: [a], all: [a], baseline: [], baseLock: lockWith("left-pad", "0.9.0") });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^New high GHSA-aaaa-bbbb-cccc in left-pad@1\.0\.0/);
  });

  it("treats everything as new when the base has no such lockfile", () => {
    const a = advisory({ severity: "critical" });
    assert.equal(evaluate({ ...base, prod: [a], all: [a], baseline: [], baseLock: null }).errors.length, 1);
  });

  it("only warns about a gating advisory already on the base branch", () => {
    const a = advisory();
    const result = evaluate({ ...base, prod: [a], all: [a], baseline: [], baseLock: lockWith("left-pad", "1.0.0") });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
  });

  it("never fails in report-only mode (main, nightly)", () => {
    const a = advisory();
    const result = evaluate({ ...base, prod: [a], all: [a], baseline: [] });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
  });

  it("ignores moderate and low advisories, and dev-only ones (absent from prod)", () => {
    const moderate = advisory({ severity: "moderate" });
    const devOnly = advisory({ id: "GHSA-dddd-eeee-ffff" });
    const result = evaluate({ ...base, prod: [moderate], all: [moderate, devOnly], baseline: [], baseLock: null });
    assert.deepEqual(result, { errors: [], warnings: [], notices: [] });
  });

  it("suppresses a baselined advisory until its expiry, inclusive", () => {
    const a = advisory();
    const live = evaluate({ ...base, prod: [a], all: [a], baseline: [entry({ expires: TODAY })], baseLock: null });
    assert.deepEqual(live, { errors: [], warnings: [], notices: [] });
    const expired = evaluate({ ...base, prod: [a], all: [a], baseline: [entry({ expires: "2026-11-12" })], baseLock: lockWith("left-pad", "1.0.0") });
    assert.deepEqual(expired.errors, []);
    assert.match(expired.warnings[0], /expired on 2026-11-12/);
  });

  it("applies a baseline entry only to its own lockfile", () => {
    const a = advisory();
    const result = evaluate({ ...base, lockfile: "apps/mobile/pnpm-lock.yaml", prod: [a], all: [a], baseline: [entry()], baseLock: null });
    assert.equal(result.errors.length, 1);
  });

  it("notes a baseline entry the audit no longer reports", () => {
    const result = evaluate({ ...base, prod: [], all: [], baseline: [entry()] });
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /remove it/);
  });
});
