// `launch-educate-os mcp`: MCP for district IT (SCHO-407).
//
//   mcp status    what the answers and the account say about MCP, plus live checks
//   mcp clients   connecting AI clients (Claude, ChatGPT, editors) to the district's own /mcp
//   mcp add       adding an external MCP server to the AI Workshop
//
// Two different things are called MCP here, and every command says which:
//
// - The district's own MCP endpoint, `<origin>/mcp`, which outside AI clients call. It is the
//   district Worker's, turned on by `DISTRICT_CONFIG.mcp` (SCHO-174), and an OAuth protected
//   resource: clients sign in at the district's authorization server (Nathan, NATH-6), never through
//   Cloudflare Access.
// - The Workshop's MCP connectors, which let Workshop agents call outside MCP servers: the
//   "MCP Server" gatekeeper (`gatekeeper-mcp`, an address a person pastes) and the
//   "MCP Server Portal" (`gatekeeper-mcp-portal`, one deployment-configured portal).
//
// The launcher changes only the answers file, the same file `install` applies, and only fields the
// product reads: `gatekeepers`, and `workshopPolicy.connectors` inside the district service's
// `DISTRICT_CONFIG`. What lives in the Workshop (which connectors are offered, which servers are
// connected) it can't read or write, so it names the page and the steps instead.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { EducateOsError } from "@educateos/contracts";
import { DISTRICT_TOKEN_ENV, staticTokenProvider } from "@educateos/installer";
import { ANSWERS_FILE, type Answers, readAnswers, writeAnswers } from "../answers.ts";
import type { CliIo } from "../cli.ts";
import { launchCloudflare, TEST_CLOUDFLARE_RPC_ENV } from "../cloudflare.ts";
import { Output } from "../output.ts";
import { type Prompter, PromptCancelled, streamPrompter } from "../prompter.ts";
import { CLIENT_GUIDES, withUrl } from "./clients.ts";
import { MCP_GATEKEEPERS, type McpFacts, mcpFacts, mcpResource } from "./facts.ts";
import { endpointProblem, type EndpointProbe, probeAuthorizationServer, probeDistrictEndpoint, probeMcpServer } from "./probe.ts";

declare const __LAUNCH_VERSION__: string | undefined;
const VERSION = typeof __LAUNCH_VERSION__ === "string" ? __LAUNCH_VERSION__ : "0.0.0-source";

/** The follow-up issue for what the installer can't configure yet (portal settings, the /mcp Access bypass). */
export const INSTALLER_GAP_ISSUE = "SCHO-409";

export const MCP_USAGE = `launch-educate-os mcp: set up MCP for your EducateOS install

Usage:
  npx launch-educate-os mcp status    the district MCP endpoint and the Workshop's MCP connectors:
                                      what the answers file says, what the account runs, and a
                                      live check of the endpoint
  npx launch-educate-os mcp clients   connect AI clients (Claude, ChatGPT, Claude Code, VS Code,
                                      Cursor, others) to your district's /mcp: the URL, each
                                      client's steps, how sign-in works, who may use it
  npx launch-educate-os mcp add       add an external MCP server to the AI Workshop: checks the
                                      server, installs the MCP Server connector and grants it in
                                      district policy (answers file), then the Workshop steps

Options:
  --config <file>       the answers file (default ./${ANSWERS_FILE})
  --url <url>           clients: the MCP endpoint, instead of the one the answers file gives
  --client <id>         clients: one client only (${CLIENT_GUIDES.map((guide) => guide.id).join(", ")})
  --server-url <url>    add: the MCP server to check and add (otherwise asked on a terminal)
  --connector <kind>    add: "server" (default; any MCP server a person pastes) or "portal"
  --yes                 add: save the changes without asking (needed without a terminal)
  --offline             no live checks: read the answers file only
  --json                one JSON event per line on stdout; human text goes to stderr
  -h, --help            this help

Environment:
  ${DISTRICT_TOKEN_ENV}  optional for status: also checks the connectors' Workers in the account

Nothing here changes Cloudflare. "add" changes only the answers file; apply it with
npx launch-educate-os --config <file>.`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      url: { type: "string" },
      client: { type: "string" },
      "server-url": { type: "string" },
      connector: { type: "string" },
      yes: { type: "boolean", short: "y" },
      offline: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}
type Values = ReturnType<typeof parse>["values"];

