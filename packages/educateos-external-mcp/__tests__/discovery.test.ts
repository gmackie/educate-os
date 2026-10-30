import { describe, it, expect, vi } from "vitest";
import { discoverIssuer, readMcpConfig } from "../src/discovery.ts";
import { CONFIG } from "./config.ts";
import { readFileSync } from "node:fs";
import { renderWorkerConfig } from "../../../scripts/generate-worker-configs.ts";
import { fileURLToPath } from "node:url";

describe("deployment trust", () => {
  it("pins exact metadata issuer, JWKS and token endpoint origin", async () => {
    const metadata = { issuer: CONFIG.issuer.issuer, jwks_uri: CONFIG.issuer.jwksUri, token_endpoint: `${CONFIG.issuer.issuer}/token` };
    const fetcher = vi.fn(async () => Response.json(metadata));
    await expect(discoverIssuer(CONFIG.issuer, fetcher)).resolves.toBeTypeOf("function");
    expect(fetcher).toHaveBeenCalledWith(CONFIG.issuer.metadataUrl, expect.objectContaining({ redirect: "error" }));
    for (const override of [{ issuer: "https://evil.example" }, { jwks_uri: "https://evil.example/keys" }, { token_endpoint: "https://evil.example/token" }]) {
      await expect(discoverIssuer(CONFIG.issuer, async () => Response.json({ ...metadata, ...override }))).rejects.toThrow();
    }
    await expect(discoverIssuer(CONFIG.issuer, async () => new Response("x".repeat(65537), { headers: { "content-type": "application/json" } }))).rejects.toThrow();
  });
  it("rejects insecure, cross-origin or credential-bearing configuration without echoing student data", () => {
    expect(readMcpConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
    for (const issuer of [{ ...CONFIG.issuer, metadataUrl: "https://evil.example/meta" }, { ...CONFIG.issuer, jwksUri: "http://issuer.example/keys" }, { ...CONFIG.issuer, issuer: "https://user:secret@issuer.example" }]) {
      expect(() => readMcpConfig(JSON.stringify({ ...CONFIG, issuer }))).toThrow(/^Invalid MCP_CONFIG$/);
    }
  });
  it("ships generated district binding and migration without Workshop or central credential services", async () => {
    const dir = fileURLToPath(new URL("../deploy/", import.meta.url));
    const generated = await renderWorkerConfig(dir);
    expect(readFileSync(`${dir}/wrangler.jsonc`, "utf8")).toBe(generated);
    expect(generated).toContain('"McpDistrict"');
    expect(generated).toContain('"new_sqlite_classes"');
    expect(generated).toContain('"../src/worker.ts"');
    expect(generated).not.toContain('"services"');
    expect(generated).not.toContain('"invocation_logs": true');
  });
});
