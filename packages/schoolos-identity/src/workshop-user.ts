import { z } from "zod";

/**
 * Identifies an existing Workshop user: the string form of its `UserDurableObject` ID, which the
 * kernel derives today from `idFromName(email)`. Opaque here. It is not a principal ID and never
 * becomes one; migration only links a Workshop user to a principal once an administrator confirms.
 */
export const WorkshopUserId = z.string().regex(/^[0-9a-f]{1,128}$/, "expected a Workshop user Durable Object ID").brand<"workshopUser">();
/** A Workshop user identifier. */
export type WorkshopUserId = z.infer<typeof WorkshopUserId>;
