// `launch-educate-os uninstall` (SCHO-368): district offboarding from the answers file, in process
// against the installer's Cloudflare fake and a local release mirror. It plans by default, deletes
// only once the operator types the instance ID, and never on --yes alone. Not yet run against a
// live account (SCHO-378).
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { TEST_CLOUDFLARE_RPC_ENV } from "../src/cloudflare.ts";
import {
  accountFor,
  deriveRelease,
  goldenRelease,
  GOOGLE_SECRETS,
  NORTHFIELD,
  northfieldAnswers,
  serveCloudflare,
  serveReleases,
  writeAnswersFile,
  writeTrustFile,
} from "./harness.ts";

const closing: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((c) => c.close()));
});

async function cli(argv: string[], options: { cwd: string; env: Record<string, string>; typed?: string[] }) {
  const terminal = options.typed !== undefined;
  const stdin = Object.assign(new PassThrough(), { isTTY: terminal });
  stdin.end((options.typed ?? []).map((line) => `${line}\n`).join(""));
  let stdout = "";
  let stderr = "";
  const code = await main({
    argv, env: options.env, cwd: options.cwd, stdin,
    stdout: { isTTY: terminal, write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

/** Northfield installed from an answers file, ready to uninstall. */
async function installedWorld() {
  const release = await deriveRelease(await goldenRelease(), "r000001-aaaaaaa");
  const mirror = await serveReleases(release);
  const cloudflare = await serveCloudflare(accountFor(NORTHFIELD));
  closing.push(mirror, cloudflare);
  const { dir, path } = writeAnswersFile(northfieldAnswers());
  const env = { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url, CLOUDFLARE_API_TOKEN: cloudflare.token, ...GOOGLE_SECRETS };
  const common = ["--config", path, "--release-url", mirror.base, "--trust", writeTrustFile()];
  const installed = await cli(["install", ...common, "--yes"], { cwd: dir, env });
  expect(installed.code, installed.stderr).toBe(0);
  return { fake: cloudflare.fake, dir, env, common };
}

describe("launch-educate-os uninstall", () => {
  it("plans by default, refuses --yes or a wrong ID, and deletes everything with --confirm <instanceId>", async () => {
    const { fake, dir, env, common } = await installedWorld();
    const before = JSON.stringify(fake.inventory());

    const planned = await cli(["uninstall", ...common], { cwd: dir, env });
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stdout).toContain("Export the district first");
    expect(planned.stdout).toContain("delete  worker:educateos-northfield-router");
    expect(planned.stdout).toContain("plan only; nothing was changed. To delete all of the above, run again with --confirm ins_northfield");
    expect((await cli(["uninstall", ...common, "--yes"], { cwd: dir, env })).code).toBe(0);
    const wrong = await cli(["uninstall", ...common, "--confirm", "northfield"], { cwd: dir, env });
    expect(wrong.code).toBe(2);
    expect(wrong.stdout).toContain("refused: the confirmation must be the instance ID, ins_northfield");
    expect(JSON.stringify(fake.inventory())).toBe(before);

    const json = await cli(["uninstall", ...common, "--confirm", "ins_northfield", "--json"], { cwd: dir, env });
    expect(json.code, json.stderr).toBe(0);
    const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
    expect(events.map((e) => e.event).filter((e) => e !== "step")).toEqual(["release", "uninstall-plan", "done"]);
    expect(events.at(-1)).toMatchObject({ event: "done", status: "removed", nextSteps: [] });
    expect(Object.values(fake.inventory()).every((n) => n === 0)).toBe(true);
    expect(json.stdout + json.stderr).not.toContain(env.CLOUDFLARE_API_TOKEN);
  });

  it("on a terminal, asks for the instance ID and stops on a blank answer", async () => {
    const { fake, dir, env, common } = await installedWorld();
    const before = JSON.stringify(fake.inventory());

    const stopped = await cli(["uninstall", ...common], { cwd: dir, env, typed: [""] });
    expect(stopped.code).toBe(1);
    expect(stopped.stdout).toContain("Type the instance ID (ins_northfield) to delete");
    expect(stopped.stdout).toContain("Nothing was changed.");
    expect(JSON.stringify(fake.inventory())).toBe(before);

    const removed = await cli(["uninstall", ...common], { cwd: dir, env, typed: ["ins_northfield"] });
    expect(removed.code, removed.stdout).toBe(0);
    expect(removed.stdout).toContain("uninstalled; nothing of the instance is left");
    expect(Object.values(fake.inventory()).every((n) => n === 0)).toBe(true);
  });
});
