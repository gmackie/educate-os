// The configuration rules: redirect URIs the fakes must never use, and how callers are counted.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clientKeyOf, redirectUrisOf, redirectUrisProblem } from "../src/config.ts";
import worker from "./worker.ts";
import { ORIGIN } from "./constants.ts";
import { assertion } from "./helpers.ts";

describe("OIDC_REDIRECT_URIS", () => {
  it("fills in the district, and accepts district-side https callbacks", () => {
    const config = { OIDC_REDIRECT_URIS: "https://{slug}.educateos.io/api/sso/callback, https://app.example/cb" };
    expect(redirectUrisOf(config, "harbor")).toEqual(["https://harbor.educateos.io/api/sso/callback", "https://app.example/cb"]);
    expect(redirectUrisProblem(config)).toBeUndefined();
  });

  it("refuses a Cloudflare Access callback, at any depth or case, and anything not https", () => {
    for (const uris of [
      "https://gmacko.cloudflareaccess.com/cdn-cgi/access/callback",
      "https://app.example/cb,https://Other.CloudflareAccess.com./cdn-cgi/access/callback",
      "https://cloudflareaccess.com/x",
      "http://{slug}.educateos.io/api/sso/callback",
      "not a url",
    ]) {
      expect(redirectUrisProblem({ OIDC_REDIRECT_URIS: uris }), uris).toBeDefined();
    }
    expect(redirectUrisProblem({ OIDC_REDIRECT_URIS: "https://cloudflareaccess.com.example/cb" })).toBeUndefined();
  });

  it("makes the Worker serve no fake and no admin request while one is refused", async () => {
    const misconfigured = { ...env, OIDC_REDIRECT_URIS: "https://gmacko.cloudflareaccess.com/cdn-cgi/access/callback" };
    const fetchWith = async (path: string, headers: Record<string, string> = {}) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>, misconfigured, ctx);
      await waitOnExecutionContext(ctx);
      return { status: response.status, text: await response.text() };
    };
    expect((await fetchWith("/cedarvalley/clever/.well-known/openid-configuration")).status).toBe(503);
    expect((await fetchWith("/_admin/cedarvalley/credentials", { "cf-access-jwt-assertion": await assertion() })).status).toBe(503);
    expect((await fetchWith("/healthz")).status).toBe(200);
  });
});

describe("clientKeyOf", () => {
  it("counts IPv4 by address and IPv6 by /64", () => {
    expect(clientKeyOf("192.0.2.7")).toBe("192.0.2.7");
    expect(clientKeyOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKeyOf("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKeyOf("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    expect(clientKeyOf(null)).toBe("unknown");
  });
});
