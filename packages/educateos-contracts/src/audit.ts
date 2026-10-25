import { z } from "zod";
import { DistrictId, PrincipalId } from "./ids.ts";
import { UtcTimestamp } from "./primitives.ts";

/** The principal an audit event records as acting. Only the ID: an audit log never copies a profile. */
export const AuditActor = z.strictObject({ principalId: PrincipalId });
/** An audit actor. */
export type AuditActor = z.infer<typeof AuditActor>;

/**
 * The fields every district audit event starts from: whose district, who acted and when. A
 * package's event extends it with a closed `action` vocabulary and a `target` of identifiers only,
 * so an audit log never becomes a second copy of the directory or of any content.
 */
export const AuditEventBase = z.strictObject({
  districtId: DistrictId,
  actor: AuditActor,
  at: UtcTimestamp,
});
/** The base of a district audit event. */
export type AuditEventBase = z.infer<typeof AuditEventBase>;
