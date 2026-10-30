import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { DistrictDirectorySnapshot } from "@educateos/contracts";

/** Only deployment configuration may name issuer, metadata or key URLs. */
export function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error("An absolute HTTPS URL without credentials, query or fragment is required");
  return url;
}
const Https = z.string().refine((value) => { try { httpsUrl(value); return true; } catch { return false; } });
const Origin = Https.refine((value) => new URL(value).origin === value);

/** District-owned deployment settings. Directory seed is private configuration, never metadata. */
export const McpWorkerConfig = z.strictObject({
  origin: Origin,
  directory: DistrictDirectorySnapshot,
  allowedOrigins: z.array(Origin).max(30),
  issuer: z.strictObject({
    issuer: Https,
    metadataUrl: Https,
    jwksUri: Https,
    exchangeAudience: Https,
    algorithms: z.array(z.enum(["RS256", "PS256", "ES256", "EdDSA"])).min(1),
    credential: z.enum(["person", "service"]),
  }),
});
/** Validated Worker settings. */
export type McpWorkerConfig = z.infer<typeof McpWorkerConfig>;

/** Parse privately: errors never echo directory records or credentials. */
export function readMcpConfig(text: string): McpWorkerConfig {
  try {
    const config = McpWorkerConfig.parse(JSON.parse(text));
    if (new URL(config.issuer.metadataUrl).origin !== new URL(config.issuer.issuer).origin ||
        new URL(config.issuer.jwksUri).origin !== new URL(config.issuer.issuer).origin ||
        config.issuer.exchangeAudience === `${config.origin}/mcp`)
      throw new Error();
    return config;
  } catch { throw new Error("Invalid MCP_CONFIG"); }
}

/** Discover only the configured issuer; redirects, issuer mismatch and key URL substitution fail closed. */
export async function discoverIssuer(
  config: McpWorkerConfig["issuer"],
  fetcher: typeof fetch = fetch,
): Promise<JWTVerifyGetKey> {
  const response = await fetcher(config.metadataUrl, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
    throw new Error("Issuer metadata unavailable");
  // Metadata is bounded just like incoming client messages.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing metadata");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("Oversized metadata");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); reader.releaseLock(); }
  const metadata = z.object({ issuer: z.string(), jwks_uri: z.string(), token_endpoint: Https }).parse(JSON.parse(text));
  if (metadata.issuer !== config.issuer || metadata.jwks_uri !== config.jwksUri ||
      new URL(metadata.token_endpoint).origin !== new URL(config.issuer).origin)
    throw new Error("Issuer discovery mismatch");
  // jose rejects redirecting JWKS requests; no token-controlled jku/x5u is consulted.
  return createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5000, cooldownDuration: 30000 });
}
