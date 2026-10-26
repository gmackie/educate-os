// Calls into the Worker as the public and the operator do. Every response body is read here: an
// unread SELF.fetch body keeps its object busy, and evicting it would then hang.
import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { ACCESS_ISSUER } from "../src/access.ts";
import { ADMIN_AUDIENCE, ORIGIN } from "./constants.ts";

/** A read response. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  json<T = Record<string, any>>(): T;
}

/** A request to the Worker, read in full. `ip` is the caller's address (CF-Connecting-IP). */
export async function call(url: string | URL, init: RequestInit & { ip?: string } = {}): Promise<Answer> {
  const { ip, ...rest } = init;
  const request = new Request(new URL(url, ORIGIN), { redirect: "manual", ...rest });
  request.headers.set("cf-connecting-ip", ip ?? "192.0.2.1");
  const response = await SELF.fetch(request);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: <T>() => JSON.parse(text) as T };
}

/**
 * A `fetch` for a client under test, from one address, with every body read before it returns.
 * workerd rejects `redirect: "error"`, which the OneRoster client sends; the fakes never redirect a
 * client like it, so "manual" behaves the same.
 */
export function clientFetch(ip: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, { ...init, redirect: "manual" });
    request.headers.set("cf-connecting-ip", ip);
    const response = await SELF.fetch(request);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

/** An Access assertion for the admin application, signed with this run's key unless told otherwise. */
export async function assertion(options: { audience?: string; key?: JWK; issuer?: string; withoutExpiry?: boolean } = {}): Promise<string> {
  const jwk = options.key ?? (JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK);
  const key = await importJWK(jwk, "RS256");
  const jwt = new SignJWT({ common_name: "test-service-token.access", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "test-access-key" })
    .setIssuer(options.issuer ?? ACCESS_ISSUER)
    .setAudience(options.audience ?? ADMIN_AUDIENCE)
    .setIssuedAt();
  return (options.withoutExpiry === true ? jwt : jwt.setExpirationTime("5m")).sign(key);
}

/** An admin request with a valid assertion. */
export async function admin(path: string, init: RequestInit = {}): Promise<Answer> {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await assertion());
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return call(`/_admin/${path}`, { ...init, headers, ip: "198.51.100.200" });
}

/** A district's credentials, through the admin surface. */
export async function credentials(slug: string): Promise<Record<string, any>> {
  const answer = await admin(`${slug}/credentials`);
  if (answer.status !== 200) throw new Error(`credentials of ${slug}: ${answer.status} ${answer.text}`);
  return answer.json();
}
