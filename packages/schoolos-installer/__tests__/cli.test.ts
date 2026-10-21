import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { configFor, goldenRelease, NORTHFIELD, signRelease, type TestRelease } from "./support.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../../scripts/release/testdata/golden-manifest.json", import.meta.url));

function writeConfig(config: unknown, signedManifest?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "schoolos-installer-"));
  writeFileSync(join(dir, "install.json"), JSON.stringify(config));
  if (signedManifest !== undefined) writeFileSync(join(dir, "manifest.signed.json"), JSON.stringify(signedManifest));
  return { config: join(dir, "install.json"), signed: join(dir, "manifest.signed.json") };
}

function insecureConfig(release: TestRelease, manifestSha256 = release.sha256) {
  const config = configFor(NORTHFIELD, release);
  return { ...config, release: { mode: "insecure-pin", releaseId: config.release.releaseId, version: config.release.version, manifestSha256 } };
}

async function run(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("district-run CLI", () => {
  it("prints usage for a missing command", async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("reports a missing token as a preflight finding without contacting Cloudflare", async () => {
    const release = await goldenRelease();
    const { config, signed } = writeConfig(configFor(NORTHFIELD, release), release.signedManifest);

    const result = await run(["preflight", "--config", config, "--manifest", MANIFEST, "--signed-manifest", signed]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("BLOCKING credential.rejected");
    expect(result.stdout).toContain("preflight: blocked");
  });

  it("reads the signed statement from beside the manifest by default, as the release pipeline lays it out", async () => {
    const release = await goldenRelease();
    const { config } = writeConfig(configFor(NORTHFIELD, release));
    const dir = mkdtempSync(join(tmpdir(), "schoolos-release-"));
    writeFileSync(join(dir, "manifest.json"), release.bytes);
    writeFileSync(join(dir, "manifest.signed.json"), JSON.stringify(release.signedManifest));

    const result = await run(["preflight", "--config", config, "--manifest", join(dir, "manifest.json")]);

    // Verified, so it got as far as asking Cloudflare, which needs the (absent) token.
    expect(result.stdout).toContain("BLOCKING credential.rejected");
  });

  it("requires the root's signed manifest statement for a signed pin", async () => {
    const release = await goldenRelease();
    const { config } = writeConfig(configFor(NORTHFIELD, release));

    const result = await run(["plan", "--config", config, "--manifest", MANIFEST]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--signed-manifest <file> is required");
  });

  it("refuses a manifest whose signed statement names different bytes", async () => {
    const release = await goldenRelease();
    const { config, signed } = writeConfig(configFor(NORTHFIELD, release), await signRelease(release.manifest.releaseId, "0.1.0", "0".repeat(64)));

    const result = await run(["plan", "--config", config, "--manifest", MANIFEST, "--signed-manifest", signed], { CLOUDFLARE_API_TOKEN: "synthetic-cli-token" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("validation-failed: release manifest does not match the signed SHA-256");
    expect(result.stdout + result.stderr).not.toContain("synthetic-cli-token");
  });

  it("accepts a digest-only development pin only with --insecure-pin, and still checks the digest", async () => {
    const release = await goldenRelease();
    const unflagged = await run(["preflight", "--config", writeConfig(insecureConfig(release)).config, "--manifest", MANIFEST]);
    expect(unflagged.code).toBe(2);
    expect(unflagged.stderr).toContain("pass --insecure-pin");

    const flagged = await run(["preflight", "--insecure-pin", "--config", writeConfig(insecureConfig(release)).config, "--manifest", MANIFEST]);
    expect(flagged.stdout).toContain("preflight: blocked");

    const mismatched = writeConfig(insecureConfig(release, "0".repeat(64))).config;
    const refused = await run(["plan", "--insecure-pin", "--config", mismatched, "--manifest", MANIFEST], { CLOUDFLARE_API_TOKEN: "synthetic-cli-token" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("validation-failed: release manifest does not match the pinned SHA-256");
  });
});
