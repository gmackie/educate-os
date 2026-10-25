import { z } from "zod";

const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";

/** Identifies one support session request, so its approval and audit entries can refer to it. */
export const SupportSessionId = z
  .string()
  .regex(new RegExp(`^sup_${ID_BODY}$`), "expected a support session ID (sup_…)")
  .brand<"supportSession">();
/** A support session identifier. */
export type SupportSessionId = z.infer<typeof SupportSessionId>;
