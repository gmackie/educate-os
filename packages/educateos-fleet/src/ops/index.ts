// The signed ops protocol (SCHO-263): what an admin edition (admin.educateos.io or the OSS admin)
// sends to a district's `/api/ops/*`, how it is signed and verified, which scope each route needs,
// and the typed bodies both sides parse. A separate entry point from the fleet protocol, since its
// directory and device bodies carry personal data, which the fleet protocol never does.
export * from "./scopes.ts";
export * from "./signing.ts";
export * from "./schemas.ts";
export { Ed25519PrivateJwk, Ed25519PublicKey, KeyId, keyIdFor, SigningIdentity } from "../identity.ts";
