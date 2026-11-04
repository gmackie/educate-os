// The wizard on a scripted terminal: the CLI runs in process with a TTY-like stdin fed the
// operator's answers, against the installer's Cloudflare fake and a local release mirror.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { TEST_CLOUDFLARE_RPC_ENV } from "../src/cloudflare.ts";
import {
  accountFor,
  type CloudflareBridge,
  deriveRelease,
  goldenRelease,
  NORTHFIELD,
  northfieldAnswers,
  type ReleaseServer,
  serveCloudflare,
  serveReleases,
  tempDir,
  writeAnswersFile,
  writeTrustFile,
} from "./harness.ts";

const closing: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((c) => c.close()));
});

async function world() {
  const release = await deriveRelease(await goldenRelease(), "r000001-aaaaaaa");
  const mirror: ReleaseServer = await serveReleases(release);
  const cloudflare: CloudflareBridge = await serveCloudflare(accountFor(NORTHFIELD));
  closing.push(mirror, cloudflare);
  return { release, mirror, cloudflare, trust: writeTrustFile() };
}

/** Runs the CLI with `answers` typed, one per line, on a terminal. */
async function onTerminal(args: string[], answers: string[], options: { cwd: string; env: Record<string, string> }) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  stdin.end(answers.map((answer) => `${answer}\n`).join(""));
  let stdout = "";
  let stderr = "";
  const code = await main({
    argv: args,
    env: options.env,
    cwd: options.cwd,
    stdin,
    stdout: { isTTY: true, write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

describe("the wizard", () => {
  it("installs a one-origin district from its answers, saves them without the token, and prints the URLs", async () => {
    const { mirror, cloudflare, trust } = await world();
    const dir = tempDir();
    const districtConfig = join(dir, "district.json");
    writeFileSync(districtConfig, JSON.stringify({ synthetic: "the district's own config, opaque to the installer" }));
    const answersPath = join(dir, "educateos-install.json");

    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      cloudflare.token, // the API token, typed hidden
      "", // subdomain: educateos
      "", // short name: northfield
      "", // email domains: northfield.example
      "", // no individual emails
      "it@northfield.example", // administrators
      "y", // the district LMS
      districtConfig,
      "y", // the OSS admin
      "", // AI Gateway: yes
      "", // apply: yes
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workers Paid");
    expect(result.stdout).toContain("https://dash.cloudflare.com/profile/api-tokens?");
    expect(result.stdout).toContain("Zero Trust team: northfield (found in the account)");
    expect(result.stdout).toContain("Preflight: ready.");
    expect(result.stdout).toMatch(/Apply these \d+ change\(s\) to your account\?/);
    expect(result.stdout).toContain("District (LMS)   https://educateos.northfield.example/");
    expect(result.stdout).toContain("AI Workshop      https://educateos.northfield.example/ai/");
    expect(result.stdout).toContain("OSS admin        https://admin.northfield.example/");
    expect(result.stdout).toContain("Delete the Cloudflare API token");
    expect(result.stdout).not.toContain(cloudflare.token);
    expect(cloudflare.fake.serving("educateos.northfield.example")?.releaseId).toBe("r000001-aaaaaaa");

    const saved = readFileSync(answersPath, "utf8");
    expect(saved).not.toContain(cloudflare.token);
    expect(JSON.parse(saved)).toMatchObject({
      format: "launch-educate-os/1",
      install: { instanceId: "ins_northfield", baseDomain: "northfield.example", subdomain: "educateos", admin: { enabled: true } },
      history: [{ releaseId: "r000001-aaaaaaa", action: "install" }],
    });

    // A re-run reuses the answers and finds nothing to change.
    const again = await onTerminal(["--release-url", mirror.base, "--trust", trust], [cloudflare.token, "", ""], {
      cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url },
    });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Reuse these answers?");
    expect(again.stdout).toContain("Plan: nothing to change");
  });

  it("asks again for a refused token, and asks, hidden, for the secrets the release needs", async () => {
    const { mirror, cloudflare, trust } = await world();
    const { dir } = writeAnswersFile(northfieldAnswers());
    const wrong = "w".repeat(40);
    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      wrong,
      cloudflare.token,
      "", // reuse the saved answers
      "typed-google-client-id-123",
      "typed-google-client-secret-456",
      "y",
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cloudflare refused the token");
    expect(result.stdout).toContain("gatekeeper-google:");
    expect(result.stdout).toContain("CLIENT_SECRET (input hidden)");
    for (const secret of [wrong, cloudflare.token, "typed-google-client-id-123", "typed-google-client-secret-456"]) {
      expect(result.stdout).not.toContain(secret);
    }
    expect(cloudflare.fake.worker("educateos-northfield-gatekeeper-google")?.secretNames).toEqual(["CLIENT_ID", "CLIENT_SECRET"]);
  });

  it("stops before changing anything when the operator declines the plan", async () => {
    const { mirror, cloudflare, trust } = await world();
    const { dir } = writeAnswersFile(northfieldAnswers({ gatekeepers: [] }));
    const before = JSON.stringify(cloudflare.fake.inventory());
    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [cloudflare.token, "", "n"], {
      cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Nothing was changed.");
    expect(JSON.stringify(cloudflare.fake.inventory())).toBe(before);
  });

  it("refuses to guess without a terminal or an answers file", async () => {
    const dir = tempDir();
    let stderr = "";
    const code = await main({
      argv: ["--release-dir", dir], env: {}, cwd: dir, stdin: new PassThrough(),
      stdout: { write: () => true }, stderr: { write: (text: string) => (stderr += text) },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("no terminal to ask on");
  });
});