type Status = "ok" | "info" | "warn" | "fail";
const MARK: Record<Status, string> = { ok: "ok  ", info: "--  ", warn: "WARN", fail: "FAIL" };

/** Checks, printed like `doctor`'s and counted. */
class Report {
  failed = 0;
  readonly out: Output;
  constructor(out: Output) {
    this.out = out;
  }
  check(check: string, status: Status, detail: string): void {
    if (status === "fail") this.failed++;
    this.out.event({ event: "mcp", check, status, detail });
    this.out.line(`${MARK[status]}  ${check.padEnd(12)} ${detail}`);
  }
  heading(text: string): void {
    this.out.line();
    this.out.line(text);
  }
}

interface Context {
  io: CliIo;
  values: Values;
  out: Output;
  prompter: Prompter | undefined;
  fetch: typeof fetch;
  answersPath: string;
}

/** Runs `launch-educate-os mcp ...` (`argv` after `mcp`) and resolves to its exit code. Never throws. */
export async function mcpMain(io: CliIo, argv: string[]): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv));
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "bad arguments"}\n\n${MCP_USAGE}\n`);
    return 2;
  }
  const sub = positionals[0];
  if (values.help || sub === undefined || sub === "help") {
    (sub === undefined && !values.help ? io.stderr : io.stdout).write(`${MCP_USAGE}\n`);
    return sub === undefined && !values.help ? 2 : 0;
  }
  if (!["status", "clients", "add"].includes(sub) || positionals.length > 1) {
    io.stderr.write(`unknown command: mcp ${positionals.join(" ")}\n\n${MCP_USAGE}\n`);
    return 2;
  }
  if (values.client !== undefined && !CLIENT_GUIDES.some((guide) => guide.id === values.client)) {
    io.stderr.write(`unknown --client ${values.client}: one of ${CLIENT_GUIDES.map((guide) => guide.id).join(", ")}\n`);
    return 2;
  }
  if (values.connector !== undefined && !["server", "portal"].includes(values.connector)) {
    io.stderr.write(`unknown --connector ${values.connector}: "server" or "portal"\n`);
    return 2;
  }
  const out = new Output({ json: values.json === true, out: io.stdout, err: io.stderr });
  out.secret(io.env[DISTRICT_TOKEN_ENV]);
  const interactive = io.stdin.isTTY === true && io.stdout.isTTY === true && !values.json;
  const prompter = interactive ? streamPrompter({ input: io.stdin, output: io.stdout }) : undefined;
  const context: Context = {
    io, values, out, prompter,
    fetch: io.fetch ?? fetch.bind(globalThis),
    answersPath: resolve(io.cwd, values.config ?? ANSWERS_FILE),
  };
  try {
    if (io.env[TEST_CLOUDFLARE_RPC_ENV]) out.line(`NOTE: ${TEST_CLOUDFLARE_RPC_ENV} is set: talking to a test Cloudflare, not api.cloudflare.com.`);
    if (sub === "status") return await status(context);
    if (sub === "clients") return await clients(context);
    return await add(context);
  } catch (error) {
    if (error instanceof PromptCancelled) {
      out.line();
      out.line("Stopped. Nothing was changed.");
      return 130;
    }
    out.error(error);
    return 1;
  } finally {
    prompter?.close();
  }
}

async function loadAnswers(context: Context, purpose: string): Promise<Answers> {
  const answers = await readAnswers(context.answersPath);
  if (answers === undefined) {
    throw new EducateOsError("not-found", `${purpose} needs the answers file from the install (${context.answersPath}); pass --config <file>`);
  }
  return answers;
}

// ---- the district endpoint ---------------------------------------------------------------------

/** Reports what DISTRICT_CONFIG says about the district's /mcp. */
function reportEndpointConfig(report: Report, facts: McpFacts): void {
  const district = facts.district;
  if (district === undefined) {
    report.check("endpoint", "info", "this install has no district service (the LMS), so there is no district /mcp");
    return;
  }
  if (district.config === undefined) {
    report.check("config", "fail", `the district service's DISTRICT_CONFIG in the answers is not JSON`);
    return;
  }
  const mcp = district.mcp;
  if (mcp === undefined) {
    report.check("endpoint", "info", "off: DISTRICT_CONFIG has no \"mcp\" settings, so /mcp answers 404 (the default)");
    return;
  }
  report.check("endpoint", "ok", `on in DISTRICT_CONFIG: ${mcp.origin}/mcp`);
  report.check("issuer", district.trustedIssuers.includes(mcp.issuer) ? "ok" : "fail", district.trustedIssuers.includes(mcp.issuer)
    ? `tokens come from ${mcp.issuer}, which the district trusts`
    : `tokens come from ${mcp.issuer}, which is not in the directory's trustedIssuers or additionalTrustedIssuers: no one's sign-in there links to a person, so every call is refused`);
  if (mcp.origin !== facts.origin) {
    report.check("origin", "warn", `mcp.origin is ${mcp.origin}, not the install's ${facts.origin}: tokens must be issued for ${mcp.origin}/mcp, and that hostname must route to this district`);
  }
  report.check("browsers", "info", mcp.allowedOrigins?.length
    ? `browser clients from ${mcp.allowedOrigins.join(", ")} may call it`
    : "no browser origins allowed: clients that send no Origin header only (desktop apps, editors, and services such as claude.ai and ChatGPT that call from their servers)");
}

