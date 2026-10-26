import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import { canonicalJson } from "./encoding.ts";
import {
  Ed25519PublicKey,
  Ed25519Signature,
  KeyId,
  keyIdFor,
  type SigningIdentity,
  verifySignature,
} from "./identity.ts";

/**
 * The kinds of signed fleet message. The kind is part of the signed bytes but not of the
 * envelope, so a signature made for one kind (a heartbeat) never verifies as another (a
 * revocation), whatever the payloads look like.
 *
 * `student-transfer` and `consent-revocation` are signed with a district agent's key but sent
 * district to district, never through the root (ADR-0001): a transfer package's statement and the
 * notice that withdraws its consent (`@educateos/portability`).
 */
export const FleetMessageKind = z.enum([
  "registration",
  "rekey",
  "heartbeat",
  "management-revocation",
  "release-decision",
  "release-offer",
  "support-session-request",
  "entitlement",
  "student-transfer",
  "consent-revocation",
]);
/** A fleet message kind. */
export type FleetMessageKind = z.infer<typeof FleetMessageKind>;

/**
 * A signed fleet message. `signature` covers the protocol version, the message kind and the
 * canonical JSON of `payload` (see {@link canonicalJson}), so whitespace or key order picked up in
 * transit doesn't break it. `keyId` names the signing key; verifiers look the key up themselves
 * and never trust a key carried alongside the signature.
 */
export const SignedEnvelope = z.strictObject({
  payload: z.json(),
  signature: Ed25519Signature,
  keyId: KeyId,
});
/** A signed envelope. */
export type SignedEnvelope = z.infer<typeof SignedEnvelope>;

const PROTOCOL_CONTEXT = "educateos-fleet/v1";
/** SCHO-232: the context of envelopes signed before the EducateOS rename, which still verify. */
const LEGACY_PROTOCOL_CONTEXT = "schoolos-fleet/v1"; // rename-educateos: keep

// `slice()` gives a view over a plain `ArrayBuffer` under every runtime's typings (ADR-0009).
function signedBytes(kind: FleetMessageKind, payload: unknown, context = PROTOCOL_CONTEXT): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${context}\0${kind}\0${canonicalJson(payload)}`).slice();
}

/**
 * Signs a payload as a message of the given kind. The envelope carries the canonical form of the
 * payload, so it holds exactly the bytes that were signed and nothing else.
 */
export async function signEnvelope(
  identity: SigningIdentity,
  kind: FleetMessageKind,
  payload: unknown,
): Promise<SignedEnvelope> {
  const bytes = signedBytes(kind, payload);
  return {
    payload: JSON.parse(canonicalJson(payload)),
    signature: await identity.sign(bytes),
    keyId: identity.keyId,
  };
}

/**
 * Whether the envelope is a message of `kind` signed by `publicKey`. The envelope's `keyId` must
 * name that key, which stops a valid signature by one key being presented under another key's ID.
 */
export async function verifyEnvelope(
  envelope: SignedEnvelope,
  kind: FleetMessageKind,
  publicKey: Ed25519PublicKey,
): Promise<boolean> {
  if (envelope.keyId !== (await keyIdFor(publicKey))) return false;
  for (const context of [PROTOCOL_CONTEXT, LEGACY_PROTOCOL_CONTEXT]) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = signedBytes(kind, envelope.payload, context);
    } catch {
      return false;
    }
    if (await verifySignature(publicKey, envelope.signature, bytes)) return true;
  }
  return false;
}

/**
 * Parses untrusted wire input against a schema, converting failure into a `validation-failed`
 * error. The error names only what was being parsed, never the offending values, which could be
 * exactly the personal data the schema exists to keep out.
 */
export function parseWire<T extends z.ZodType>(schema: T, input: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new EducateOsError("validation-failed", `malformed ${what}`);
  return result.data;
}
