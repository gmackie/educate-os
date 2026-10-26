// Submission receipts signed with the district's Ed25519 key, so a student, parent or auditor can
// check one offline, holding only the district's public key. The signing and verification
// primitives are the fleet protocol's (`@educateos/fleet`), as its signed envelopes use them.
import { z } from "zod";
import { DistrictId } from "@educateos/contracts";
import { Ed25519Signature, KeyId, canonicalJson, keyIdFor, verifySignature, type Ed25519PublicKey, type SigningIdentity } from "@educateos/fleet";
import { isSubmissionDigestOf } from "./digest.ts";
import { SubmissionReceipt } from "./model.ts";

/**
 * A submission receipt with the district's signature. The signature covers a fixed context string,
 * the district ID and the canonical JSON of the receipt, so it never verifies for another district
 * or as any other kind of signed message. `keyId` names the key; a verifier looks the key up among
 * the district keys it already trusts and never takes one from the receipt.
 */
export const SignedSubmissionReceipt = z.strictObject({
  receipt: SubmissionReceipt,
  districtId: DistrictId,
  signature: z.strictObject({ alg: z.literal("Ed25519"), keyId: KeyId, value: Ed25519Signature }),
});
/** A signed submission receipt. */
export type SignedSubmissionReceipt = z.infer<typeof SignedSubmissionReceipt>;

const CONTEXT = "educateos-submission-receipt/v1";
/** SCHO-232: the signing context of receipts signed before the EducateOS rename. */
const LEGACY_CONTEXT = "schoolos-submission-receipt/v1";

function signedBytes(districtId: DistrictId, receipt: SubmissionReceipt, context = CONTEXT): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${context}\0${districtId}\0${canonicalJson(receipt)}`);
}

/** Signs `receipt` as `districtId`'s, with the district's receipt key. */
export async function signSubmissionReceipt(
  receipt: SubmissionReceipt,
  districtId: DistrictId,
  key: SigningIdentity,
): Promise<SignedSubmissionReceipt> {
  const parsed = SubmissionReceipt.parse(receipt);
  return {
    receipt: parsed,
    districtId,
    signature: { alg: "Ed25519", keyId: key.keyId, value: await key.sign(signedBytes(districtId, parsed)) },
  };
}

/**
 * The receipt, if `input` is a receipt `districtId` signed with one of `trustedKeys` and its digest
 * is the digest of the items it lists; otherwise `undefined`. It needs no network and no EducateOS
 * service. Anyone also holding the submitted revisions can then check each item's digest against
 * them.
 */
export async function verifySubmissionReceipt(
  input: unknown,
  districtId: DistrictId,
  trustedKeys: readonly Ed25519PublicKey[],
): Promise<SubmissionReceipt | undefined> {
  const parsed = SignedSubmissionReceipt.safeParse(input);
  if (!parsed.success || parsed.data.districtId !== districtId) return undefined;
  const { receipt, signature } = parsed.data;
  if (!(await isSubmissionDigestOf(receipt.items, receipt.submissionDigest))) return undefined;
  for (const publicKey of trustedKeys) {
    if ((await keyIdFor(publicKey)) !== signature.keyId) continue;
    // A receipt signed before the EducateOS rename was signed under the legacy context (SCHO-232).
    for (const context of [CONTEXT, LEGACY_CONTEXT]) {
      if (await verifySignature(publicKey, signature.value, signedBytes(districtId, receipt, context))) return receipt;
    }
    return undefined;
  }
  return undefined;
}