/** Reports the live endpoint against what the config says. */
function reportEndpointProbe(report: Report, facts: McpFacts, probe: EndpointProbe, resource: string): void {
  const configured = facts.district?.mcp !== undefined;
  const label = "live";
  switch (probe.state) {
    case "on": {
      report.check(label, "ok", `${resource}: metadata served (resource ${probe.metadata.resource}, authorization server ${probe.metadata.authorizationServers.join(", ") || "none named"})`);
      if (probe.metadata.resource !== resource) report.check("resource", "fail", `the metadata names ${probe.metadata.resource}, not ${resource}: clients will ask for tokens for the wrong resource`);
      report.check("challenge", probe.challenge === "ok" ? "ok" : "warn", probe.challenge === "ok"
        ? "an unauthenticated request gets 401 naming the metadata, as MCP clients expect"
        : probe.challenge === "missing" ? "401 without a resource_metadata challenge" : `an unauthenticated request got ${probe.challengeStatus || "no answer"}, not 401`);
      return;
    }
    case "off":
      report.check(label, configured ? "fail" : "ok", configured
        ? `${resource} is 404 though DISTRICT_CONFIG turns it on: apply the answers (npx launch-educate-os --config <file>)`
        : `${resource} is 404, as configured`);
      return;
    case "access":
      report.check(label, configured ? "fail" : "info", configured
        ? `Cloudflare Access answered the metadata request (${probe.status} to its sign-in). /mcp and /.well-known/oauth-protected-resource[/mcp] must be exempt from Access, since MCP clients bring their own tokens; the installer doesn't add that bypass yet (${INSTALLER_GAP_ISSUE})`
        : "Cloudflare Access answers the path (the endpoint is off, so nothing is exempt from Access)");
      return;
    case "unexpected":
      report.check(label, "warn", `the metadata request got HTTP ${probe.status}`);
      return;
    case "unreachable":
      report.check(label, "warn", `no answer from ${new URL(resource).origin} (is it installed, and is this machine online?)`);
  }
}

// ---- status ------------------------------------------------------------------------------------

