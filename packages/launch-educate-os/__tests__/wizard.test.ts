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

async function world(school = false, account: Parameters<typeof accountFor>[1] = {}) {
  const release = await deriveRelease(await goldenRelease(), "r000001-aaaaaaa", (manifest) => {
    if (!school) return;
    const variants = manifest.workers.router!.assetsConfig!.variants;
    variants["access-school"] = variants.access!;
    variants["access-school-ai"] = variants["access-ai"]!;
    delete variants.access;
    delete variants["access-ai"];
    manifest.workers["workshop-backend"]!.bindings.push(
      { type: "service", name: "PRINCIPAL_RESOLVER", service: "$WORKER_NAME(educateos-district-worker)", entrypoint: "DistrictPrincipalResolver" },
      { type: "service", name: "WORKSHOP_CAPABILITY_POLICY", service: "$WORKER_NAME(educateos-district-worker)", entrypoint: "DistrictWorkshopCapabilityPolicy" },
    );
  });
  const mirror: ReleaseServer = await serveReleases(release);
  const cloudflare: CloudflareBridge = await serveCloudflare(accountFor(NORTHFIELD, account));
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
  it("collects both required school services and reaches preflight without offering Workshop-only installation", async () => {
    const { mirror, cloudflare, trust } = await world(true);
    const dir = tempDir();
    const districtConfig = join(dir, "district.json");
    const mcpConfig = join(dir, "mcp.json");
    writeFileSync(districtConfig, JSON.stringify({ synthetic: "private district configuration" }));
    writeFileSync(mcpConfig, JSON.stringify({ synthetic: "private MCP configuration" }));

    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      cloudflare.token,
      "", // subdomain
      "", // short name
      "", // email domains
      "", // individual emails
      "it@northfield.example",
      "n", // the operator's own configuration files
      districtConfig,
      mcpConfig,
      "n", // no OSS admin
      "", // AI Gateway
      "n", // preflight and plan only
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Preflight: ready.");
    expect(result.stdout).not.toContain("Install the district LMS too?");
    expect(result.stdout).not.toContain("Workshop alone");
    for (const value of [cloudflare.token, "private district configuration", "private MCP configuration"]) {
      expect(result.stdout).not.toContain(value);
    }
    const saved = JSON.parse(readFileSync(join(dir, "educateos-install.json"), "utf8"));
    expect(saved.install.services).toEqual({
      "educateos-district-worker": { enabled: true, vars: { DISTRICT_CONFIG: JSON.stringify({ synthetic: "private district configuration" }) } },
      "educateos-external-mcp": { enabled: true, vars: { MCP_CONFIG: JSON.stringify({ synthetic: "private MCP configuration" }) } },
    });
    expect(cloudflare.fake.serving("educateos.northfield.example")).toBeUndefined();
  });

  it("offers Google or Microsoft sign-in, with the dashboard link, when the team has only Cloudflare-account login and codes", async () => {
    const { mirror, cloudflare, trust } = await world(false, {
      identityProviders: [{ name: "Cloudflare", type: "cloudflare" }, { name: "One-time PIN", type: "onetimepin" }],
    });
    const dir = tempDir();
    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      cloudflare.token,
      "", // subdomain
      "", // short name
      "2", // Microsoft Entra ID
      "", // Enter once added (it isn't, in this account)
      "", // asked again: the default keeps one-time codes for a pilot
      "", // email domains
      "", // individual emails
      "it@northfield.example",
      "n", // no district LMS
      "n", // no OSS admin
      "", // AI Gateway
      "n", // preflight and plan only
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("The team's only login method is one-time email codes.");
    expect(result.stdout).toContain("  1) Google Workspace\n  2) Microsoft Entra ID\n  3) Not now: keep one-time codes for a pilot\nChoose a number [3]");
    expect(result.stdout).toContain(`Add Microsoft Entra ID in Zero Trust: https://one.dash.cloudflare.com/${JSON.parse(readFileSync(join(dir, "educateos-install.json"), "utf8")).install.accountId}/settings/authentication`);
    expect(result.stdout).toContain("idp-integration/entra-id/");
    expect(result.stdout).toContain("Zero Trust doesn't list it yet.");
    expect(result.stdout).toContain("access.idp-pin-only");
  });

  it("doesn't offer sign-in when the team already has the district's own", async () => {
    const { mirror, cloudflare, trust } = await world(false);
    const dir = tempDir();
    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust],
      [cloudflare.token, "", "", "", "", "it@northfield.example", "n", "n", "", "n"],
      { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Add your district's sign-in now?");
  });

  it("installs a one-origin district from its answers, saves them without the token, and prints the URLs", async () => {
    const { mirror, cloudflare, trust } = await world();
    const dir = tempDir();
    const answersPath = join(dir, "educateos-install.json");

    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      cloudflare.token, // the API token, typed hidden
      "", // subdomain: educateos
      "", // short name: northfield
      "", // email domains: northfield.example
      "", // no individual emails
      "it@northfield.example", // administrators
      "y", // the district LMS
      "", // its starting configuration, written from answers
      "", // district name: Northfield
      "America/Chicago", // time zone
      "", // the administrator's name: It
      "y", // the OSS admin
      "", // AI Gateway: yes
      "", // apply: yes
      "n", // connect the LMS and roster: later
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workers Paid");
    expect(result.stdout).toContain("https://dash.cloudflare.com/profile/api-tokens?");
    expect(result.stdout).toContain("Zero Trust team: northfield (found in the account)");
    expect(result.stdout).toContain("Preflight: ready.");
    expect(result.stdout).toMatch(/Apply these \d+ change\(s\) to your account\?/);
    expect(result.stdout).toContain("District (LMS)   https://educateos.northfield.example/");
    expect(result.stdout).toContain("MCP server       https://educateos.northfield.example/mcp");
    expect(result.stdout).toContain("MCP management   https://educateos.northfield.example/admin/#/mcp");
    expect(result.stdout).toContain("AI Workshop      https://educateos.northfield.example/ai/");
    expect(result.stdout).toContain("OSS admin        https://admin.northfield.example/");
    expect(result.stdout).toContain("Delete the Cloudflare API token");
    expect(result.stdout).toContain("Connect your LMS and roster now? [Y/n]");
    expect(result.stdout).toContain("Later: `npx launch-educate-os connect`.");
    expect(result.stdout).not.toContain(cloudflare.token);
    expect(cloudflare.fake.serving("educateos.northfield.example")?.releaseId).toBe("r000001-aaaaaaa");
    // A new install keeps its storage in Cloudflare's US jurisdiction (ADR-0015).
    expect(result.stdout).toContain("data location  Cloudflare's US jurisdiction");
    expect(cloudflare.fake.worker("educateos-northfield-educateos-district-worker")?.bindings)
      .toContainEqual({ type: "plain_text", name: "DATA_JURISDICTION", text: "us" });
    expect(cloudflare.fake.d1Jurisdiction("educateos-northfield-admin-db")).toBe("us");
    // The district's configuration was written from the answers (SCHO-441, SCHO-442): its first
    // administrator is created on first sign-in, and the Workshop knows them as an admin.
    const districtVar = cloudflare.fake.worker("educateos-northfield-educateos-district-worker")?.bindings
      .find((b) => b.name === "DISTRICT_CONFIG") as { text: string } | undefined;
    const written = JSON.parse(districtVar!.text);
    expect(written.directory.district).toEqual({
      id: "dst_northfield", name: "Northfield", timeZone: "America/Chicago", trustedIssuers: ["https://northfield.cloudflareaccess.com"],
    });
    expect(written.bootstrapAdmins).toEqual([{ principalId: "prn_northfield-admin-1", displayName: "It", email: "it@northfield.example" }]);
    expect(written.workshopPolicy.workspaceActions).toEqual([{ kind: "staff", actions: expect.arrayContaining(["workspace.create.query", "agent.execute"]) }]);
    expect(cloudflare.fake.worker("educateos-northfield-workshop-backend")?.bindings.find((b) => b.name === "ADMINS"))
      .toMatchObject({ type: "json", json: ["it@northfield.example", "principal:prn_northfield-admin-1"] });

    const saved = readFileSync(answersPath, "utf8");
    expect(saved).not.toContain(cloudflare.token);
    expect(JSON.parse(saved)).toMatchObject({
      format: "launch-educate-os/1",
      install: { instanceId: "ins_northfield", baseDomain: "northfield.example", subdomain: "educateos", admin: { enabled: true }, dataJurisdiction: "us" },
      history: [{ releaseId: "r000001-aaaaaaa", action: "install" }],
    });

    // A re-run reuses the answers and finds nothing to change.
    const again = await onTerminal(["--release-url", mirror.base, "--trust", trust], [cloudflare.token, "", "", "y", "3", "n"], {
      cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url },
    });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Reuse these answers?");
    expect(again.stdout).toContain("Plan: nothing to change");
    // This time the operator takes the offer and picks Schoology, which the menu says isn't available.
    expect(again.stdout).toContain("What should the district connect?");
    expect(again.stdout).toContain("3) Schoology         LMS      (not available yet)");
    expect(again.stdout).toContain("Schoology isn't available yet.");
  });

  it("supports LMS-lite + MCP-only installation when the school declines AI Workshop", async () => {
    const { mirror, cloudflare, trust } = await world();
    const dir = tempDir();
    const answersPath = join(dir, "educateos-install.json");

    const result = await onTerminal(["--release-url", mirror.base, "--trust", trust], [
      cloudflare.token,
      "", // subdomain: educateos
      "", // short name: northfield
      "", // email domains: northfield.example
      "", // no individual emails
      "it@northfield.example", // administrators
      "y", // the district LMS
      "", // starting config written from answers
      "", // district name: Northfield
      "America/Chicago", // time zone
      "", // administrator name
      "n", // no OSS admin
      "n", // decline AI Workshop / AI Gateway -> LMS-lite + MCP only
      "", // apply: yes
      "n", // connect roster later
    ], { cwd: dir, env: { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url } });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MCP server       https://educateos.northfield.example/mcp");
    expect(result.stdout).toContain("MCP management   https://educateos.northfield.example/admin/#/mcp");
    const saved = JSON.parse(readFileSync(answersPath, "utf8"));
    expect(saved.install.ai).toEqual({ enabled: false, providers: [] });
    const districtVar = cloudflare.fake.worker("educateos-northfield-educateos-district-worker")?.bindings
      .find((b) => b.name === "DISTRICT_CONFIG") as { text: string } | undefined;
    expect(JSON.parse(districtVar!.text).mcp).toEqual({
      mode: "builtin",
      origin: "https://educateos.northfield.example",
      allowDrafts: true,
    });
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
