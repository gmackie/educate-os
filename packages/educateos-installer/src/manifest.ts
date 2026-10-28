// The release manifest as this installer consumes it. The producer is
// `scripts/release/manifest-lib.ts` (`generateManifest`); this file mirrors its `ReleaseManifest`
// shape as a strict schema rather than importing it, because the manifest arrives as bytes from a
// release bucket and must be validated, and because the installer must refuse a manifest whose
// placeholder vocabulary it does not know (`manifestVersion`).
import { EducateOsError, SemVer } from "@educateos/contracts";
import {
  RELEASE_INSTALL_GRACE_MS,
  type ReleaseManifestStatement,
  ReleaseTrust,
  verifySignedReleaseManifest,
} from "@educateos/releases";
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
 * The file the release pipeline writes the root's signed statement to, beside `manifest.json`
 * (scripts/release/release-signing.ts's `SIGNED_MANIFEST_FILE`).
 */
export const SIGNED_MANIFEST_FILE = "manifest.signed.json";

/** A binding template. These are exactly the binding shapes manifest-lib emits. */
export const ManifestBinding = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("kv_namespace"), name: BindingName, namespace_id: z.string() }),
  z.strictObject({ type: z.literal("r2_bucket"), name: BindingName, bucket_name: z.string() }),
  z.strictObject({ type: z.literal("d1"), name: BindingName, id: z.string() }),
  z.strictObject({ type: z.literal("browser"), name: BindingName }),
  z.strictObject({ type: z.literal("ai"), name: BindingName }),
  z.strictObject({ type: z.literal("send_email"), name: BindingName }),
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
  /**
   * Secrets only: the installer generates the value when the Worker has none (32 random bytes,
   * base64url) and never rotates it, so nobody supplies it.
   */
  generated: z.literal(true).optional(),
}).refine((input) => input.generated === undefined || input.kind === "secret", "only a secret input can be generated");
/** A deploy input. */
export type DeployInput = z.infer<typeof DeployInput>;

/** A static asset's content key and size. */
export const AssetManifestEntry = z.strictObject({ hash: z.string().regex(/^[0-9a-f]{32}$/), size: z.number().int().nonnegative() });
/** An asset manifest entry. */
export type AssetManifestEntry = z.infer<typeof AssetManifestEntry>;