async function status(context: Context): Promise<number> {
  const { io, values, out } = context;
  const answers = await loadAnswers(context, "mcp status");
  const facts = mcpFacts(answers);
  const report = new Report(out);
  out.line(`EducateOS at ${facts.origin} (from ${context.answersPath})`);

  report.heading("District MCP endpoint: outside AI clients call your district");
  reportEndpointConfig(report, facts);
  const resource = mcpResource(facts);
  if (values.offline) report.check("live", "info", "skipped (--offline)");
  else if (facts.district !== undefined) reportEndpointProbe(report, facts, await probeDistrictEndpoint(context.fetch, resource), resource);

  report.heading("Workshop MCP connectors: Workshop agents call MCP servers");
  for (const [key, gatekeeper] of Object.entries(MCP_GATEKEEPERS) as [keyof typeof MCP_GATEKEEPERS, (typeof MCP_GATEKEEPERS)[keyof typeof MCP_GATEKEEPERS]][]) {
    report.check(key, facts.gatekeepers[key].inAnswers ? "ok" : "info", `${gatekeeper.name} (${gatekeeper.pkg}): ${facts.gatekeepers[key].inAnswers ? "installed by the answers" : "not in the answers' gatekeepers"}`);
  }
  const token = io.env[DISTRICT_TOKEN_ENV];
  if (token === undefined || token === "") {
    report.check("account", "info", `${DISTRICT_TOKEN_ENV} is not set: the account's Workers are not checked`);
  } else {
    await reportAccount(report, facts, token, io);
  }

  if (facts.district !== undefined && facts.district.config !== undefined) {
    const district = facts.district;
    if (!district.hasWorkshopPolicy) {
      report.check("policy", "warn", "DISTRICT_CONFIG has no workshopPolicy: the district refuses every Workshop capability, connecting MCP servers included");
    } else {
      for (const [key, gatekeeper] of Object.entries(MCP_GATEKEEPERS)) {
        if (key === "portal" && !facts.gatekeepers.portal.inAnswers) continue;
        const grants = district.connectorGrants[gatekeeper.vendorId]?.length ?? 0;
        report.check("policy", grants > 0 ? "ok" : "warn", grants > 0
          ? `district administrators may connect the ${gatekeeper.name} (workshopPolicy.connectors names "${gatekeeper.vendorId}")`
          : `workshopPolicy.connectors has no grant for "${gatekeeper.vendorId}": connecting the ${gatekeeper.name} is refused${key === "server" ? " (npx launch-educate-os mcp add adds one)" : ""}`);
        if (district.teacherGrants[gatekeeper.vendorId]?.length) {
          report.check("policy", "warn", `workshopPolicy.teacherConnectors lists "${gatekeeper.vendorId}": teachers may connect MCP servers themselves, though teacherConnectors is meant for connectors confined to a teacher's own teaching`);
        }
      }
    }
  }
  report.check("workshop", "info", `which connectors are offered is set in the Workshop, which the launcher can't read: ${facts.workshopUrl}admin?tab=gatekeepers`);
  report.check("approvals", "info", "fixed by the connector: tools a server marks read-only run at once and are recorded; every other call waits for a person to approve it; a pasted server can never auto-apply a write");
  return report.failed === 0 ? 0 : 1;
}

async function reportAccount(report: Report, facts: McpFacts, token: string, io: CliIo): Promise<void> {
  const cf = launchCloudflare(io.env, staticTokenProvider("district-run", token));
  const accountId = facts.config.accountId;
  let scripts: Set<string>;
  try {
    scripts = new Set((await cf.api.listWorkerScripts(accountId)).map((script) => script.name));
  } catch (error) {
    report.check("account", "fail", `the account's Workers could not be listed (${error instanceof EducateOsError ? error.message : "Cloudflare refused"})`);
    return;
  }
  for (const key of Object.keys(MCP_GATEKEEPERS) as (keyof typeof MCP_GATEKEEPERS)[]) {
    const { inAnswers, scriptName } = facts.gatekeepers[key];
    const present = scripts.has(scriptName);
    if (!present) {
      report.check(key, inAnswers ? "warn" : "info", inAnswers
        ? `Worker ${scriptName} is not in the account yet: apply the answers (npx launch-educate-os --config <file>)`
        : `Worker ${scriptName} is not installed`);
      continue;
    }
    report.check(key, "ok", `Worker ${scriptName} is installed${inAnswers ? "" : " (but not in the answers: the next apply keeps it only if you add it)"}`);
    if (key === "portal") {
      const settings = await cf.api.getWorkerSettings(accountId, scriptName).catch(() => undefined);
      const portalUrl = settings?.bindings.find((binding) => binding.name === "MCP_PORTAL_URL")?.text;
      report.check("portal", portalUrl ? "ok" : "warn", portalUrl
        ? `portal ${portalUrl}`
        : `MCP_PORTAL_URL is not set, so the Workshop hides the portal connector; the installer can't set it yet (${INSTALLER_GAP_ISSUE})`);
    }
  }
}

/** `text` as indented lines of at most 100 characters. */
function paragraph(out: Output, text: string): void {
  let line = " ";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > 100 && line.trim() !== "") {
      out.line(line);
      line = " ";
    }
    line += ` ${word}`;
  }
  out.line(line);
}

// ---- clients -----------------------------------------------------------------------------------

