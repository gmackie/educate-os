import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { authorityFor, createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { createSchoolMcpApi } from "../src/index.ts";
import {
  createBuiltInMcpOAuth,
  InMemoryMcpOAuthStorage,
  isAllowedRedirectUri,
} from "../src/oauth-server.ts";
import { lmsSchoolTools } from "../src/lms-tools.ts";
import { AcademicDirectory } from "@educateos/academics";
import { SchoolToolRunner } from "@educateos/policy";

const ORIGIN = "https://school.northfield.example";
const RESOURCE = `${ORIGIN}/mcp`;
const MORGAN = NORTHFIELD.principals.find((p) => p.id === "prn_nf-morgan-lee")!;
const STUDENT = NORTHFIELD.principals.find((p) => p.kind === "student")!;
const BIO = NORTHFIELD.offerings.find((o) => o.id === "off_nf-bio-fall-p2")!;

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setupBuiltIn(fetchClientMetadata?: typeof fetch) {
  const stores = inMemoryDistrictStores(NORTHFIELD);
  let browserPrincipal: { principalId: typeof MORGAN.id; districtId: typeof MORGAN.districtId } | null = {
    principalId: MORGAN.id,
    districtId: MORGAN.districtId,
  };
  const app = await createDistrictApp({
    stores,
    authority: "local",
    verifyRequest: async () => undefined,
    importFetch: async () => { throw new Error("not used"); },
  });
  const directory = new AcademicDirectory({ store: stores.directory, authority: authorityFor("local"), authorizer: app.engine });
  const oauth = createBuiltInMcpOAuth({
    origin: ORIGIN,
    districtId: app.districtId,
    allowedOrigins: [],
    storage: new InMemoryMcpOAuthStorage(),
    directory: async () => (await stores.directory.load()).snapshot,
    delegations: stores.delegations,
    policy: app.engine,
    mcpTokens: stores.mcpTokens,
    authenticateBrowser: async () => browserPrincipal,
    ...(fetchClientMetadata === undefined ? {} : { fetchClientMetadata }),
  });
  const runner = new SchoolToolRunner({
    engine: app.engine,
    tools: lmsSchoolTools(app, stores.directory, directory),
    approvals: { store: stores.toolApprovals },
  });
  const mcp = createSchoolMcpApi({
    districtId: app.districtId,
    runner,
    tokens: oauth,
    allowedOrigins: [],
    allowDrafts: true,
    resource: { origin: ORIGIN, authorizationServers: [ORIGIN], scopes: ["mcp:tools"] },
  });
  return {
    app,
    stores,
    oauth,
    mcp,
    setBrowserPrincipal: (next: typeof browserPrincipal) => { browserPrincipal = next; },
  };
}

describe("built-in Cloudflare OAuth 2.1 server and scoped bearer tokens", () => {
  it("validates redirect URIs strictly", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:4321/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("publishes RFC 8414 metadata and JWKS, registers clients (RFC 7591), runs PKCE S256 consent + token + refresh rotation, and authorizes /mcp", async () => {
    const { oauth, mcp, stores } = await setupBuiltIn();

    const metaRes = await oauth.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json() as Record<string, unknown>;
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);

    const jwksRes = await oauth.fetch(new Request(`${ORIGIN}/.well-known/jwks.json`));
    expect(jwksRes.status).toBe(200);
    const jwks = await jwksRes.json() as { keys: { alg: string; kty: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.alg).toBe("ES256");

    // 1. Dynamic client registration
    const regRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Desktop",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    }));
    expect(regRes.status).toBe(201);
    const reg = await regRes.json() as { client_id: string };
    expect(reg.client_id).toMatch(/^mcpc_/);
    expect(await oauth.listClients()).toHaveLength(1);

    // 2. GET /oauth/authorize behind Cloudflare Access
    const verifier = "v".repeat(64);
    const challenge = await sha256Base64Url(verifier);
    const authUrl = new URL(`${ORIGIN}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);
    authUrl.searchParams.set("scope", "mcp:tools");
    authUrl.searchParams.set("state", "xyz-state");

    const consentRes = await oauth.fetch(new Request(authUrl));
    expect(consentRes.status).toBe(200);
    const html = await consentRes.text();
    expect(html).toContain("Claude Desktop");
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();

    // 3. POST /oauth/authorize approves consent and issues a real IF-06 delegation + single-use code
    const approveRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        nonce: nonce!,
        scopeId: `offering:${BIO.id}`,
        access: "read-write",
        durationHours: "24",
        decision: "approve",
      }).toString(),
    }));
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz-state");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^edua_/);

    // 4. Wrong PKCE verifier is rejected (and code is consumed atomically)
    const badTokenRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "wrong-verifier-that-is-still-long-enough-for-pkce-check",
        resource: RESOURCE,
      }).toString(),
    }));
    expect(badTokenRes.status).toBe(400);

    // Re-authorize cleanly for happy-path token exchange
    const consentRes2 = await oauth.fetch(new Request(authUrl));
    const nonce2 = /name="nonce" value="([^"]+)"/.exec(await consentRes2.text())![1]!;
    const approveRes2 = await oauth.fetch(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        nonce: nonce2,
        scopeId: `offering:${BIO.id}`,
        access: "read-write",
        durationHours: "24",
        decision: "approve",
      }).toString(),
    }));
    const code2 = new URL(approveRes2.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2,
        client_id: reg.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    }));
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toMatch(/^edur_/);

    // 5. Call /mcp with the minted OAuth access token
    const callRes = await mcp.fetch(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_roster", arguments: { offeringId: BIO.id } } }),
    }));
    expect(callRes.status).toBe(200);
    const callJson = await callRes.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(callJson.result.content[0]!.text)).toMatchObject({ status: "ok" });

    // 6. Refresh token rotates and invalidates the old refresh token
    const refreshRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    }));
    expect(refreshRes.status).toBe(200);
    const rotated = await refreshRes.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Reusing old refresh token fails
    const replayRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    }));
    expect(replayRes.status).toBe(400);

    // 7. The replay means the chain leaked: the delegation is revoked, so the rotated refresh token
    // and the live access token both stop working.
    expect((await stores.delegations.list()).filter((d) => d.revoked === undefined)).toHaveLength(0);
    const rotatedRefreshRes = await oauth.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    }));
    expect(rotatedRefreshRes.status).toBe(400);
    const afterRevoke = await mcp.fetch(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${rotated.access_token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }));
    expect(afterRevoke.status).toBe(403);
  });

  it("holds Client ID Metadata Document clients to the redirect URIs their document lists", async () => {
    const clientId = "https://client.example/oauth/metadata.json";
    const fetched: string[] = [];
    const { oauth } = await setupBuiltIn(async (input) => {
      fetched.push(String(input));
      return Response.json({ client_id: clientId, client_name: "Example Client", redirect_uris: ["https://client.example/callback"] });
    });
    const authorize = async (redirectUri: string) => {
      const url = new URL(`${ORIGIN}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", await sha256Base64Url("v".repeat(64)));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("resource", RESOURCE);
      return oauth.fetch(new Request(url));
    };

    // An attacker reusing a real client's ID cannot send the code to their own server.
    expect((await authorize("https://evil.example/cb")).status).toBe(400);
    const ok = await authorize("https://client.example/callback");
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Example Client");
    expect(html).toContain("client.example");
    expect(fetched).toEqual([clientId, clientId]);
  });

  it("rejects a Client ID Metadata Document that names a different client", async () => {
    const { oauth } = await setupBuiltIn(async () =>
      Response.json({ client_id: "https://other.example/meta.json", redirect_uris: ["https://evil.example/cb"] }));
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "https://client.example/oauth/metadata.json");
    url.searchParams.set("redirect_uri", "https://evil.example/cb");
    url.searchParams.set("code_challenge", await sha256Base64Url("v".repeat(64)));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", RESOURCE);
    expect((await oauth.fetch(new Request(url))).status).toBe(400);
  });

  it("refuses students on /oauth/authorize", async () => {
    const { oauth, setBrowserPrincipal } = await setupBuiltIn();
    setBrowserPrincipal({ principalId: STUDENT.id, districtId: STUDENT.districtId });
    const res = await oauth.fetch(new Request(`${ORIGIN}/oauth/authorize?response_type=code`));
    expect(res.status).toBe(403);
  });

  it("authenticates scoped personal bearer tokens minted through the Management UI and stops on revocation", async () => {
    const { app, oauth, mcp } = await setupBuiltIn();
    const minted = await app.callForTool(
      "teacher.createMcpToken",
      {
        body: {
          label: "My CLI",
          scope: { level: "offering", districtId: BIO.districtId, schoolId: BIO.schoolId, offeringId: BIO.id },
          access: "read-only",
          durationHours: 24,
        },
      },
      { principal: { districtId: MORGAN.districtId, principalId: MORGAN.id }, channel: "http", correlationId: "cor-1", origin: ORIGIN },
    );
    expect(minted.token).toMatch(/^edum_/);

    const verified = await oauth.authenticate(minted.token);
    expect(verified.principalId).toBe(MORGAN.id);
    expect(verified.delegationId).toBe(minted.delegation.id);

    // Call /mcp with the scoped bearer token
    const okRes = await mcp.fetch(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${minted.token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_modules", arguments: { offeringId: BIO.id } } }),
    }));
    expect(okRes.status).toBe(200);

    // Revoke the token via the Management UI API -> immediately rejected with 401
    await app.callForTool(
      "teacher.revokeMcpToken",
      { params: { tokenId: minted.record.id } },
      { principal: { districtId: MORGAN.districtId, principalId: MORGAN.id }, channel: "http", correlationId: "cor-2", origin: ORIGIN },
    );
    const revokedRes = await mcp.fetch(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${minted.token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }));
    expect(revokedRes.status).toBe(401);
  });
});
