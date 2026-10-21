// A stand-in for a district IdP. It signs HS256 tokens with a per-instance random key, so a token
// minted by one district's fake IdP never verifies at another's, just as with real issuers. It
// uses only Web Crypto and `btoa`/`atob`, so it runs unchanged under Node and workerd.

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

/** The claims a verified token proves. Anything else a token carries is ignored. */
export interface VerifiedIdentity {
  /** The token's issuer. */
  issuer: string;
  /** The token's subject. */
  subject: string;
}

/** Options for {@link FakeIdentityProvider.issueToken}. */
export interface IssueOptions {
  /** Lifetime in seconds. Negative values mint an already-expired token, for tests. */
  ttlSeconds?: number;
  /** Extra claims, such as a role a test wants to show is ignored. */
  extraClaims?: Record<string, unknown>;
}

/** A fake IdP for one issuer. */
export class FakeIdentityProvider {
  /** The issuer URL this IdP signs as. */
  readonly issuer: string;
  readonly #key: Promise<CryptoKey>;

  constructor(issuer: string) {
    this.issuer = issuer;
    this.#key = crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  /** Mints a signed token for `subject`. */
  async issueToken(subject: string, options: IssueOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = encodeJson({ alg: "HS256", typ: "JWT" });
    const payload = encodeJson({
      ...options.extraClaims,
      iss: this.issuer,
      sub: subject,
      iat: now,
      exp: now + (options.ttlSeconds ?? 3600),
    });
    const signature = await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  /**
   * Verifies a token this IdP issued. Returns null for anything else: a bad signature, another
   * issuer, an algorithm other than HS256, an expired token or malformed input.
   */
  async verifyToken(token: string): Promise<VerifiedIdentity | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const valid = await crypto.subtle.verify(
        "HMAC",
        await this.#key,
        base64UrlDecode(signature),
        encoder.encode(`${header}.${payload}`),
      );
      if (!valid) return null;
      const decodedHeader: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(header)));
      const claims: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
      if (typeof decodedHeader !== "object" || decodedHeader === null) return null;
      if ((decodedHeader as { alg?: unknown }).alg !== "HS256") return null;
      if (typeof claims !== "object" || claims === null) return null;
      const { iss, sub, exp } = claims as { iss?: unknown; sub?: unknown; exp?: unknown };
      if (iss !== this.issuer || typeof sub !== "string" || sub === "") return null;
      if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000)) return null;
      return { issuer: iss, subject: sub };
    } catch {
      return null;
    }
  }
}