async function clients(context: Context): Promise<number> {
  const { values, out } = context;
  let facts: McpFacts | undefined;
  let resource: string;
  if (values.url !== undefined) {
    const problem = endpointProblem(values.url);
    if (problem !== undefined) throw new EducateOsError("validation-failed", `--url ${values.url}: ${problem}`);
    resource = new URL(values.url).toString().replace(/\/$/, "");
  } else {
    facts = mcpFacts(await loadAnswers(context, "mcp clients (or --url <endpoint>)"));
    resource = mcpResource(facts);
  }
  const report = new Report(out);
  out.line(`Your district's MCP endpoint: ${resource}`);

  report.heading("Is it ready?");
  if (facts !== undefined) reportEndpointConfig(report, facts);
  let issuer = facts?.district?.mcp?.issuer;
  let live: EndpointProbe | undefined;
  if (values.offline) {
    report.check("live", "info", "skipped (--offline)");
  } else {
    live = await probeDistrictEndpoint(context.fetch, resource);
    if (facts !== undefined) reportEndpointProbe(report, facts, live, resource);
    else if (live.state === "on") report.check("live", "ok", `metadata served; authorization server ${live.metadata.authorizationServers.join(", ") || "none named"}`);
    else report.check("live", "warn", live.state === "off" ? "404: the endpoint is off" : live.state === "access" ? "Cloudflare Access answers: the endpoint isn't exempt from Access" : "the endpoint did not answer as an MCP resource");
    if (live.state === "on") issuer = live.metadata.authorizationServers[0] ?? issuer;
  }
  if (issuer !== undefined && !values.offline) {
    const server = await probeAuthorizationServer(context.fetch, issuer);
    if (server.metadataUrl === undefined) {
      report.check("sign-in", "fail", `${issuer} publishes no OAuth authorization server metadata (RFC 8414 or OpenID): MCP clients can't find where to sign in`);
    } else {
      report.check("sign-in", server.authorizationEndpoint && server.tokenEndpoint && server.pkceS256 && server.issuerMatches ? "ok" : "fail",
        `${issuer}: ${[
          server.issuerMatches ? "issuer matches" : "metadata names another issuer",
          server.authorizationEndpoint && server.tokenEndpoint ? "authorization and token endpoints" : "no authorization or token endpoint",
          server.pkceS256 ? "PKCE S256" : "no PKCE S256",
        ].join(", ")}`);
      report.check("register", server.registration || server.clientIdMetadataDocuments ? "ok" : "warn", server.registration || server.clientIdMetadataDocuments
        ? `clients can register themselves (${[server.registration ? "dynamic client registration" : "", server.clientIdMetadataDocuments ? "client ID metadata documents" : ""].filter(Boolean).join(", ")})`
        : "no dynamic client registration or client ID metadata documents: each client needs a client ID issued for it, entered by hand where the client allows");
    }
  }

  report.heading("How sign-in works");
  paragraph(out, `MCP clients don't sign in through Cloudflare Access. Each person signs in at the district's OAuth authorization server${issuer ? ` (${issuer})` : ""}, and the client sends the endpoint a short-lived access token for exactly ${resource} with the scope mcp:tools. The endpoint checks the token, then looks the person up through the district's identity links: the token names no role.`);
  report.heading("Who may use it");
  paragraph(out, "Staff only: district, school and curriculum administrators, teachers and co-teachers. Students can't delegate, so no student can use it.");
  paragraph(out, "Each person first issues a delegation to the client: which client (the authorization server's client ID for it), the most it may do (scope, actions, kinds of records), and for how long (90 days at most). Every call is held to that delegation and to the person's standing in the roster now. Revoking it, deactivating the person or unlinking their sign-in stops the next call. Writes wait in the district's approval queue; MCP can't approve anything.");
  paragraph(out, "Delegations are issued through the district API (POST /api/teacher/delegations); there is no page for them yet (SCHO-176).");

  report.heading("Connect a client");
  for (const guide of CLIENT_GUIDES.filter((item) => values.client === undefined || item.id === values.client)) {
    const steps = guide.steps.map((step) => withUrl(step, resource));
    const snippet = guide.snippet ? { file: guide.snippet.file, text: withUrl(guide.snippet.text, resource) } : undefined;
    out.event({ event: "mcp-client", id: guide.id, name: guide.name, url: resource, steps, ...(snippet ? { snippet } : {}) });
    out.line();
    out.line(`  ${guide.name}  (--client ${guide.id})`);
    steps.forEach((step, index) => out.line(`    ${index + 1}. ${step}`));
    if (snippet) {
      out.line(`    ${snippet.file}:`);
      for (const line of snippet.text.split("\n")) out.line(`      ${line}`);
    }
  }
  out.line();
  out.line("Not yet proven live: no outside MCP client has connected to an EducateOS district. The endpoint");
  out.line("is tested end to end with the official MCP client against a simulated authorization server;");
  out.line("the district's real one (Nathan) doesn't issue tokens for it yet (NATH-6), and the installer");
  out.line(`doesn't exempt /mcp from Cloudflare Access yet (${INSTALLER_GAP_ISSUE}).`);
  return report.failed === 0 ? 0 : 1;
}

