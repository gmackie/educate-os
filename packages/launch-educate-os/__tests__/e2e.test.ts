// End to end: the bundled CLI, as npm ships it, run as a child process against the installer's
// Cloudflare fake (over the loopback bridge) and a local release mirror serving signed releases.
// Then the npm path itself: `npm pack` and `npx ./launch-educate-os-0.1.0.tgz`.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundle } from "../scripts/bundle.ts";
import { TEST_CLOUDFLARE_RPC_ENV } from "../src/cloudflare.ts";
import {
  accountFor,
  asVersion,
  type CloudflareBridge,
  deriveRelease,
  goldenRelease,
  GOOGLE_SECRETS,
  NORTHFIELD,
  northfieldAnswers,
  type ReleaseServer,
  serveCloudflare,
  serveReleases,
  type TestRelease,
  writeAnswersFile,
  writeReleaseDir,
  writeTrustFile,
} from "./harness.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

let cli: string;
let v1: TestRelease;
let v2: TestRelease;
let mirror: ReleaseServer;
let cloudflare: CloudflareBridge;
let trust: string;

beforeAll(async () => {
  cli = await bundle(join(mkdtempSync(join(tmpdir(), "launch-bundle-")), "launch-educate-os.mjs"));
  const golden = await goldenRelease();
  v1 = await asVersion(await deriveRelease(golden, "r000001-aaaaaaa"), "0.1.0");
  v2 = await asVersion(await deriveRelease(golden, "r000002-bbbbbbb"), "0.2.0");
  mirror = await serveReleases(v1, v2);
  cloudflare = await serveCloudflare(accountFor(NORTHFIELD));
  trust = writeTrustFile();
});

afterAll(async () => {
  await mirror?.close();
  await cloudflare?.close();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      // A clean environment: no token, no secrets, nothing inherited but what finds node and npm.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...options.env },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 110_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

const events = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);

describe("the bundled CLI", () => {
  it("prints its usage and version with no workspace around it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-empty-"));
    const help = await run(process.execPath, [cli, "--help"], { cwd: dir });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("npx launch-educate-os [install]");
    expect((await run(process.execPath, [cli, "--version"], { cwd: dir })).stdout.trim()).toBe("0.1.0");
    expect((await run(process.execPath, [cli, "frobnicate"], { cwd: dir })).code).toBe(2);
  });

  it("plans, installs, re-runs as a no-op, upgrades and rolls back, all non-interactively", async () => {
    const { dir, path } = writeAnswersFile(northfieldAnswers());
    const env = { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url, CLOUDFLARE_API_TOKEN: cloudflare.token, ...GOOGLE_SECRETS };
    const common = ["--config", path, "--release-url", mirror.base, "--trust", trust, "--json"];

    // Plan only: changes nothing.
    const before = JSON.stringify(cloudflare.fake.inventory());
    const plan = await run(process.execPath, [cli, "plan", ...common, "--release", "r000001-aaaaaaa"], { cwd: dir, env });
    expect(plan.code, plan.stderr).toBe(0);
    expect(events(plan.stdout).map((e) => e.event)).toEqual(["release", "preflight", "plan", "done"]);
    expect(JSON.stringify(cloudflare.fake.inventory())).toBe(before);

    // Install v1. Without --yes and without a terminal it refuses to apply.
    expect((await run(process.execPath, [cli, ...common, "--release", "r000001-aaaaaaa"], { cwd: dir, env })).code).toBe(2);
    const installed = await run(process.execPath, [cli, "install", ...common, "--release", "r000001-aaaaaaa", "--yes"], { cwd: dir, env });
    expect(installed.code, installed.stderr).toBe(0);
    const done = events(installed.stdout).find((e) => e.event === "done");
    expect(done).toMatchObject({ status: "applied", urls: { workshop: "https://educateos.northfield.example/" } });
    const steps = events(installed.stdout).filter((e) => e.event === "step");
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.at(-1)).toMatchObject({ index: steps.length, total: steps.length });
    expect(cloudflare.fake.serving("educateos.northfield.example")?.releaseId).toBe("r000001-aaaaaaa");
    expect(cloudflare.fake.worker("educateos-northfield-gatekeeper-google")?.secretNames).toEqual(["CLIENT_ID", "CLIENT_SECRET"]);
    for (const secret of [cloudflare.token, ...Object.values(GOOGLE_SECRETS)]) {
      expect(installed.stdout + installed.stderr).not.toContain(secret);
      expect(readFileSync(path, "utf8")).not.toContain(secret);
    }

    // Re-running is a no-op.
    const again = await run(process.execPath, [cli, ...common, "--release", "r000001-aaaaaaa", "--yes"], { cwd: dir, env });
    expect(again.code).toBe(0);
    expect(events(again.stdout).find((e) => e.event === "plan")).toMatchObject({ steps: [] });

    // Upgrade to the newest release the mirror names.
    const upgraded = await run(process.execPath, [cli, "upgrade", ...common, "--yes"], { cwd: dir, env });
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(events(upgraded.stdout)[0]).toMatchObject({ event: "release", releaseId: "r000002-bbbbbbb" });
    expect(cloudflare.fake.serving("educateos.northfield.example")?.releaseId).toBe("r000002-bbbbbbb");

    // A pointer moved back to v1 is refused: going back takes the rollback command.
    mirror.setLatest("r000001-aaaaaaa");
    const downgrade = await run(process.execPath, [cli, "upgrade", ...common, "--yes"], { cwd: dir, env });
    expect(downgrade.code).toBe(1);
    expect(events(downgrade.stdout).at(-1)).toMatchObject({ event: "error", code: "policy-violation" });
    mirror.setLatest("r000002-bbbbbbb");

    const rolledBack = await run(process.execPath, [cli, "rollback", ...common, "--yes"], { cwd: dir, env });
    expect(rolledBack.code, rolledBack.stderr).toBe(0);
    expect(events(rolledBack.stdout).find((e) => e.event === "rollback")).toMatchObject({ fromReleaseId: "r000002-bbbbbbb", toReleaseId: "r000001-aaaaaaa" });
    expect(cloudflare.fake.serving("educateos.northfield.example")?.releaseId).toBe("r000001-aaaaaaa");
    expect(JSON.parse(readFileSync(path, "utf8")).history.map((h: { action: string }) => h.action)).toEqual(["install", "upgrade", "rollback"]);

    // Doctor reads it all back.
    const doctor = await run(process.execPath, [cli, "doctor", ...common], { cwd: dir, env });
    expect(doctor.code, doctor.stdout).toBe(0);
    expect(events(doctor.stdout).find((e) => e.check === "installed")).toMatchObject({ ok: true });
  });

  it("refuses a tampered release before touching the account, and installs offline from a directory", async () => {
    const fake = accountFor(NORTHFIELD);
    const bridge = await serveCloudflare(fake);
    try {
      const { dir, path } = writeAnswersFile(northfieldAnswers({ gatekeepers: [] }));
      const env = { [TEST_CLOUDFLARE_RPC_ENV]: bridge.url, CLOUDFLARE_API_TOKEN: bridge.token };
      // Signed by a key the installer doesn't pin (its own, built-in keys).
      const unpinned = await run(process.execPath, [cli, "--config", path, "--release-url", mirror.base, "--yes"], { cwd: dir, env });
      expect(unpinned.code).toBe(1);
      expect(unpinned.stderr).toContain("release manifest signature not accepted");
      expect(fake.calls).toEqual([]);

      const releaseDir = await writeReleaseDir(v2);
      const offline = await run(process.execPath, [cli, "--config", path, "--release-dir", releaseDir, "--trust", trust, "--yes"], { cwd: dir, env });
      expect(offline.code, offline.stderr).toBe(0);
      expect(offline.stdout).toContain("EducateOS 0.2.0 is installed.");
      expect(fake.serving("educateos.northfield.example")?.releaseId).toBe("r000002-bbbbbbb");

      // A blob substituted in the directory fails the install rather than being uploaded.
      const broken = await writeReleaseDir(v1);
      const module = v1.manifest.workers["workshop-backend"]!.modules[0]!;
      writeFileSync(join(broken, "modules", module.sha256), "export default {}");
      const fresh = accountFor(NORTHFIELD);
      const freshBridge = await serveCloudflare(fresh);
      try {
        const answers = writeAnswersFile(northfieldAnswers({ gatekeepers: [] }));
        const tampered = await run(process.execPath, [cli, "--config", answers.path, "--release-dir", broken, "--trust", trust, "--yes"], {
          cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: freshBridge.url, CLOUDFLARE_API_TOKEN: freshBridge.token },
        });
        expect(tampered.code).toBe(1);
        expect(tampered.stderr).toContain("does not match its manifest digest");
        expect(fresh.worker("educateos-northfield-workshop-backend")).toBeUndefined();
      } finally {
        await freshBridge.close();
      }
    } finally {
      await bridge.close();
    }
  });
});

