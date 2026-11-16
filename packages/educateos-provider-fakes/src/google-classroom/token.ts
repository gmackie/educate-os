// A fake of Google's OAuth 2.0 token endpoint for service accounts with domain-wide delegation
// (https://developers.google.com/identity/protocols/oauth2/service-account): the JWT-bearer grant
// (RFC 7523) a district's Classroom sync makes, with the assertion signed by the service account's
// key and acting as a Workspace user (`sub`). Tokens it issues are Classroom tokens of a
// `GoogleClassroomFake`, so a test exercises the whole path: key, delegation, token, Classroom.
//
// Built from Google's documentation. Error strings follow it and common reports; not verified:
// - an undelegated scope answers 401 `unauthorized_client` (Google's documented message);
// - an unknown or suspended `sub` answers 400 `invalid_grant` "Invalid email or User ID";
// - a bad signature or unknown key answers 400 `invalid_grant` "Invalid JWT Signature.".
import { importSPKI, jwtVerify } from "jose";
import { Fake, type FakeOptions } from "../fake.ts";
import type { GoogleClassroomFake } from "./fake.ts";

/** Google's token endpoint, the assertions' audience. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** A service account the domain delegated scopes to. */
export interface Delegation {
  /** The service account's email, the assertion's `iss`. */
  readonly clientEmail: string;
  /** Its public key, SPKI PEM. */
  readonly publicKeyPem: string;
  /** The scopes the Workspace administrator delegated to it, exactly. */
  readonly scopes: readonly string[];
}

/** A synthetic service account: the JSON key file a district downloads, and its public key. */
export interface SyntheticServiceAccount {
  /** The key file as Google writes it (the fields a client reads), private key included. */
  readonly keyFile: { type: "service_account"; project_id: string; private_key_id: string; private_key: string; client_email: string; client_id: string; token_uri: string };
  readonly publicKeyPem: string;
}

const pem = (label: string, der: unknown) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der as ArrayBuffer))).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** Generates a service account key for tests: RSA 2048, as Google issues. */
export async function syntheticServiceAccount(clientEmail: string, clientId = "100000000000000000001"): Promise<SyntheticServiceAccount> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as { privateKey: CryptoKey; publicKey: CryptoKey };
  return {
    keyFile: {
      type: "service_account",
      project_id: "synthetic-project",
      private_key_id: "synthetic-key-1",
      private_key: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      client_email: clientEmail,
      client_id: clientId,
      token_uri: GOOGLE_TOKEN_ENDPOINT,
    },
    publicKeyPem: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

/** Options of a {@link GoogleServiceAccountTokenFake}. */
export interface GoogleServiceAccountTokenFakeOptions extends FakeOptions {
  /** The Classroom fake the issued tokens are good for; `sub` is matched to its seed people by email. */
  readonly classroom: GoogleClassroomFake;
  /** The emails of the seed's people, by person ID, so `sub` can be resolved. */
  readonly people: readonly { readonly id: string; readonly email: string }[];
  readonly delegations?: readonly Delegation[];
}

const error = (status: number, code: string, description: string) =>
  new Response(JSON.stringify({ error: code, error_description: description }), { status, headers: { "content-type": "application/json" } });

/** Google's token endpoint for delegated service accounts, over a {@link GoogleClassroomFake}. */
export class GoogleServiceAccountTokenFake extends Fake {
  readonly #classroom: GoogleClassroomFake;
  readonly #people: Map<string, string>;
  readonly #delegations = new Map<string, Delegation>();

  constructor(options: GoogleServiceAccountTokenFakeOptions) {
    super(options);
    this.#classroom = options.classroom;
    this.#people = new Map(options.people.map((person) => [person.email.toLowerCase(), person.id]));
    for (const delegation of options.delegations ?? []) this.delegate(delegation);
  }

  /** Grants (or replaces) a service account's domain-wide delegation. */
  delegate(delegation: Delegation): void {
    this.#delegations.set(delegation.clientEmail, delegation);
  }

  /** Withdraws a delegation, as removing the client in the Admin console does. */
  revoke(clientEmail: string): void {
    this.#delegations.delete(clientEmail);
  }

  protected override async serve(request: Request, body: string): Promise<Response> {
    if (new URL(request.url).pathname !== "/token") return error(404, "not_found", "Not Found");
    if (request.method !== "POST") return error(405, "invalid_request", "Method not allowed");
    const form = new URLSearchParams(body);
    if (form.get("grant_type") !== JWT_BEARER) return error(400, "unsupported_grant_type", "Invalid grant_type: " + (form.get("grant_type") ?? ""));
    const assertion = form.get("assertion");
    if (!assertion) return error(400, "invalid_request", "Missing required parameter: assertion");
    const [encoded] = assertion.split(".").slice(1, 2);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(atob((encoded ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    } catch {
      return error(400, "invalid_grant", "Invalid JWT: cannot parse");
    }
    const delegation = typeof claims.iss === "string" ? this.#delegations.get(claims.iss) : undefined;
    if (delegation === undefined) return error(401, "unauthorized_client", "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.");
    try {
      await jwtVerify(assertion, await importSPKI(delegation.publicKeyPem, "RS256"), {
        issuer: delegation.clientEmail, audience: GOOGLE_TOKEN_ENDPOINT, algorithms: ["RS256"], currentDate: new Date(this.now()),
      });
    } catch {
      return error(400, "invalid_grant", "Invalid JWT Signature.");
    }
    const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
    if (scopes.length === 0 || !scopes.every((scope) => delegation.scopes.includes(scope))) {
      return error(401, "unauthorized_client", "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.");
    }
    const userId = typeof claims.sub === "string" ? this.#people.get(claims.sub.toLowerCase()) : undefined;
    if (userId === undefined) return error(400, "invalid_grant", "Invalid email or User ID");
    const token = this.#classroom.issueToken({ userId, scopes });
    return new Response(JSON.stringify({ access_token: token, expires_in: 3599, token_type: "Bearer" }), { headers: { "content-type": "application/json" } });
  }

  protected override errorResponse(status: number): Response {
    return error(status, status === 429 ? "rate_limit_exceeded" : "internal_failure", status === 429 ? "Rate limit exceeded" : "Backend Error");
  }

  protected override removeLargeShare(): void {
    // A token endpoint holds no roster.
  }
}