// ---- add ---------------------------------------------------------------------------------------

/** One change `mcp add` makes to the answers file. */
interface Change {
  description: string;
  apply(install: Record<string, unknown>): void;
}

/** The changes that install the MCP Server connector and grant it to district administrators. */
export function serverConnectorChanges(facts: McpFacts): { changes: Change[]; notes: string[] } {
  const changes: Change[] = [];
  const notes: string[] = [];
  const { pkg, vendorId } = MCP_GATEKEEPERS.server;
  if (!facts.gatekeepers.server.inAnswers) {
    changes.push({
      description: `gatekeepers: add "${pkg}" (installs the MCP Server connector's Worker)`,
      apply: (install) => {
        install.gatekeepers = [...(Array.isArray(install.gatekeepers) ? install.gatekeepers : []), pkg];
      },
    });
  }
  const district = facts.district;
  if (district !== undefined) {
    if (district.config === undefined) throw new EducateOsError("validation-failed", "the district service's DISTRICT_CONFIG in the answers is not JSON");
    if (!district.hasWorkshopPolicy) {
      notes.push("DISTRICT_CONFIG has no workshopPolicy, so the district refuses every Workshop capability, connecting MCP servers included. Write one deliberately (see packages/educateos-district-worker/README.md); the launcher won't invent it.");
    } else if (!district.connectorGrants[vendorId]?.length) {
      changes.push({
        description: `DISTRICT_CONFIG.workshopPolicy.connectors: add {"vendorId": "${vendorId}", "access": "all"} (district administrators may connect MCP servers; teachers may not)`,
        apply: (install) => {
          const services = install.services as Record<string, { vars: Record<string, string> }>;
          const vars = services[district.pkg]!.vars;
          const text = vars.DISTRICT_CONFIG!;
          const json = JSON.parse(text) as { workshopPolicy: { connectors?: unknown[] } };
          json.workshopPolicy.connectors = [...json.workshopPolicy.connectors ?? [], { vendorId, access: "all" }];
          vars.DISTRICT_CONFIG = JSON.stringify(json, null, text.includes("\n") ? 2 : undefined);
        },
      });
    }
  }
  return { changes, notes };
}

async function checkServer(context: Context, report: Report, url: string): Promise<void> {
  const problem = endpointProblem(url);
  if (problem !== undefined) throw new EducateOsError("validation-failed", `${url}: ${problem}`);
  if (context.values.offline) {
    report.check("server", "info", `${url}: live check skipped (--offline)`);
    return;
  }
  report.check("from here", "info", "checked from this machine; the Workshop connects from Cloudflare, so a server only your network reaches will fail there");
  const probe = await probeMcpServer(context.fetch, url, VERSION);
  switch (probe.state) {
    case "public":
      report.check("server", "ok", `answers without sign-in${probe.serverName ? ` (${probe.serverName})` : ""}: the connector records it as public and asks for no token`);
      return;
    case "oauth": {
      const as = probe.authorizationServer;
      if (as === undefined) {
        report.check("server", "warn", `asks for sign-in but names no authorization server${probe.metadataUrl ? ` at ${probe.metadataUrl}` : ""}; the connector falls back to /authorize, /token and /register on the server's origin, which most servers don't have`);
        return;
      }
      report.check("server", "ok", `asks for sign-in at ${as.issuer}`);
      if (as.metadataUrl === undefined) {
        report.check("sign-in", "fail", `${as.issuer} publishes no OAuth metadata: the connector can't sign in`);
        return;
      }
      report.check("register", as.registration ? "ok" : "fail", as.registration
        ? "dynamic client registration: the connector registers itself, nothing to set up"
        : "no dynamic client registration: the MCP Server connector can't register itself there. Put the server behind an MCP portal configured with a token instead");
      report.check("pkce", as.pkceS256 ? "ok" : "warn", as.pkceS256 ? "PKCE S256" : "the server doesn't advertise PKCE S256");
      return;
    }
    case "access":
      report.check("server", "warn", "Cloudflare Access answered: the server sits behind Access. Use it through a Cloudflare MCP server portal (the MCP Server Portal connector) instead");
      return;
    case "redirect":
      report.check("server", "warn", `answered with a redirect (${probe.status}); use the address it redirects to`);
      return;
    case "unexpected":
      report.check("server", "warn", `answered HTTP ${probe.status} to an MCP initialize request: is this the server's MCP endpoint (often ending in /mcp)?`);
      return;
    case "unreachable":
      report.check("server", "warn", "no answer from this machine");
  }
}

