import { AcademicDirectory } from "@educateos/academics";
import { createDistrictApp, authorityFor } from "@educateos/district-app";
import { durableDistrictStores, DurableObjectToolApprovalStore, type DistrictSqlStorage } from "@educateos/district-app/durable-stores";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { SchoolToolRunner } from "@educateos/policy";
import { externalSchoolTools } from "./registry.ts";
import { createSchoolMcpApi } from "./index.ts";
import { SchoolTokenAuthority, type TokenStore } from "./auth.ts";
import { discoverIssuer, type McpWorkerConfig } from "./discovery.ts";
import type { JWTVerifyGetKey } from "jose";

/** Compose the district's durable directory, policy and human approval queue; no credentials service. */
export async function startMcpDistrict(
  storage: DistrictSqlStorage,
  grants: TokenStore,
  config: McpWorkerConfig,
  keys?: JWTVerifyGetKey,
) {
  const stores = durableDistrictStores(storage, config.directory);
  const app = await createDistrictApp({
    stores,
    // No HTTP sign-in or document import surface is exposed by this MCP Worker.
    verifyRequest: async () => undefined,
    importFetch: async () => { throw new Error("Imports unavailable"); },
  });
  if (app.districtId !== config.directory.district.id) throw new Error("District mismatch");
  const directory = new AcademicDirectory({ store: stores.directory, authority: authorityFor(undefined), authorizer: app.engine });
  const runner = new SchoolToolRunner({
    engine: app.engine,
    tools: externalSchoolTools(stores.directory, directory),
    approvals: { store: new DurableObjectToolApprovalStore(storage) },
  });
  const tokens = new SchoolTokenAuthority({
    issuers: [{
      ...config.issuer,
      audience: `${config.origin}/mcp`,
      keys: keys ?? await discoverIssuer(config.issuer),
    }],
    store: grants,
    requiredScopes: ["mcp:tools"],
    resolver: async () => createDirectoryPrincipalResolver((await stores.directory.load()).snapshot),
  });
  return createSchoolMcpApi({
    districtId: app.districtId, runner, tokens, allowedOrigins: config.allowedOrigins,
    resource: { origin: config.origin, authorizationServers: [config.issuer.issuer], scopes: ["mcp:tools"] },
  });
}
