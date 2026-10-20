import { z } from "zod";
import { CapabilityId, ConfigRevisionId, DistrictId, OfferingId, PrincipalId, SchoolId } from "./ids";
import { ScopeLevel } from "./scope";

/** A semantic version (`1.4.0`, `0.2.0-beta.1`). */
export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "expected a semantic version");
/** A semantic version string. */
export type SemVer = z.infer<typeof SemVer>;

/** Platform resources a capability pack may need provisioned in the district's account. */
export const PlatformResource = z.enum([
  "worker",
  "durable-object",
  "d1",
  "kv",
  "r2",
  "queue",
  "workflow",
  "ai-gateway",
  "artifacts",
  "ci-sandbox",
]);
/** A platform resource. */
export type PlatformResource = z.infer<typeof PlatformResource>;

/**
 * An installable, dependency-declared SchoolOS module (roadmap §4). Packs are reviewed and
 * version-pinned packages, never code fetched and run at install time; the manifest only describes
 * what the pack needs and may do.
 *
 * `configSchema` is a JSON Schema document. The same schema validates the API, the CLI and the
 * generated administrator forms, so there are no hand-written controls that can drift from it.
 */
export const CapabilityManifest = z.strictObject({
  id: CapabilityId,
  version: SemVer,
  description: z.string().min(1).max(500),
  dependencies: z.array(z.strictObject({ id: CapabilityId, versionRange: z.string().min(1) })),
  conflicts: z.array(CapabilityId).optional(),
  configSchema: z.record(z.string(), z.unknown()),
  /** A named defaults profile, e.g. `us-k12-conservative`. */
  defaultsProfile: z.string().min(1).optional(),
  supportedScopes: z.array(ScopeLevel).min(1),
  /** Authorization actions the pack's services may request, as `<resource-kind>:<action>`. */
  permissionScopes: z.array(z.string().regex(/^[a-z-]+:[a-z-]+$/)),
  requiredResources: z.array(PlatformResource),
  optionalResources: z.array(PlatformResource).optional(),
  migrations: z.array(z.string().min(1)),
  probes: z.array(z.string().min(1)),
  estimatedCostDrivers: z.array(z.string().min(1)),
});
/** A capability manifest. */
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

/**
 * Installed, enabled and exposed are separate states (roadmap §4). A pack can be installed but
 * off, on for a district but not yet visible in any classroom, or exposed to selected offerings.
 */
export const CapabilityActivationState = z.enum(["installed", "enabled", "exposed"]);
/** A capability activation state. */
export type CapabilityActivationState = z.infer<typeof CapabilityActivationState>;

/** The scope a configuration revision applies to. */
export const ConfigurationScope = z
  .strictObject({
    districtId: DistrictId,
    schoolId: SchoolId.optional(),
    offeringId: OfferingId.optional(),
  })
  .refine((scope) => scope.offeringId === undefined || scope.schoolId !== undefined, {
    message: "an offering scope must name its school",
  });
/** A configuration scope. */
export type ConfigurationScope = z.infer<typeof ConfigurationScope>;

/** Where a configuration revision is in being applied. */
export const ConfigurationRevisionStatus = z.enum(["draft", "validating", "applying", "applied", "failed"]);
/** A configuration revision status. */
export type ConfigurationRevisionStatus = z.infer<typeof ConfigurationRevisionStatus>;

/**
 * One revision of a scope's configuration. Revisions are immutable once applied and chained by
 * `previousRevisionId`, which is what gives administrators diff, audit and rollback. Secrets never
 * appear in `desired` or `observed`; they are bound through Worker secrets.
 */
export const ConfigurationRevision = z.strictObject({
  id: ConfigRevisionId,
  scope: ConfigurationScope,
  schemaVersion: z.string().min(1),
  desired: z.record(z.string(), z.unknown()),
  observed: z.record(z.string(), z.unknown()).optional(),
  status: ConfigurationRevisionStatus,
  actorPrincipalId: PrincipalId,
  previousRevisionId: ConfigRevisionId.optional(),
});
/** A configuration revision. */
export type ConfigurationRevision = z.infer<typeof ConfigurationRevision>;
