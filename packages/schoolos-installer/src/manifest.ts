// The release manifest as this installer consumes it. The producer is
// `scripts/release/manifest-lib.ts` (`generateManifest`); this file mirrors its `ReleaseManifest`
// shape as a strict schema rather than importing it, because the manifest arrives as bytes from a
// release bucket and must be validated, and because the installer must refuse a manifest whose
// placeholder vocabulary it does not know (`manifestVersion`).
import { SchoolOsError, SemVer } from "@schoolos/contracts";
import { z } from "zod";
import { sha256Hex } from "./digest.ts";

/** The manifest version this installer renders. It must equal manifest-lib's `MANIFEST_VERSION`. */
export const SUPPORTED_MANIFEST_VERSION = 1;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256");
const PackageName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "expected a workspace package name");
const BindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "expected a binding name");

/** The module types the script-upload API accepts (manifest-lib's `ModuleType`). */
export const ModuleType = z.enum(["esm", "text", "wasm", "data"]);
/** A module type. */
export type ModuleType = z.infer<typeof ModuleType>;

/** One uploadable module, content-addressed in the release bucket. */
export const ManifestModule = z.strictObject({
  name: z.string().min(1).max(256),
  type: ModuleType,
  sha256: Sha256Hex,
  size: z.number().int().nonnegative(),
  r2Key: z.string().min(1),
});
/** A manifest module. */
export type ManifestModule = z.infer<typeof ManifestModule>;

/**
 * One Durable Object migration step, verbatim from wrangler.jsonc. Loose on purpose, like
 * manifest-lib's `DurableObjectMigration`: the installer replays the steps, it does not interpret
 * them, so a step kind it has not seen still passes through.
 */
export const DurableObjectMigration = z.looseObject({
  tag: z.string().min(1).max(64),
  new_sqlite_classes: z.array(z.string().min(1)).optional(),
});
/** A Durable Object migration step. */
export type DurableObjectMigration = z.infer<typeof DurableObjectMigration>;

/**
 * A binding template. These are exactly the binding shapes manifest-lib emits, plus `d1`, which
 * manifest version 1 does not emit yet (see {@link D1Migration}).
 */
export const ManifestBinding = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("kv_namespace"), name: BindingName, namespace_id: z.string() }),
  z.strictObject({ type: z.literal("r2_bucket"), name: BindingName, bucket_name: z.string() }),
  z.strictObject({ type: z.literal("d1"), name: BindingName, id: z.string() }),
  z.strictObject({ type: z.literal("browser"), name: BindingName }),
  z.strictObject({ type: z.literal("ai"), name: BindingName }),
  z.strictObject({ type: z.literal("worker_loader"), name: BindingName }),
  z.strictObject({
    type: z.literal("service"),
    name: BindingName,
    service: z.string(),
    entrypoint: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("assets"), name: BindingName }),
  z.strictObject({ type: z.literal("secret_text"), name: BindingName, text: z.string() }),
]);
/** A binding template. */
export type ManifestBinding = z.infer<typeof ManifestBinding>;

/** One user-supplied value the deploy wizard collects (manifest-lib's `DeployInput`). */
export const DeployInput = z.strictObject({
  name: BindingName,
  kind: z.enum(["secret", "var", "workerName"]),
  label: z.string(),
  help: z.string().optional(),
  consoleUrl: z.string().optional(),
  setupSteps: z.array(z.string()).optional(),
  redirectUriTemplate: z.string().optional(),
});
/** A deploy input. */
export type DeployInput = z.infer<typeof DeployInput>;

/** A static asset's content key and size. */
export const AssetManifestEntry = z.strictObject({ hash: z.string().regex(/^[0-9a-f]{32}$/), size: z.number().int().nonnegative() });
/** An asset manifest entry. */
export type AssetManifestEntry = z.infer<typeof AssetManifestEntry>;

/**
 * A D1 migration a worker's database needs, in apply order. Manifest version 1 does not emit D1
 * at all; the installer accepts this ahead of the generator so SchoolOS domain workers can ship
 * D1-backed state without an installer change. A follow-up teaches manifest-lib to emit it.
 */