describe("the npm package", () => {
  it("packs to a tarball that npx runs: --help, and a plan against a fake account", async () => {
    // Stage the package as npm would publish it: package.json, README, LICENSE and the bundle.
    const stage = mkdtempSync(join(tmpdir(), "launch-pack-"));
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Record<string, unknown>;
    delete manifest.scripts; // prepack bundles; here the bundle is already built
    writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2));
    for (const file of ["README.md", "LICENSE"]) cpSync(join(PACKAGE, file), join(stage, file));
    mkdirSync(join(stage, "dist"));
    cpSync(cli, join(stage, "dist", "launch-educate-os.mjs"));

    const packed = await run("npm", ["pack", "--json", "--pack-destination", stage], { cwd: stage });
    expect(packed.code, packed.stderr).toBe(0);
    const [{ filename, files }] = JSON.parse(packed.stdout) as [{ filename: string; files: { path: string }[] }];
    expect(filename).toBe("launch-educate-os-0.1.0.tgz");
    expect(files.map((f) => f.path).toSorted()).toEqual(["LICENSE", "README.md", "dist/launch-educate-os.mjs", "package.json"]);

    const work = mkdtempSync(join(tmpdir(), "launch-npx-"));
    const cache = mkdtempSync(join(tmpdir(), "launch-npm-cache-"));
    const npxEnv = { npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
    // As an operator would run a downloaded tarball: `npx ./launch-educate-os-0.1.0.tgz`.
    cpSync(join(stage, filename), join(work, filename));
    const help = await run("npx", ["--yes", `./${filename}`, "--help"], { cwd: work, env: npxEnv });
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("install EducateOS into your own Cloudflare account");

    const { path } = writeAnswersFile(northfieldAnswers({ gatekeepers: [] }));
    const fake = accountFor(NORTHFIELD);
    const bridge = await serveCloudflare(fake);
    try {
      const plan = await run("npx", ["--yes", `./${filename}`, "plan", "--config", path, "--release-url", mirror.base, "--trust", trust], {
        cwd: work, env: { ...npxEnv, [TEST_CLOUDFLARE_RPC_ENV]: bridge.url, CLOUDFLARE_API_TOKEN: bridge.token },
      });
      expect(plan.code, plan.stderr).toBe(0);
      expect(plan.stdout).toContain("Preflight: ready.");
      expect(plan.stdout).toContain("Plan only: nothing was changed.");
      expect(fake.calls.every((call) => !call.mutation)).toBe(true);
    } finally {
      await bridge.close();
    }
  });
});
