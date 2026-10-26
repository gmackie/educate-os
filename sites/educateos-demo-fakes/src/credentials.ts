// The credentials of each district's fakes, derived from the Worker secret `FAKES_SECRET`: HMAC-
// SHA-256 of the secret over `<slug>:<purpose>`. The fakes' own defaults derive credentials from the
// public seed (a Clever district token from the seed ID, a fixed OneRoster client), which anyone
// with the repository could compute; these need the secret. Deterministic, so a restart (or an
// evicted Durable Object) serves the same credentials the districts were configured with, and
// rotating the secret rotates them all.
import type { Vendor } from "./layout.ts";

/** The shortest `FAKES_SECRET` accepted: 32 characters. Anything shorter serves no fakes. */
export const MIN_SECRET_LENGTH = 32;

/** An OAuth client of an OIDC fake. */
export interface OidcClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Every credential of one district's fakes. Only those its profile uses are present. */
export interface DistrictCredentials {
  readonly clever?: { readonly districtToken: string; readonly oidc: OidcClientCredentials };
  readonly classlink?: { readonly oidc: OidcClientCredentials };
  readonly google?: { readonly oidc: OidcClientCredentials };
  readonly oneroster?: { readonly clientId: string; readonly clientSecret: string };
}

/** Whether `secret` is usable: set, and at least {@link MIN_SECRET_LENGTH} characters. */
export function secretUsable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  // Cast: Workers' typings widen importKey's result.
  return (await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
}

/** `bytes` bytes derived from the secret for `label`, expanded by counter past 32. */
async function derive(key: CryptoKey, label: string, bytes: number): Promise<Uint8Array> {
  const out = new Uint8Array(bytes);
  for (let block = 0, filled = 0; filled < bytes; block++) {
    const mac = new Uint8Array((await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${label}\u0000${block}`))) as ArrayBuffer);
    out.set(mac.subarray(0, Math.min(mac.length, bytes - filled)), filled);
    filled += mac.length;
  }
  return out;
}

const hex = (bytes: Uint8Array, length: number) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
const digits = (bytes: Uint8Array, length: number) => [...bytes].map((b) => String(b % 10)).join("").slice(0, length);
const lowerAlnum = (bytes: Uint8Array, length: number) => [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("").slice(0, length);
const base64url = (bytes: Uint8Array, length: number) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "").slice(0, length);

/**
 * The credentials of `slug`'s fakes, in each vendor's shape: Clever's 20-hex client IDs and 40-hex
 * secrets and tokens, a ClassLink-style `c…` client ID, Google's `…apps.googleusercontent.com` IDs
 * and `GOCSPX-` secrets, and hex OneRoster keys.
 */
export async function deriveCredentials(secret: string, slug: string, vendors: readonly Vendor[]): Promise<DistrictCredentials> {
  const key = await hmacKey(secret);
  const take = (purpose: string, bytes: number) => derive(key, `${slug}:${purpose}`, bytes);
  const credentials: {
    clever?: DistrictCredentials["clever"];
    classlink?: DistrictCredentials["classlink"];
    google?: DistrictCredentials["google"];
    oneroster?: DistrictCredentials["oneroster"];
  } = {};
  if (vendors.includes("clever")) {
    credentials.clever = {
      districtToken: hex(await take("clever:district-token", 20), 40),
      oidc: { clientId: hex(await take("clever:client-id", 10), 20), clientSecret: hex(await take("clever:client-secret", 20), 40) },
    };
  }
  if (vendors.includes("classlink")) {
    credentials.classlink = { oidc: { clientId: `c${digits(await take("classlink:client-id", 13), 13)}`, clientSecret: hex(await take("classlink:client-secret", 20), 40) } };
  }
  if (vendors.includes("google")) {
    const project = digits(await take("google:project", 12), 12).replace(/^0/, "1");
    credentials.google = {
      oidc: {
        clientId: `${project}-${lowerAlnum(await take("google:client-id", 32), 32)}.apps.googleusercontent.com`,
        clientSecret: `GOCSPX-${base64url(await take("google:client-secret", 21), 28)}`,
      },
    };
  }
  if (vendors.includes("oneroster")) {
    credentials.oneroster = { clientId: hex(await take("oneroster:client-id", 16), 32), clientSecret: hex(await take("oneroster:client-secret", 20), 40) };
  }
  return credentials;
}