/**
 * A D1 migration a worker's database needs, in apply order: manifest-lib's `D1MigrationEntry`,
 * read from the package's `migrations_dir`. The SQL is a content-addressed release blob.
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
  kind: z.enum(["backend", "router", "gatekeeper", "service"]),
  shortName: z.string().regex(/^[a-z][a-z0-9]{0,19}$/).optional(),
  /**
   * Services only: the service binding the backend gains once the service is installed. The
   * district installer installs a service only when the config enables it (`services`).
   */
  backendBinding: z.strictObject({ name: BindingName, entrypoint: z.string().min(1) }).optional(),
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
  /**
   * Cron Trigger schedules the worker runs on (today only the AI call guard's, a service). The
   * district installer does not install services yet (SCHO-131); it accepts and ignores them.
   */
  crons: z.array(z.string().min(1).max(100)).optional(),
  gatekeeperBindingExpansion: z.strictObject({
    entrypoint: z.string().optional(),
    propsByPackage: z.record(PackageName, z.record(z.string(), z.unknown())),
  }).optional(),
  assetsConfig: z.strictObject({
    not_found_handling: z.string().optional(),
    run_worker_first: z.array(z.string()).optional(),
    variants: z.record(z.string(), z.strictObject({
      manifest: z.record(z.string(), AssetManifestEntry),
      /** The build-time env the variant was built with, e.g. `VITE_WORKSHOP_BASE_PATH`. Informational. */
      buildEnv: z.record(z.string(), z.string()).optional(),
    })),
  }).optional(),
  /**
   * Router only: how it serves a district's one origin (ADR-0014; manifest-lib's
   * `DistrictOriginWiring`). Used when the install includes the district service; see desired.ts.
   */
  districtOrigin: z.strictObject({
    binding: z.strictObject({
      type: z.literal("service"),
      name: BindingName,
      service: z.string().regex(/^\$WORKER_NAME\([a-z0-9-]+\)$/, "expected $WORKER_NAME(<package>)"),
    }),
    assetVariant: z.string().min(1),
    basePath: z.string().regex(/^(\/[a-z0-9-]+)+$/, "expected a path such as /ai"),
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
 * Pins the release a district installs by the root release keys it trusts (`@educateos/releases`).
 * The manifest bytes are installable only with a root-signed manifest statement naming their
 * SHA-256, this release ID and this version, signed by one of these keys.
 */
export const SignedReleasePin = z.strictObject({
  mode: z.literal("signed"),
  releaseId: z.string().min(1),
  version: SemVer,
  trust: ReleaseTrust,
});
/** A signed release pin. */
export type SignedReleasePin = z.infer<typeof SignedReleasePin>;

/**
 * Development only: pins a release by the SHA-256 of its manifest bytes, with no signature. It
 * exists for unsigned development builds (built without the root release key), which have no
 * root statement. A signed release is always pinned with {@link SignedReleasePin}; the CLI also
 * demands `--insecure-pin` before it accepts this one.
 */
export const InsecureReleasePin = z.strictObject({
  mode: z.literal("insecure-pin"),
  releaseId: z.string().min(1),
  version: SemVer,
  manifestSha256: Sha256Hex,
});
/** An insecure release pin. */
export type InsecureReleasePin = z.infer<typeof InsecureReleasePin>;

/** How the district pins the release it installs. */
export const ReleasePin = z.discriminatedUnion("mode", [SignedReleasePin, InsecureReleasePin]);
/** A release pin. */
export type ReleasePin = z.infer<typeof ReleasePin>;

/** What a signed pin needs besides the manifest bytes. */
export interface ManifestVerificationInput {
  /** The root's signed manifest statement for the release (a `SignedReleaseManifest`). */
  signedManifest?: unknown;
  /** The clock. Defaults to the system clock. */
  now?: Date;
}

/**
 * Verifies manifest bytes against the root's signed statement, entirely locally, and parses them.
 * The statement may be up to {@link RELEASE_INSTALL_GRACE_MS} past its expiry, so a release the
 * district already approved still installs, or is rolled back to, when the root can't re-sign.
 * Fails with `unauthenticated` for an untrusted, retired or invalid signature or a long-expired
 * statement, and `validation-failed` if the bytes don't match it.
 */
export async function verifyReleaseManifest(
  bytes: Uint8Array<ArrayBuffer>,
  signedManifest: unknown,
  trust: ReleaseTrust,
  now: Date = new Date(),
): Promise<{ manifest: ReleaseManifest; statement: ReleaseManifestStatement }> {
  const statement = await verifySignedReleaseManifest(signedManifest, trust, { now, graceMs: RELEASE_INSTALL_GRACE_MS });
  if ((await sha256Hex(bytes)) !== statement.manifestSha256) {
    throw new EducateOsError("validation-failed", "release manifest does not match the signed SHA-256");
  }
  const manifest = parseManifest(bytes);
  if (manifest.releaseId !== statement.releaseId) {
    throw new EducateOsError("validation-failed", "release manifest is for a different release than its signed statement");
  }
  return { manifest, statement };
}

/**
 * Verifies manifest bytes against a pin and parses them. A signed pin needs the root's signed
 * statement (see {@link verifyReleaseManifest}) naming the pinned release ID and version. Fails
 * with `validation-failed` on a digest, release or version mismatch, an unsupported manifest
 * version, or any unknown field.
 */
export async function loadPinnedManifest(
  bytes: Uint8Array<ArrayBuffer>,
  pin: ReleasePin,
  input: ManifestVerificationInput = {},
): Promise<ReleaseManifest> {
  if (pin.mode === "signed") {
    if (input.signedManifest === undefined) throw new EducateOsError("validation-failed", "a signed release pin needs the signed manifest");
    const { manifest, statement } = await verifyReleaseManifest(bytes, input.signedManifest, pin.trust, input.now);
    if (statement.releaseId !== pin.releaseId || statement.version !== pin.version) {
      throw new EducateOsError("validation-failed", "the signed manifest is for a different release than the pin");
    }
    return manifest;
  }
  if ((await sha256Hex(bytes)) !== pin.manifestSha256) {
    throw new EducateOsError("validation-failed", "release manifest does not match the pinned SHA-256");
  }
  const manifest = parseManifest(bytes);
  if (manifest.releaseId !== pin.releaseId) {
    throw new EducateOsError("validation-failed", "release manifest is for a different release than the pin");
  }
  return manifest;
}

function parseManifest(bytes: Uint8Array<ArrayBuffer>): ReleaseManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EducateOsError("validation-failed", "release manifest is not JSON");
  }
  const parsed = ReleaseManifest.safeParse(json);
  if (!parsed.success) {
    throw new EducateOsError("validation-failed", `release manifest rejected: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
