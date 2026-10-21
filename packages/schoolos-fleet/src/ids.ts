import { z } from "zod";

const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";

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
