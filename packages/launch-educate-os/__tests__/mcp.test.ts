// `launch-educate-os mcp` in process: the answers file on disk, the installer's Cloudflare fake behind
// the loopback bridge, and a scripted fetch standing in for the district's /mcp, its authorization
// server and outside MCP servers. Nothing reaches the network.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readAnswers } from "../src/answers.ts";
import { main } from "../src/cli.ts";
import { TEST_CLOUDFLARE_RPC_ENV } from "../src/cloudflare.ts";
import { accountFor, NORTHFIELD, northfieldAnswers, serveCloudflare, writeAnswersFile } from "./harness.ts";

const closing: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((c) => c.close()));
});

const ORIGIN = "https://educateos.northfield.example";
const RESOURCE = `${ORIGIN}/mcp`;
const ISSUER = "https://id.northfield.example";

/** A synthetic DISTRICT_CONFIG: only the fields the launcher reads are realistic. */
function districtConfig(overrides: Record<string, unknown> = {}) {
  return {
    directory: { district: { id: "district:northfield", name: "Northfield", trustedIssuers: [ISSUER] } },
    mcp: { origin: ORIGIN, issuer: ISSUER, jwksUri: `${ISSUER}/jwks`, algorithms: ["ES256"] },
    workshopPolicy: { personalCreation: false, personalBlueprints: [], classBlueprints: [], models: [], connectors: [] },
    ...overrides,
  };
}

function oneOriginAnswers(config: unknown, overrides: Record<string, unknown> = {}) {
  return northfieldAnswers({
    gatekeepers: [],
    services: { "educateos-district-worker": { enabled: true, vars: { DISTRICT_CONFIG: JSON.stringify(config, null, 2) } } },
    ...overrides,
  });
}

type Route = (init: RequestInit | undefined) => Response;

