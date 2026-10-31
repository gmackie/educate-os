import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT } from "jose";
import { DurableTokenStore } from "../../src/token-store.ts";
import { CONFIG } from "../config.ts";
import { testIssuerKeys } from "./worker.ts";

it("serves health and RFC9728 metadata without exposing school records", async () => {
  const health = await SELF.fetch("https://school.example/healthz");
  expect(await health.json()).toEqual({ status: "ok" });
  const response = await SELF.fetch("https://school.example/.well-known/oauth-protected-resource/mcp");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: "https://school.example/mcp", scopes_supported: ["mcp:tools"] });
  expect((await SELF.fetch("https://evil.example/healthz")).status).toBe(403);
});
it("boots real durable district stores and safely challenges missing or invalid authentication", async () => {
  for (const token of ["", "Bearer private-invalid-token"]) {
    const response = await SELF.fetch("https://school.example/mcp", { method: "POST", headers: {
      "content-type": "application/json", authorization: token,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('resource_metadata="https://school.example/.well-known/oauth-protected-resource/mcp"');
    expect(await response.text()).toBe("");
  }
});
it("uses transactional durable replay and grants across separate object invocations", async () => {
  const stub = env.MCP_DISTRICT.getByName("replay-test");
  const results = await Promise.all([1, 2].map(() => runInDurableObject(stub, async (_instance, state) => new DurableTokenStore(state.storage).claimAssertion("issuer-jti", Date.now() + 300000))));
  expect(results.toSorted()).toEqual([false, true]);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new DurableTokenStore(state.storage);
    await store.putAccess("digest", { identity: { issuer: "https://id.example", subject: "synthetic", credential: "person" }, expiresAt: Date.now() + 300000, scopes: ["mcp:tools"] });
  });
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new DurableTokenStore(state.storage);
    expect((await store.getAccess("digest"))?.scopes).toEqual(["mcp:tools"]);
    await store.revokeAccess("digest");
    expect(await store.getAccess("digest")).toBeUndefined();
  });
});
it("serves a 2026-07-28 exchange from the pinned SDK on workerd", async () => {
  const { privateKey } = await testIssuerKeys();
  const morgan = CONFIG.directory.principals.find((p) => p.id === "prn_nf-morgan-lee")!;
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({ scope: "mcp:tools" }).setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
    .setIssuer(CONFIG.issuer.issuer).setSubject(morgan.externalIdentities[0]!.subject).setAudience("https://school.example/mcp")
    .setIssuedAt(now).setExpirationTime(now + 120).sign(privateKey);
  const transport = new StreamableHTTPClientTransport(new URL("https://school.example/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: (url, init) => SELF.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "workerd", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("get_roster");
  await client.close();
});
