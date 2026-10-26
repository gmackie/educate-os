import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  CloudflareHttpApi,
  createPkcePair,
  districtRunTokenProvider,
  exchangeAuthorizationCode,
  INSTALLER_SCOPES,
  isCredentialFailure,
  OAuthTokenProvider,
  pkceChallenge,
  staticTokenProvider,
} from "../src/index.ts";

const TOKEN = "synthetic-secret-token-value";
const ACCOUNT = "a1".repeat(16);

type Handler = (request: Request) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return await handler(request);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ok = (result: unknown, resultInfo?: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });

describe("Cloudflare HTTP client", () => {
  it("sends the bearer token and walks every page of a paged list", async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      const page = Number(new URL(request.url).searchParams.get("page"));
      return ok([{ id: `kv-${page}`, title: `t${page}`, extra: "ignored" }], { page, total_pages: 3 });
    });
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });

    expect(await api.listKvNamespaces(ACCOUNT)).toEqual([
      { id: "kv-1", title: "t1" },
      { id: "kv-2", title: "t2" },
      { id: "kv-3", title: "t3" },
    ]);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(Array(3).fill(`/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces`));
    expect(requests.every((r) => r.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reads a success envelope whose errors and result_info are null, as GET /workers/domains answers", async () => {
    // Seen live on 2026-10-26 (SCHO-206): `{"success":true,"errors":null,"messages":null,...}`.
    const { fetchImpl } = stubFetch(() => Response.json({
      success: true, errors: null, messages: null, result_info: null,
      result: [{ id: "d1", hostname: "northfield.educateos.io", service: "router", zone_id: "z1", zone_name: "educateos.io", environment: "production" }],
    }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });

    expect(await api.listWorkerDomains(ACCOUNT)).toEqual([{ id: "d1", hostname: "northfield.educateos.io", service: "router", zoneId: "z1" }]);
  });

  it("never follows a redirect, so the token can't leave api.cloudflare.com", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response(null, { status: 307, headers: { location: "https://evil.example/" } }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    await expect(api.listKvNamespaces(ACCOUNT)).rejects.toMatchObject({ status: 307 });
    expect(requests.map((r) => [new URL(r.url).host, r.redirect])).toEqual([["api.cloudflare.com", "manual"]]);
  });

  it("turns a revoked token into a credential failure whose message never carries the token", async () => {
    const { fetchImpl } = stubFetch(() =>
      Response.json({ success: false, errors: [{ code: 9109, message: `Invalid access token ${TOKEN}` }], result: null }, { status: 401 }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("oauth", TOKEN), fetch: fetchImpl });

    const error = await api.createKvNamespace(ACCOUNT, "educateos-northfield-blueprints").catch((e: unknown) => e);

    expect(isCredentialFailure(error)).toBe(true);
    expect(error).toMatchObject({ code: "unauthenticated", operation: "createKvNamespace", status: 401, cloudflareCodes: [9109] });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("classifies a missing permission as a credential failure too, so the reconciler stops", async () => {
    const { fetchImpl } = stubFetch(() => Response.json({ success: false, errors: [{ code: 10000 }], result: null }, { status: 403 }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("oauth", TOKEN), fetch: fetchImpl });
    const error = await api.listAccessApplications(ACCOUNT).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(isCredentialFailure(error)).toBe(true);
  });

  it("uploads a script as multipart with typed module parts and keeps secrets bound", async () => {
    const { fetchImpl, requests } = stubFetch(() => ok({ id: "educateos-northfield-router" }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    await api.uploadWorkerScript(ACCOUNT, "educateos-northfield-router", {
      metadata: { main_module: "index.js", compatibility_flags: [], bindings: [], keep_bindings: ["secret_text"], observability: { enabled: true } },
      modules: [{ name: "index.js", type: "esm", bytes: new TextEncoder().encode("export default {}") }],
    });

    const form = await requests[0]!.formData();
    expect(requests[0]!.method).toBe("PUT");
    expect(JSON.parse(await (form.get("metadata") as Blob).text())).toMatchObject({ main_module: "index.js", keep_bindings: ["secret_text"] });
    expect((form.get("index.js") as Blob).type).toBe("application/javascript+module");
  });

  it("deletes a script without force, and reads each version's service bindings", async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") return ok(null);
      if (path.endsWith("/versions")) return ok({ items: [{ id: "v1", metadata: { created_on: "2026-10-20T00:00:00Z" } }] });
      return ok({ resources: { bindings: [
        { type: "plain_text", name: "EDUCATEOS_RELEASE_ID", text: "r1" },
        { type: "service", name: "AI_CALL_GUARD", service: "educateos-northfield-educateos-ai-guard", entrypoint: "EducateOsAiCallGuard" },
      ] } });
    });
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });

    await api.deleteWorkerScript(ACCOUNT, "educateos-northfield-educateos-ai-guard");
    expect(requests[0]!.method).toBe("DELETE");
    expect(new URL(requests[0]!.url).pathname).toBe(`/client/v4/accounts/${ACCOUNT}/workers/scripts/educateos-northfield-educateos-ai-guard`);
    expect(new URL(requests[0]!.url).searchParams.has("force")).toBe(false);

    expect(await api.listWorkerVersions(ACCOUNT, "educateos-northfield-workshop-backend")).toEqual([{
      id: "v1",
      createdOn: "2026-10-20T00:00:00Z",
      vars: { EDUCATEOS_RELEASE_ID: "r1" },
      serviceBindings: [{ name: "AI_CALL_GUARD", service: "educateos-northfield-educateos-ai-guard" }],
    }]);
  });

  it("authenticates asset uploads with the session JWT, not the account token", async () => {
    const { fetchImpl, requests } = stubFetch(() => ok({ jwt: "completion-jwt" }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    const completion = await api.uploadAssets(ACCOUNT, "session-jwt", new Map([["0".repeat(32), new TextEncoder().encode("<html>")]]));
    expect(completion).toBe("completion-jwt");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer session-jwt");
  });

  it("speaks Cloudflare for SaaS: TXT-validated custom hostnames, and SaaS being off read as such", async () => {
    const { fetchImpl, requests } = stubFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/fallback_origin")) {
        // Verbatim shape from a live zone without SaaS (SCHO-241): no `result` key at all.
        return Response.json({ success: false, errors: [{ code: 1456, message: "available with SSL for SaaS" }], messages: [] }, { status: 401 });
      }
      return ok(request.method === "POST"
        ? { id: "ch-1", hostname: "northfield.educateos.io", status: "pending", ssl: { status: "initializing" } }
        : [{
          id: "ch-1",
          hostname: "northfield.educateos.io",
          status: "pending",
          ssl: { status: "pending_validation", validation_records: [{ txt_name: "_acme-challenge.northfield.educateos.io", txt_value: "cert-1" }] },
          ownership_verification: { type: "txt", name: "_cf-custom-hostname.northfield.educateos.io", value: "own-1" },
        }]);
    });
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });

    // Cloudflare answers 401 here, which must not read as a revoked credential.
    expect(await api.getFallbackOrigin("zone-1")).toEqual({ saas: false });
    // Validation values can be missing from the create response; they are read back later.
    expect(await api.createCustomHostname("zone-1", "northfield.educateos.io")).toMatchObject({ id: "ch-1", certificateValidation: [] });
    expect(await requests[1]!.json()).toEqual({ hostname: "northfield.educateos.io", ssl: { method: "txt", type: "dv" } });
    expect(await api.findCustomHostname("zone-1", "northfield.educateos.io")).toEqual({
      id: "ch-1",
      hostname: "northfield.educateos.io",
      status: "pending",
      sslStatus: "pending_validation",
      ownership: { name: "_cf-custom-hostname.northfield.educateos.io", value: "own-1" },
      certificateValidation: [{ name: "_acme-challenge.northfield.educateos.io", value: "cert-1" }],
    });
    expect(new URL(requests[2]!.url).searchParams.get("hostname")).toBe("northfield.educateos.io");
  });

  it("reads a SaaS zone with no fallback origin as SaaS on, origin unset", async () => {
    // Verbatim from hbtply.com, SaaS on and no fallback origin (SCHO-241).
    const { fetchImpl } = stubFetch(() =>
      Response.json({ success: false, errors: [{ code: 1551, message: "Resource not found." }], messages: [] }, { status: 404 }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    expect(await api.getFallbackOrigin("zone-1")).toEqual({ saas: true });
  });

  it("writes every Access destination and reads them back, primary first", async () => {
    const { fetchImpl, requests } = stubFetch(() => ok({
      id: "app-1",
      name: "educateos-northfield",
      domain: "educateos.northfield.example",
      destinations: [{ type: "public", uri: "educateos.northfield.example" }, { type: "public", uri: "northfield.educateos.io" }],
      aud: "aud-1",
      policies: [{ id: "pol-1" }],
    }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    const app = await api.createAccessApplication(ACCOUNT, {
      name: "educateos-northfield",
      domain: "educateos.northfield.example",
      destinations: ["educateos.northfield.example", "northfield.educateos.io"],
      type: "self_hosted",
      sessionDuration: "12h",
      policyIds: ["pol-1"],
    });
    expect(await requests[0]!.json()).toMatchObject({
      domain: "educateos.northfield.example",
      destinations: [{ type: "public", uri: "educateos.northfield.example" }, { type: "public", uri: "northfield.educateos.io" }],
    });
    expect(app.destinations).toEqual(["educateos.northfield.example", "northfield.educateos.io"]);
  });

  it("reads a DNS record's ownership comment, null as empty", async () => {
    const { fetchImpl } = stubFetch(() => ok([{ id: "r1", type: "CNAME", name: "northfield.educateos.io", content: "x.example", proxied: false, comment: null }]));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    expect(await api.listDnsRecords("zone-1", "northfield.educateos.io")).toEqual([
      { id: "r1", type: "CNAME", name: "northfield.educateos.io", content: "x.example", proxied: false, comment: "" },
    ]);
  });

  it("reads a success whose errors are null, as the Workers custom domains list answers", async () => {
    const { fetchImpl } = stubFetch(() => Response.json({
      result: [], success: true, errors: null, messages: null,
      result_info: { page: 1, per_page: 0, count: 0, total_count: 0 },
    }));
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", TOKEN), fetch: fetchImpl });
    expect(await api.listWorkerDomains(ACCOUNT)).toEqual([]);
  });

  it("reads the district-run token from the environment and fails cleanly without it", async () => {
    await expect(districtRunTokenProvider({ CLOUDFLARE_API_TOKEN: TOKEN }).accessToken()).resolves.toBe(TOKEN);
    const { fetchImpl, requests } = stubFetch(() => ok({}));
    const api = new CloudflareHttpApi({ tokens: districtRunTokenProvider({}), fetch: fetchImpl });
    await expect(api.getAccount(ACCOUNT)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(requests).toHaveLength(0);
  });
});

describe("OAuth with PKCE", () => {
  it("computes the RFC 7636 S256 challenge: unpadded base64url of SHA-256(verifier)", async () => {
    const verifier = "synthetic-verifier-0123456789-abcdefghijklmnop";
    expect(await pkceChallenge(verifier)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const pair = await createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(await pkceChallenge(pair.verifier));
  });

  it("asks for consent with a public client: S256 challenge, state and the installer's scopes, no secret", async () => {
    const pkce = await createPkcePair();
    const url = buildAuthorizationUrl({ clientId: "educateos-installer", redirectUri: "https://educateos.example/oauth/callback", state: "st", pkce });
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(INSTALLER_SCOPES.map((s) => s.scope));
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.toString()).not.toContain(pkce.verifier);
  });

  it("exchanges the code with the verifier and refreshes before expiry", async () => {
    let now = 1_000_000;
    const bodies: URLSearchParams[] = [];
    const { fetchImpl } = stubFetch(async (request) => {
      bodies.push(new URLSearchParams(await request.text()));
      return Response.json({ access_token: `at-${bodies.length}`, refresh_token: `rt-${bodies.length}`, expires_in: 3600, token_type: "bearer" });
    });
    const context = { clientId: "educateos-installer", fetch: fetchImpl, now: () => now };
    const tokens = await exchangeAuthorizationCode({ ...context, redirectUri: "https://educateos.example/cb", code: "code-1", verifier: "v".repeat(43) });
    expect(bodies[0]!.get("code_verifier")).toBe("v".repeat(43));
    expect(bodies[0]!.has("client_secret")).toBe(false);

    const provider = new OAuthTokenProvider(tokens, context);
    expect(await provider.accessToken()).toBe("at-1");
    now += 3600 * 1000 - 30_000;
    expect(await provider.accessToken()).toBe("at-2");
    expect(bodies[1]!.get("grant_type")).toBe("refresh_token");
    expect(bodies[1]!.get("refresh_token")).toBe("rt-1");
  });
});