/** A fetch that answers only the given URLs; anything else is unreachable. */
function scriptedFetch(routes: Record<string, Route>) {
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("manual");
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route(init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The district's endpoint switched on, with an authorization server that lets clients register. */
function liveDistrict(asMetadata: Record<string, unknown> | null = {}) {
  const routes: Record<string, Route> = {
    [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: () => json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["mcp:tools"] }),
    [RESOURCE]: () => new Response(null, {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"` },
    }),
  };
  if (asMetadata !== null) {
    routes[`${ISSUER}/.well-known/oauth-authorization-server`] = () => json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`, code_challenge_methods_supported: ["S256"], ...asMetadata,
    });
  }
  return routes;
}

async function run(args: string[], options: { cwd: string; env?: Record<string, string>; fetch?: typeof fetch; terminal?: string[] }) {
  const stdin = Object.assign(new PassThrough(), { isTTY: options.terminal !== undefined });
  stdin.end((options.terminal ?? []).map((line) => `${line}\n`).join(""));
  let stdout = "";
  let stderr = "";
  const code = await main({
    argv: args,
    env: options.env ?? {},
    cwd: options.cwd,
    stdin,
    stdout: { isTTY: options.terminal !== undefined, write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { code, stdout, stderr };
}

function events(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("mcp: usage", () => {
  it("prints its help, and refuses unknown subcommands, clients and connectors", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const help = await run(["mcp", "--help"], { cwd: dir });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("npx launch-educate-os mcp clients");
    expect((await run(["mcp"], { cwd: dir })).code).toBe(2);
    expect((await run(["mcp", "bogus"], { cwd: dir })).code).toBe(2);
    expect((await run(["mcp", "clients", "--client", "nope"], { cwd: dir })).code).toBe(2);
    expect((await run(["mcp", "add", "--connector", "zapier"], { cwd: dir })).code).toBe(2);
    expect((await run(["mcp", "status", "--bogus"], { cwd: dir })).code).toBe(2);
    // The top-level help names the command.
    expect((await run(["--help"], { cwd: dir })).stdout).toContain("npx launch-educate-os mcp");
  });

  it("needs the answers file for status and add", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const result = await run(["mcp", "status", "--config", "missing.json"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/needs the answers file/);
  });
});

describe("mcp status", () => {
  it("reports a Workshop-only install offline: no district endpoint, no MCP connectors", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const result = await run(["mcp", "status", "--offline"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`EducateOS at ${ORIGIN}`);
    expect(result.stdout).toContain("no district service");
    expect(result.stdout).toContain("MCP Server (gatekeeper-mcp): not in the answers' gatekeepers");
    expect(result.stdout).toContain(`${ORIGIN}/admin?tab=gatekeepers`);
    expect(result.stdout).toContain("is not set: the account's Workers are not checked");
  });

  it("checks the endpoint live and the connectors' Workers in the account, without printing the token", async () => {
    const cloudflare = await serveCloudflare(accountFor(NORTHFIELD));
    closing.push(cloudflare);
    cloudflare.fake.seedWorker("educateos-northfield-gatekeeper-mcp");
    cloudflare.fake.seedWorker("educateos-northfield-gatekeeper-mcp-portal", { MCP_ALLOW_INSECURE: "false" });
    const config = districtConfig({ workshopPolicy: { personalCreation: false, personalBlueprints: [], classBlueprints: [], models: [], connectors: [{ vendorId: "mcp", access: "all" }] } });
    const { dir } = writeAnswersFile(oneOriginAnswers(config, {
      gatekeepers: ["gatekeeper-mcp", "gatekeeper-mcp-portal"],
      gatekeeperInputs: { "gatekeeper-mcp-portal": { MCP_PORTAL_URL: "https://portal.northfield.example/mcp" } },
    }));
    const { fetchImpl, requests } = scriptedFetch(liveDistrict());
    const env = { CLOUDFLARE_API_TOKEN: cloudflare.token, [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url };
    const result = await run(["mcp", "status", "--json"], { cwd: dir, env, fetch: fetchImpl });
    const checks = events(result.stdout).filter((event) => event.event === "mcp");
    const status = (check: string, detail: RegExp) => checks.find((event) => event.check === check && detail.test(String(event.detail)))?.status;
    expect(status("endpoint", /on in DISTRICT_CONFIG/)).toBe("ok");
    expect(status("issuer", /which the district trusts/)).toBe("ok");
    expect(status("live", /metadata served/)).toBe("ok");
    expect(status("challenge", /401 naming the metadata/)).toBe("ok");
    expect(status("server", /Worker educateos-northfield-gatekeeper-mcp is installed/)).toBe("ok");
    expect(status("portal", /portal https:\/\/portal.northfield.example\/mcp \(sign-in oauth\) in the answers/)).toBe("ok");
    // The Worker predates the answers' URL: applying sets it.
    expect(status("portal", /MCP_PORTAL_URL is not set on the Worker.*mcp add --connector portal/)).toBe("warn");
    expect(status("policy", /district administrators may connect the MCP Server /)).toBe("ok");
    expect(status("policy", /no grant for "mcpportal"/)).toBe("warn");
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(cloudflare.token);
    // The live checks carry no credentials.
    expect(requests.every((request) => !request.headers.has("authorization") && !request.headers.has("cookie"))).toBe(true);
    expect(result.stderr).toContain(`${ORIGIN}/ai/admin?tab=gatekeepers`);
  });

  it("fails when the endpoint is on in the config but Cloudflare Access answers for it", async () => {
    const { dir } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl } = scriptedFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: () =>
        new Response(null, { status: 302, headers: { location: "https://northfield.cloudflareaccess.com/cdn-cgi/access/login/x" } }),
    });
    const result = await run(["mcp", "status"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL\s+live\s+Cloudflare Access answered.*applying the answers adds that bypass/);
    expect(result.stdout).toMatch(/WARN\s+policy\s+workshopPolicy.connectors has no grant for "mcp"/);
  });

  it("fails when the endpoint's issuer is not one the district trusts, and when it is off though configured", async () => {
    const { dir } = writeAnswersFile(oneOriginAnswers(districtConfig({ directory: { district: { trustedIssuers: ["https://other.example"] } } })));
    const { fetchImpl } = scriptedFetch({ [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: () => new Response(null, { status: 404 }) });
    const result = await run(["mcp", "status"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL\s+issuer\s+tokens come from https:\/\/id.northfield.example, which is not in the directory's trustedIssuers/);
    expect(result.stdout).toMatch(/FAIL\s+live\s+.*is 404 though DISTRICT_CONFIG turns it on/);
  });

  it("reports an endpoint that is off, as configured", async () => {
    const { mcp: _off, ...config } = districtConfig();
    const { dir } = writeAnswersFile(oneOriginAnswers(config));
    const { fetchImpl } = scriptedFetch({ [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: () => new Response(null, { status: 404 }) });
    const result = await run(["mcp", "status"], { cwd: dir, fetch: fetchImpl });
    expect(result.stdout).toMatch(/--\s+endpoint\s+off: DISTRICT_CONFIG has no "mcp" settings/);
    expect(result.stdout).toMatch(/ok\s+live\s+.*is 404, as configured/);
  });
});

describe("mcp clients", () => {
  it("prints the URL, the live sign-in checks and every client's steps, all labelled unproven", async () => {
    const { dir } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl } = scriptedFetch(liveDistrict());
    const result = await run(["mcp", "clients"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Your district's MCP endpoint: ${RESOURCE}`);
    expect(result.stdout).toMatch(/ok\s+sign-in\s+https:\/\/id.northfield.example: issuer matches, authorization and token endpoints, PKCE S256/);
    expect(result.stdout).toMatch(/ok\s+register\s+clients can register themselves \(dynamic client registration\)/);
    expect(result.stdout).toContain(`Remote MCP server URL: ${RESOURCE}`);
    expect(result.stdout).toContain(`claude mcp add --transport http educateos ${RESOURCE}`);
    expect(result.stdout).toContain(`"educateos": { "type": "http", "url": "${RESOURCE}" }`);
    expect(result.stdout).toContain("Students");
    expect(result.stdout).toContain("Built-in Cloudflare OAuth 2.1");
    expect(result.stdout).toContain("/admin/#/mcp");
  });

  it("shows one client with --client, and emits JSON events", async () => {
    const { dir } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl } = scriptedFetch(liveDistrict());
    const result = await run(["mcp", "clients", "--client", "vscode", "--json"], { cwd: dir, fetch: fetchImpl });
    const clients = events(result.stdout).filter((event) => event.event === "mcp-client");
    expect(clients.map((event) => event.id)).toEqual(["vscode"]);
    expect(clients[0]).toMatchObject({ url: RESOURCE, snippet: { file: ".vscode/mcp.json" } });
    expect(result.stderr).not.toContain("Cursor");
  });

  it("works from --url alone, and fails when the authorization server publishes no metadata", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const { fetchImpl } = scriptedFetch(liveDistrict(null));
    const result = await run(["mcp", "clients", "--url", RESOURCE, "--config", "none.json"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL\s+sign-in\s+https:\/\/id.northfield.example publishes no OAuth authorization server metadata/);
  });

  it("warns when clients can't register themselves", async () => {
    const { dir } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl } = scriptedFetch(liveDistrict({ registration_endpoint: undefined }));
    const result = await run(["mcp", "clients", "--client", "claude"], { cwd: dir, fetch: fetchImpl });
    expect(result.stdout).toMatch(/WARN\s+register\s+no dynamic client registration/);
  });

  it("refuses a --url the Workshop would never reach", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const result = await run(["mcp", "clients", "--url", "http://127.0.0.1/mcp"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/https:\/\/ MCP servers only/);
  });
});

