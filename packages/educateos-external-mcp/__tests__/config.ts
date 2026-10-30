import { NORTHFIELD } from "@educateos/fixtures";
import type { McpWorkerConfig } from "../src/discovery.ts";
export const CONFIG: McpWorkerConfig = {
  origin: "https://school.example",
  directory: structuredClone(NORTHFIELD),
  allowedOrigins: ["https://client.example"],
  issuer: {
    issuer: NORTHFIELD.principals[0]!.externalIdentities[0]!.issuer,
    metadataUrl: `${NORTHFIELD.principals[0]!.externalIdentities[0]!.issuer}/.well-known/oauth-authorization-server`,
    jwksUri: `${NORTHFIELD.principals[0]!.externalIdentities[0]!.issuer}/keys`,
    exchangeAudience: "https://school.example/exchange",
    algorithms: ["RS256"], credential: "person",
  },
};
