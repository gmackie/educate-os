import { z } from "zod";

const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";

/**
 * Identifies one SchoolOS deployment in the root's registry. It is chosen by the district and is
 * opaque to the root: nothing derives it from a person, and it is distinct from the district's own
 * `DistrictId` so the root never learns district-local identifiers.
 */
export const InstanceId = z
  .string()
  .regex(new RegExp(`^ins_${ID_BODY}$`), "expected an instance ID (ins_…)")
  .brand<"instance">();
/** An instance identifier. */
export type InstanceId = z.infer<typeof InstanceId>;

/**
 * References the district's account in the commercial system. Contact details (names, emails,
 * phone numbers) live only there; the fleet protocol carries this opaque reference instead.
 */
export const CommercialAccountId = z
  .string()
  .regex(new RegExp(`^acct_${ID_BODY}$`), "expected a commercial account ID (acct_…)")
  .brand<"commercialAccount">();
/** A commercial account identifier. */
export type CommercialAccountId = z.infer<typeof CommercialAccountId>;

/** Identifies one support session request, so its approval and audit entries can refer to it. */
export const SupportSessionId = z
  .string()
  .regex(new RegExp(`^sup_${ID_BODY}$`), "expected a support session ID (sup_…)")
  .brand<"supportSession">();
/** A support session identifier. */
export type SupportSessionId = z.infer<typeof SupportSessionId>;

/**
 * A short machine-readable code (`d1.unreachable`, `scheduled-maintenance`). Codes stand in for
 * free text on the wire, because free text is where personal data would leak.
 */
export const OpaqueCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "expected an opaque code");
/** An opaque code. */
export type OpaqueCode = z.infer<typeof OpaqueCode>;