describe("mcp add", () => {
  const SERVER = "https://mcp.library.example/mcp";
  const publicServer = () => scriptedFetch({
    [SERVER]: () => json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Library catalog", version: "1" }, capabilities: {} } }),
  });

  it("checks the server, then installs the MCP Server connector and grants it to district administrators", async () => {
    const { dir, path } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl, requests } = publicServer();
    const result = await run(["mcp", "add", "--server-url", SERVER, "--yes"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ok\s+server\s+answers without sign-in \(Library catalog\)/);
    expect(requests[0]).toMatchObject({ url: SERVER, method: "POST" });

    const saved = (await readAnswers(path))!;
    expect(saved.install.gatekeepers).toEqual(["gatekeeper-mcp"]);
    const services = saved.install.services as Record<string, { vars: { DISTRICT_CONFIG: string } }>;
    const district = JSON.parse(services["educateos-district-worker"]!.vars.DISTRICT_CONFIG);
    expect(district.workshopPolicy.connectors).toEqual([{ vendorId: "mcp", access: "all" }]);
    // Everything else in DISTRICT_CONFIG is kept as it was.
    expect(district.mcp).toEqual(districtConfig().mcp);
    expect(result.stdout).toContain(`${ORIGIN}/ai/gatekeepers`);
    expect(result.stdout).toContain("npx launch-educate-os plan --config");

    // A second run has nothing to change.
    const again = await run(["mcp", "add", "--offline", "--yes"], { cwd: dir });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("None: the answers already install the MCP Server connector and grant it.");
  });

  it("changes nothing without --yes and no terminal", async () => {
    const { dir, path } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const before = readFileSync(path, "utf8");
    const result = await run(["mcp", "add", "--offline", "--json"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(events(result.stdout).filter((event) => event.event === "mcp-change").every((event) => event.saved === false)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("asks on a terminal, and saves on yes", async () => {
    const { dir, path } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const { fetchImpl } = publicServer();
    const result = await run(["mcp", "add"], { cwd: dir, fetch: fetchImpl, terminal: [SERVER, "y"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MCP server address to check (blank to skip)");
    expect((await readAnswers(path))!.install.gatekeepers).toEqual(["gatekeeper-mcp"]);
  });

  it("follows a 401 to the server's authorization server, and fails one the connector can't register with", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const { fetchImpl } = scriptedFetch({
      [SERVER]: () => new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.library.example/.well-known/oauth-protected-resource/mcp"` } }),
      "https://mcp.library.example/.well-known/oauth-protected-resource/mcp": () => json({ resource: SERVER, authorization_servers: ["https://auth.library.example"] }),
      "https://auth.library.example/.well-known/oauth-authorization-server": () => json({
        issuer: "https://auth.library.example", authorization_endpoint: "https://auth.library.example/a", token_endpoint: "https://auth.library.example/t",
        code_challenge_methods_supported: ["S256"],
      }),
    });
    const result = await run(["mcp", "add", "--server-url", SERVER, "--yes"], { cwd: dir, fetch: fetchImpl });
    expect(result.stdout).toMatch(/ok\s+server\s+asks for sign-in at https:\/\/auth.library.example/);
    expect(result.stdout).toMatch(/FAIL\s+register\s+no dynamic client registration/);
    expect(result.code).toBe(1);
    // A Workshop-only install has no district policy to change: only the gatekeeper is added.
    expect(result.stdout).toContain('+ gatekeepers: add "gatekeeper-mcp"');
    expect(result.stdout).not.toContain("workshopPolicy.connectors: add");
  });

  it("leaves a missing workshopPolicy alone and says why", async () => {
    const { workshopPolicy: _none, ...config } = districtConfig();
    const { dir, path } = writeAnswersFile(oneOriginAnswers(config));
    const result = await run(["mcp", "add", "--offline", "--yes"], { cwd: dir });
    expect(result.stdout).toMatch(/WARN\s+policy\s+DISTRICT_CONFIG has no workshopPolicy/);
    const services = (await readAnswers(path))!.install.services as Record<string, { vars: { DISTRICT_CONFIG: string } }>;
    expect(JSON.parse(services["educateos-district-worker"]!.vars.DISTRICT_CONFIG).workshopPolicy).toBeUndefined();
  });

  it("refuses an address the Workshop would refuse, before any request", async () => {
    const { dir } = writeAnswersFile(northfieldAnswers());
    const { fetchImpl, requests } = scriptedFetch({});
    const result = await run(["mcp", "add", "--server-url", "https://169.254.169.254/mcp", "--yes"], { cwd: dir, fetch: fetchImpl });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refuses private, loopback and metadata hosts/);
    expect(requests).toEqual([]);
  });
});

describe("mcp add --connector portal", () => {
  const PORTAL = "https://portal.northfield.example/mcp";
  const portalInputs = async (path: string) =>
    ((await readAnswers(path))!.install.gatekeeperInputs as Record<string, Record<string, string>> | undefined)?.["gatekeeper-mcp-portal"];

  it("writes the portal's URL, name and sign-in, installs the connector and grants it", async () => {
    const { dir, path } = writeAnswersFile(oneOriginAnswers(districtConfig()));
    const result = await run(["mcp", "add", "--connector", "portal", "--portal-url", PORTAL, "--portal-name", "Northfield tools", "--portal-auth", "oauth", "--yes"], { cwd: dir });
    expect(result.code).toBe(0);
    const saved = (await readAnswers(path))!;
    expect(saved.install.gatekeepers).toEqual(["gatekeeper-mcp-portal"]);
    expect(await portalInputs(path)).toEqual({ MCP_PORTAL_URL: PORTAL, MCP_PORTAL_NAME: "Northfield tools", MCP_PORTAL_AUTH: "oauth" });
    const services = saved.install.services as Record<string, { vars: { DISTRICT_CONFIG: string } }>;
    expect(JSON.parse(services["educateos-district-worker"]!.vars.DISTRICT_CONFIG).workshopPolicy.connectors).toEqual([{ vendorId: "mcpportal", access: "all" }]);
    expect(result.stdout).toContain("choose Northfield tools");
    expect(result.stdout).not.toContain("SCHO-409");

    // A second run has nothing to change; a new URL changes only the URL and keeps the rest.
    expect((await run(["mcp", "add", "--connector", "portal", "--portal-url", PORTAL, "--yes"], { cwd: dir })).stdout)
      .toContain("None: the answers already install this portal and grant it.");
    const moved = await run(["mcp", "add", "--connector", "portal", "--portal-url", "https://tools.northfield.example/mcp", "--yes"], { cwd: dir });
    expect(moved.stdout).toContain(`MCP_PORTAL_URL: change from "${PORTAL}" to "https://tools.northfield.example/mcp"`);
    expect(await portalInputs(path)).toEqual({ MCP_PORTAL_URL: "https://tools.northfield.example/mcp", MCP_PORTAL_NAME: "Northfield tools", MCP_PORTAL_AUTH: "oauth" });

    const status = await run(["mcp", "status", "--offline"], { cwd: dir });
    expect(status.stdout).toMatch(/ok\s+portal\s+portal https:\/\/tools.northfield.example\/mcp \("Northfield tools", sign-in oauth\)/);
    expect(status.stdout).toMatch(/ok\s+policy\s+district administrators may connect the MCP Server Portal/);
  });

  it("keeps the token out of the answers and names the variable the apply reads it from", async () => {
    const { dir, path } = writeAnswersFile(northfieldAnswers());
    const result = await run(["mcp", "add", "--connector", "portal", "--portal-url", PORTAL, "--portal-auth", "token", "--yes", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(await portalInputs(path)).toEqual({ MCP_PORTAL_URL: PORTAL, MCP_PORTAL_AUTH: "token" });
    expect(events(result.stdout).find((event) => event.check === "token")).toMatchObject({ status: "warn" });
    expect(result.stderr).toContain("Set EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN to the portal's token, then apply");
    // A Workshop-only install has no district policy to change.
    expect(result.stderr).not.toContain("workshopPolicy.connectors: add");

    const secret = "synthetic-portal-token";
    const withToken = await run(["mcp", "status", "--offline"], { cwd: dir, env: { EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN: secret } });
    expect(withToken.stdout).toMatch(/ok\s+token\s+EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN is set/);
    expect(withToken.stdout + withToken.stderr).not.toContain(secret);
    expect(readFileSync(path, "utf8")).not.toContain(secret);
  });

  it("asks for the URL, name and sign-in on a terminal", async () => {
    const { dir, path } = writeAnswersFile(northfieldAnswers());
    const result = await run(["mcp", "add", "--connector", "portal"], { cwd: dir, terminal: [PORTAL, "", "3", "y"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MCP portal URL");
    expect(await portalInputs(path)).toEqual({ MCP_PORTAL_URL: PORTAL, MCP_PORTAL_AUTH: "none" });
  });

  it("refuses a missing or unusable URL, an unknown sign-in and portal flags without --connector portal, changing nothing", async () => {
    const { dir, path } = writeAnswersFile(northfieldAnswers());
    const before = readFileSync(path, "utf8");
    const missing = await run(["mcp", "add", "--connector", "portal", "--yes"], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/needs the portal's URL: pass --portal-url/);
    const local = await run(["mcp", "add", "--connector", "portal", "--portal-url", "http://127.0.0.1/mcp", "--yes"], { cwd: dir });
    expect(local.code).toBe(1);
    expect((await run(["mcp", "add", "--connector", "portal", "--portal-url", PORTAL, "--portal-auth", "basic"], { cwd: dir })).code).toBe(2);
    expect((await run(["mcp", "add", "--portal-url", PORTAL], { cwd: dir })).stderr).toContain("--portal-url is for mcp add --connector portal");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("checks the portal Worker's URL and token in the account", async () => {
    const cloudflare = await serveCloudflare(accountFor(NORTHFIELD));
    closing.push(cloudflare);
    cloudflare.fake.seedWorker("educateos-northfield-gatekeeper-mcp-portal", { MCP_PORTAL_URL: PORTAL, MCP_PORTAL_AUTH: "token" });
    const { dir } = writeAnswersFile(northfieldAnswers({ gatekeepers: ["gatekeeper-mcp-portal"], gatekeeperInputs: { "gatekeeper-mcp-portal": { MCP_PORTAL_URL: PORTAL, MCP_PORTAL_AUTH: "token" } } }));
    const env = { CLOUDFLARE_API_TOKEN: cloudflare.token, [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url };
    const result = await run(["mcp", "status", "--offline"], { cwd: dir, env });
    expect(result.stdout).toMatch(new RegExp(`ok\\s+portal\\s+portal ${PORTAL.replaceAll(".", "\\.")}$`, "m"));
    expect(result.stdout).toMatch(/FAIL\s+token\s+sign-in is token, but the Worker has no MCP_PORTAL_TOKEN/);
    expect(result.code).toBe(1);
  });
});

describe("mcp enable and disable (built-in Cloudflare OAuth)", () => {
  it("enables built-in Cloudflare OAuth MCP on an existing district, supports --strict-writes and --allowed-origin, and disables it cleanly", async () => {
    const { mcp: _off, ...noMcp } = districtConfig();
    const { dir, path } = writeAnswersFile(oneOriginAnswers(noMcp));

    const enabled = await run(["mcp", "enable", "--strict-writes", "--allowed-origin", "https://assistant.northfield.example", "--yes"], { cwd: dir });
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain("built-in Cloudflare OAuth");
    const services = (await readAnswers(path))!.install.services as Record<string, { vars: { DISTRICT_CONFIG: string } }>;
    const parsed = JSON.parse(services["educateos-district-worker"]!.vars.DISTRICT_CONFIG);
    expect(parsed.mcp).toEqual({
      mode: "builtin",
      origin: ORIGIN,
      allowDrafts: false,
      allowedOrigins: ["https://assistant.northfield.example"],
    });

    // Built-in mode reports ok in offline status without requiring external trustedIssuers.
    const status = await run(["mcp", "status", "--offline"], { cwd: dir });
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/ok\s+endpoint\s+on in DISTRICT_CONFIG \(built-in Cloudflare OAuth 2\.1\)/);
    expect(status.stdout).toMatch(/ok\s+issuer\s+built-in Cloudflare Access-backed OAuth 2\.1 at https:\/\/educateos\.northfield\.example/);
    // --strict-writes: drafts wait in the queue too.
    expect(status.stdout).toMatch(/--\s+writes\s+reads run immediately; every write waits/);

    // Disabling removes DISTRICT_CONFIG.mcp.
    const disabled = await run(["mcp", "disable", "--yes"], { cwd: dir });
    expect(disabled.code).toBe(0);
    const servicesAfter = (await readAnswers(path))!.install.services as Record<string, { vars: { DISTRICT_CONFIG: string } }>;
    const parsedAfter = JSON.parse(servicesAfter["educateos-district-worker"]!.vars.DISTRICT_CONFIG);
    expect(parsedAfter.mcp).toBeUndefined();
  });
});