async function add(context: Context): Promise<number> {
  const { values, out, prompter } = context;
  const report = new Report(out);
  if (values.connector === "portal") {
    out.line("The MCP Server Portal connector takes its portal from the Worker's settings (MCP_PORTAL_URL,");
    out.line("MCP_PORTAL_NAME, MCP_PORTAL_AUTH, MCP_PORTAL_TOKEN), and the installer can't set them yet: the");
    out.line(`connector declares no deploy inputs (${INSTALLER_GAP_ISSUE}). Installed without them, the Workshop`);
    out.line("hides it. Until then, use the MCP Server connector (npx launch-educate-os mcp add), with each");
    out.line("server's own sign-in. Nothing was changed.");
    report.check("portal", "fail", `not configurable by the installer yet (${INSTALLER_GAP_ISSUE})`);
    return 1;
  }
  const answers = await loadAnswers(context, "mcp add");
  const facts = mcpFacts(answers);

  report.heading("The server");
  let url = values["server-url"];
  if (url === undefined && prompter !== undefined) {
    url = await prompter.text("MCP server address to check (blank to skip)", {
      validate: (value) => (value === "" ? undefined : endpointProblem(value)),
    }) || undefined;
  }
  if (url === undefined) report.check("server", "info", "no server given (--server-url): nothing to check");
  else await checkServer(context, report, url);

  report.heading(`Changes to ${context.answersPath}`);
  const { changes, notes } = serverConnectorChanges(facts);
  for (const note of notes) report.check("policy", "warn", note);
  let saved = false;
  if (changes.length === 0) {
    out.line("  None: the answers already install the MCP Server connector and grant it.");
  } else {
    for (const change of changes) out.line(`  + ${change.description}`);
    const go = values.yes === true || (prompter !== undefined && await prompter.confirm("Save these changes to the answers file?", true));
    if (!go) {
      for (const change of changes) out.event({ event: "mcp-change", change: change.description, saved: false });
      if (prompter === undefined) {
        out.line("Not saved: pass --yes to save without a terminal.");
        return 2;
      }
      out.line("Not saved. Nothing was changed.");
      return 0;
    }
    const install = structuredClone(answers.install);
    for (const change of changes) change.apply(install);
    await writeAnswers(context.answersPath, { ...answers, install });
    saved = true;
    for (const change of changes) out.event({ event: "mcp-change", change: change.description, saved: true });
    out.line(`Saved. ${context.answersPath} still holds no secrets.`);
  }

  report.heading("Next steps");
  const steps = [
    ...(saved ? [
      `Apply the answers: npx launch-educate-os plan --config ${context.answersPath} to review, then npx launch-educate-os --config ${context.answersPath}. (Like upgrade, it installs the newest release; pass --release <id> to stay on yours.)`,
    ] : []),
    `In the Workshop, ${facts.workshopUrl}admin?tab=gatekeepers: check "MCP Server" is on. Connectors are on unless an administrator turned them off.`,
    `${facts.district ? "As a district administrator (district policy lets no one else connect it)" : "As anyone signed in to the Workshop (an install without the district LMS has no district policy)"}, open ${facts.workshopUrl}gatekeepers, choose MCP Server, Connect, and paste ${url ?? "the server's address"}. Sign in at the server if it asks.`,
    "Grant it to an agent or Gadget: choose All tools, or Choose tools to allow only the ones you tick.",
    "Approvals: tools the server marks read-only run at once and are recorded; every other call waits for a person to approve it. Nothing a pasted server claims can make a write skip approval.",
    "Check: npx launch-educate-os mcp status",
  ];
  steps.forEach((step, index) => out.line(`  ${index + 1}. ${step}`));
  out.line();
  out.line("Not yet proven live: the MCP Server connector is unit-tested in Cloudflare OS, and no EducateOS");
  out.line("district has connected an outside MCP server through it yet.");
  return report.failed === 0 ? 0 : 1;
}
