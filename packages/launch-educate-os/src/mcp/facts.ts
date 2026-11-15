// What the answers file says about MCP, read without a release or a network: the install's public
// origin and Workshop URL, the district service's `DISTRICT_CONFIG` (its `mcp` endpoint settings and
// the `workshopPolicy` grants that decide who may connect an MCP connector), and which MCP
// gatekeepers the answers install.
//
// `DISTRICT_CONFIG` is the district Worker's own schema (`DistrictWorkerConfig` in
// packages/educateos-district-worker). The launcher doesn't bundle that Worker, so it reads only the
// fields it reports on, loosely, and leaves validating the whole to the Worker.
import { type DistrictInstallConfig, publicHostname, workerScriptName } from "@educateos/installer";
import { z } from "zod";
import { type Answers, installConfig } from "../answers.ts";

/** The MCP gatekeepers a release can install, by package. */
export const MCP_GATEKEEPERS = {
  /** Any MCP server a person pastes the address of. */
  server: { pkg: "gatekeeper-mcp", vendorId: "mcp", name: "MCP Server" },
  /** One portal the deployment configures (MCP_PORTAL_URL). */
  portal: { pkg: "gatekeeper-mcp-portal", vendorId: "mcpportal", name: "MCP Server Portal" },
} as const;

/** The district Worker's `DISTRICT_CONFIG.mcp`: the organization MCP endpoint (SCHO-174). */
const McpSettings = z.object({
  origin: z.string(),
  issuer: z.string(),
  jwksUri: z.string(),
  algorithms: z.array(z.string()),
  allowedOrigins: z.array(z.string()).optional(),
});
/** The district's MCP endpoint settings, as far as the launcher reads them. */
export type McpSettings = z.infer<typeof McpSettings>;

const ConnectorGrant = z.object({ vendorId: z.string() }).loose();

/** The parts of `DISTRICT_CONFIG` the launcher reads. Everything else is kept as it is. */
const DistrictConfigView = z.object({
  directory: z.object({
    district: z.object({ trustedIssuers: z.array(z.string()).optional() }).loose().optional(),
  }).loose().optional(),
  additionalTrustedIssuers: z.array(z.string()).optional(),
  mcp: McpSettings.optional(),
  workshopPolicy: z.object({
    connectors: z.array(ConnectorGrant).optional(),
    teacherConnectors: z.array(ConnectorGrant).optional(),
  }).loose().optional(),
}).loose();
type DistrictConfigView = z.infer<typeof DistrictConfigView>;

/** The district service in the answers, with its parsed `DISTRICT_CONFIG`. */
export interface DistrictFacts {
  /** The service's package, e.g. `educateos-district-worker`. */
  pkg: string;
  /** The parsed config, or undefined when its text is not JSON. */
  config: DistrictConfigView | undefined;
  /** The organization MCP endpoint's settings, when `DISTRICT_CONFIG.mcp` turns it on. */
  mcp: McpSettings | undefined;
  /** Issuers the district trusts: the directory's, plus `additionalTrustedIssuers`. */
  trustedIssuers: string[];
  /** Whether `DISTRICT_CONFIG.workshopPolicy` is present. Absent, the district refuses every Workshop capability. */
  hasWorkshopPolicy: boolean;
  /** `workshopPolicy.connectors` grants naming each vendor ID. */
  connectorGrants: Record<string, unknown[]>;
  /** `workshopPolicy.teacherConnectors` entries naming each vendor ID. */
  teacherGrants: Record<string, unknown[]>;
}

/** Everything about MCP the answers file decides. */
export interface McpFacts {
  config: DistrictInstallConfig;
  /** `https://<public hostname>`. */
  origin: string;
  /** Where the AI Workshop is: `<origin>/ai/` on a one-origin install, else `<origin>/`. */
  workshopUrl: string;
  /** The district service, on a one-origin install. */
  district: DistrictFacts | undefined;
  /** For each MCP gatekeeper: whether the answers install it, and its Worker name. */
  gatekeepers: Record<keyof typeof MCP_GATEKEEPERS, { inAnswers: boolean; scriptName: string }>;
}

/** The enabled service whose vars carry a `DISTRICT_CONFIG`, if any. */
export function districtService(config: DistrictInstallConfig): { pkg: string; text: string } | undefined {
  for (const [pkg, service] of Object.entries(config.services)) {
    const text = service.vars.DISTRICT_CONFIG;
    if (service.enabled && typeof text === "string") return { pkg, text };
  }
  return undefined;
}

function grantsByVendor(grants: { vendorId: string }[] | undefined): Record<string, unknown[]> {
  const byVendor: Record<string, unknown[]> = {};
  for (const grant of grants ?? []) (byVendor[grant.vendorId] ??= []).push(grant);
  return byVendor;
}

/** Reads a `DISTRICT_CONFIG` text. */
export function districtFacts(pkg: string, text: string): DistrictFacts {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = json === undefined ? undefined : DistrictConfigView.safeParse(json);
  const config = parsed?.success ? parsed.data : undefined;
  return {
    pkg,
    config,
    mcp: config?.mcp,
    trustedIssuers: [...config?.directory?.district?.trustedIssuers ?? [], ...config?.additionalTrustedIssuers ?? []],
    hasWorkshopPolicy: config?.workshopPolicy !== undefined,
    connectorGrants: grantsByVendor(config?.workshopPolicy?.connectors),
    teacherGrants: grantsByVendor(config?.workshopPolicy?.teacherConnectors),
  };
}

/** What the answers say about MCP. Throws if the answers are not a valid install config. */
export function mcpFacts(answers: Pick<Answers, "install">): McpFacts {
  const config = installConfig(answers);
  const origin = `https://${publicHostname(config)}`;
  const service = districtService(config);
  const district = service === undefined ? undefined : districtFacts(service.pkg, service.text);
  const gatekeepers = Object.fromEntries(Object.entries(MCP_GATEKEEPERS).map(([key, gatekeeper]) => [key, {
    inAnswers: config.gatekeepers.includes(gatekeeper.pkg),
    scriptName: workerScriptName(config, gatekeeper.pkg),
  }])) as McpFacts["gatekeepers"];
  return { config, origin, workshopUrl: district ? `${origin}/ai/` : `${origin}/`, district, gatekeepers };
}

/** The district endpoint's resource, `<origin>/mcp`: from `DISTRICT_CONFIG.mcp.origin`, else the public origin. */
export function mcpResource(facts: McpFacts): string {
  return `${facts.district?.mcp?.origin ?? facts.origin}/mcp`;
}
