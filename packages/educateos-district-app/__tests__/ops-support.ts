// Signed ops requests for the district's /api/ops tests (SCHO-263), made with the admin edition's
// own signing code from `@educateos/fleet/ops`, and the registration it shows an operator, which a
// district administrator pastes into district /admin → Operations. Not a test file.
import { signOpsRequest, SigningIdentity, type OpsScope } from "@educateos/fleet/ops";
import type { OpsRegistrationBundle } from "../src/index.ts";
import type { TestDistrict } from "./support.ts";

/** Where the test admin edition runs. */
export const ADMIN_ORIGIN = "https://admin.educateos.io";
/** The operator the test admin acts for. */
export const OPERATOR = "ops@educateos.io";
/** Every scope, as the admin edition asks for them. */
export const ALL_SCOPES: OpsScope[] = ["health", "analytics", "directory:read", "directory:write", "devices", "releases"];

/** An admin edition's ops key and the registration it shows (`OpsRegistration` in `@educateos/admin`). */
export async function adminKey(scopes: OpsScope[] = ALL_SCOPES): Promise<{ identity: SigningIdentity; registration: OpsRegistrationBundle }> {
  const identity = await SigningIdentity.generate();
  return { identity, registration: { adminOrigin: ADMIN_ORIGIN, keyId: identity.keyId, publicKey: identity.publicKey, scopes } };
}

/** Enrolls a new admin key through district /admin → Operations, granting `granted`. */
export async function enrolledKey(district: TestDistrict, admin: string, granted: OpsScope[] = ALL_SCOPES): Promise<SigningIdentity> {
  const { identity, registration } = await adminKey();
  await district.ok(district.tokenFor(admin), "admin.enrollOpsKey", { body: { registration, scopes: granted } });
  return identity;
}

/** What {@link opsRequest} may override, to make a bad request. */
export interface OpsRequestOptions {
  body?: unknown;
  /** The signing time. Defaults to the district's clock. */
  at?: number;
  nonce?: string;
  operator?: string;
  /** Replaces the signature after signing. */
  signature?: string;
}

/** A signed ops request, as the admin edition sends it. */
export async function opsRequest(identity: SigningIdentity, clock: { now: number }, method: string, path: string, options: OpsRequestOptions = {}): Promise<Request> {
  const url = new URL(path, "https://district.example");
  const body = options.body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(options.body);
  const headers = await signOpsRequest(identity, {
    method,
    url,
    operator: options.operator ?? OPERATOR,
    now: new Date(options.at ?? clock.now),
    ...(body === undefined ? {} : { body }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  if (options.signature !== undefined) headers["educateos-ops-signature"] = options.signature;
  return new Request(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
}