export const D1Migration = z.strictObject({
  /** The `d1` binding whose database the migration runs against. */
  binding: BindingName,
  /** Unique, ordered migration ID, e.g. `0001_principals`. */
  id: z.string().regex(/^[0-9]{4}_[a-z0-9_]{1,60}$/),
  sha256: Sha256Hex,
  size: z.number().int().nonnegative(),
  r2Key: z.string().min(1),
});
/** A D1 migration. */
export type D1Migration = z.infer<typeof D1Migration>;

const ObservabilityConfig = z.looseObject({ enabled: z.boolean() });

/** Everything the manifest says about one worker (manifest-lib's `WorkerEntry`). */
export const WorkerEntry = z.strictObject({
  kind: z.enum(["backend", "router", "gatekeeper"]),
  shortName: z.string().regex(/^[a-z][a-z0-9]{0,19}$/).optional(),
  installable: z.boolean(),
  preinstall: z.literal(true).optional(),
  singleton: z.literal(true).optional(),
  mainModule: z.string().min(1),
  modules: z.array(ManifestModule).min(1),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compatibilityFlags: z.array(z.string()),
  migrations: z.array(DurableObjectMigration),
  bindings: z.array(ManifestBinding),
  vars: z.record(z.string(), z.unknown()),
  observability: ObservabilityConfig,
  gatekeeperBindingExpansion: z.strictObject({
    entrypoint: z.string().optional(),
    propsByPackage: z.record(PackageName, z.record(z.string(), z.unknown())),
  }).optional(),
  assetsConfig: z.strictObject({
    not_found_handling: z.string().optional(),
    run_worker_first: z.array(z.string()).optional(),
    variants: z.record(z.string(), z.strictObject({ manifest: z.record(z.string(), AssetManifestEntry) })),
  }).optional(),
  inputs: z.array(DeployInput).optional(),
  d1Migrations: z.array(D1Migration).optional(),
});
/** A worker entry. */
export type WorkerEntry = z.infer<typeof WorkerEntry>;

/** The release manifest. */
export const ReleaseManifest = z.strictObject({
  manifestVersion: z.literal(SUPPORTED_MANIFEST_VERSION),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "expected a release ID"),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  createdAt: z.iso.datetime(),
  wranglerVersion: z.string().min(1),
  workers: z.record(PackageName, WorkerEntry),
  assets: z.record(z.string(), z.strictObject({ size: z.number().int().nonnegative(), r2Key: z.string() })),
});
/** A release manifest. */
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/**
 * Pins the release a district installs: its ID, the version the fleet registry is told, and the
 * SHA-256 of the exact manifest bytes. Manifests are not yet signed (the root signs releases from
 * R03 on), so this digest, which the district records in its install config, is what stops a
 * substituted manifest.
 */
export const ReleasePin = z.strictObject({
  releaseId: z.string().min(1),
  version: SemVer,
  manifestSha256: Sha256Hex,
});
/** A release pin. */
export type ReleasePin = z.infer<typeof ReleasePin>;

/**
 * Verifies manifest bytes against a pin and parses them. Fails with `validation-failed` on a
 * digest or release ID mismatch, an unsupported manifest version, or any unknown field.
 */
export async function loadPinnedManifest(bytes: Uint8Array<ArrayBuffer>, pin: ReleasePin): Promise<ReleaseManifest> {
  const digest = await sha256Hex(bytes);
  if (digest !== pin.manifestSha256) {
    throw new SchoolOsError("validation-failed", "release manifest does not match the pinned SHA-256");
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SchoolOsError("validation-failed", "release manifest is not JSON");
  }
  const parsed = ReleaseManifest.safeParse(json);
  if (!parsed.success) {
    throw new SchoolOsError("validation-failed", `release manifest rejected: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.releaseId !== pin.releaseId) {
    throw new SchoolOsError("validation-failed", "release manifest is for a different release than the pin");
  }
  return parsed.data;
}
