import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { configFor, goldenRelease, NORTHFIELD } from "./support.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../../scripts/release/testdata/golden-manifest.json", import.meta.url));

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
    const dir = mkdtempSync(join(tmpdir(), "schoolos-installer-"));
    const config = join(dir, "install.json");
    writeFileSync(config, JSON.stringify(configFor(NORTHFIELD, release)));

    const result = await run(["preflight", "--config", config, "--manifest", MANIFEST]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("BLOCKING credential.rejected");
    expect(result.stdout).toContain("preflight: blocked");
  });

  it("refuses a manifest that does not match the pinned digest", async () => {
    const release = await goldenRelease();
    const dir = mkdtempSync(join(tmpdir(), "schoolos-installer-"));
    const config = join(dir, "install.json");
    const pinned = configFor(NORTHFIELD, release);
    writeFileSync(config, JSON.stringify({ ...pinned, release: { ...pinned.release, manifestSha256: "0".repeat(64) } }));

    const result = await run(["plan", "--config", config, "--manifest", MANIFEST], { CLOUDFLARE_API_TOKEN: "synthetic-cli-token" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("validation-failed: release manifest does not match the pinned SHA-256");
    expect(result.stdout + result.stderr).not.toContain("synthetic-cli-token");
  });
});
