import { ReleaseChannel } from "@schoolos/fleet";
import { z } from "zod";
import { MigrationNote, type ReleaseManifestStatement, ReleaseId, Sha256Hex } from "./manifest.ts";

/**
 * How a district takes releases: the one channel it subscribes to, and whether releases on that
 * channel may be approved without a person. Canary releases always need a person, so the schema
 * refuses a canary policy that auto-applies. Even an auto-applying policy approves only forward
 * upgrades with no irreversible migration; rollbacks and irreversible migrations always wait for
 * the district.
 */
export const DistrictReleasePolicy = z
  .strictObject({
    channel: ReleaseChannel,
    autoApply: z.boolean(),
  })
  .refine((policy) => !(policy.channel === "canary" && policy.autoApply), {
    message: "canary releases always require district approval",
  });
/** A district release policy. */
export type DistrictReleasePolicy = z.infer<typeof DistrictReleasePolicy>;

/** One change a dry run found between what is deployed and what the release wants. */
export const DriftChange = z.strictObject({
  /** The installer's resource key, e.g. `worker:workshop-backend`. */
  resource: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  action: z.enum(["create", "update", "delete", "refuse", "needs-input"]),
  reason: z.string().max(500),
});
/** A drift change. */
export type DriftChange = z.infer<typeof DriftChange>;

/**
 * What installing a release would change in the district's account, from the installer's dry-run
 * plan against the verified manifest (`@schoolos/installer`'s `dryRunDrift`). The district reviews
 * it before approving, and it is checked again right before applying, because the account may
 * have changed in between.
 */
export const DriftReport = z.strictObject({
  releaseId: ReleaseId,
  manifestSha256: Sha256Hex,
  /** False when preflight or the plan is blocked: the release can't be applied as things stand. */
  ready: z.boolean(),
  changes: z.array(DriftChange),
  /** D1 migrations the release would run that the account has not applied. None can be undone. */
  pendingMigrations: z.array(MigrationNote.shape.migrationId),
});
/** A drift report. */
export type DriftReport = z.infer<typeof DriftReport>;

/**
 * The migrations the district must acknowledge before a release is applied: every pending D1
 * migration in the dry run (the installer never reverses one) and every migration the root itself
 * marked irreversible. The dry run is computed locally from the verified manifest, so a root that
 * leaves a migration out of its notes still can't slip it past the gate.
 */
export function requiredAcknowledgements(statement: ReleaseManifestStatement, drift: DriftReport): string[] {
  const required = new Set(drift.pendingMigrations);
  for (const note of statement.migrations) if (note.irreversible) required.add(note.migrationId);
  return [...required].toSorted();
}
