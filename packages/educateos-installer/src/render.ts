// Turns a desired Worker into upload metadata once its dependencies' outputs are known, and
// fingerprints it. The fingerprint is stored on the Worker itself (MARKER_VARS.digest), so the
// reconciler can tell "already uploaded" from "needs upload" by observation alone, with no state
// file to lose.
import { EducateOsError } from "@educateos/contracts";
import type { UploadBinding, WorkerMigrations, WorkerUploadMetadata } from "./cloudflare-api.ts";
import { sha256Hex, stableStringify } from "./digest.ts";
import { type DesiredWorker, isOutputRef, MARKER_VARS, type ResourceKey, type TemplateValue } from "./desired.ts";

/** Outputs Cloudflare minted for resources, by resource key: `id`, and `aud` for the Access app. */
export type ResourceOutputs = Map<ResourceKey, { id?: string; aud?: string }>;

/** Substitutes outputs into a template. Returns undefined if any referenced output is unknown. */
export function resolveTemplate(value: TemplateValue, outputs: ResourceOutputs): unknown {
  let missing = false;
  const walk = (v: TemplateValue): unknown => {
    if (isOutputRef(v)) {
      const resolved = outputs.get(v.ref)?.[v.output];
      if (resolved === undefined) missing = true;
      return resolved;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const result = walk(value);
  return missing ? undefined : result;
}

/** A Worker's bindings with outputs substituted, or undefined while a dependency is not created. */
export function resolveBindings(worker: DesiredWorker, outputs: ResourceOutputs): UploadBinding[] | undefined {
  const resolved = resolveTemplate(worker.bindings, outputs);
  return resolved === undefined ? undefined : (resolved as UploadBinding[]);
}

/**
 * The migration stanza that takes a Worker from its current tag to the release's last tag, or
 * undefined if it is already there. Fails with `conflict` if the current tag is not in the
 * release's history: the Worker was migrated by a newer release, and replaying an older history
 * over it is not something Cloudflare can do.
 */
export function migrationsFrom(worker: DesiredWorker, currentTag: string | undefined): WorkerMigrations | undefined {
  const history = worker.migrations;
  const last = history.at(-1);
  if (!last) {
    if (currentTag) throw new EducateOsError("conflict", `${worker.scriptName} has migration tag ${currentTag} but this release has no migrations`);
    return undefined;
  }
  const strip = ({ tag: _tag, ...step }: (typeof history)[number]) => step;
  if (currentTag === undefined) return { new_tag: last.tag, steps: history.map(strip) };
  const index = history.findIndex((m) => m.tag === currentTag);
  if (index < 0) {
    throw new EducateOsError("conflict", `${worker.scriptName} is at migration tag ${currentTag}, which this release does not know`);
  }
  if (index === history.length - 1) return undefined;
  return { old_tag: currentTag, new_tag: last.tag, steps: history.slice(index + 1).map(strip) };
}

/**
 * The fingerprint of everything a Worker upload carries except the asset session token and the
 * fingerprint itself. Migration steps are excluded: the last tag is what identifies them.
 */
export async function workerDigest(worker: DesiredWorker, bindings: UploadBinding[]): Promise<string> {
  return await sha256Hex(stableStringify({
    mainModule: worker.mainModule,
    modules: worker.modules.map((m) => [m.name, m.type, m.sha256]),
    compatibilityDate: worker.compatibilityDate ?? null,
    compatibilityFlags: worker.compatibilityFlags,
    observability: worker.observability,
    migrationTag: worker.migrations.at(-1)?.tag ?? null,
    bindings,
    assets: worker.assets ?? null,
  }));
}

/** Upload metadata for a Worker, with its fingerprint added as a plain-text var. */
export function uploadMetadata(
  worker: DesiredWorker,
  bindings: UploadBinding[],
  digest: string,
  migrations: WorkerMigrations | undefined,
  assetsJwt: string | undefined,
): WorkerUploadMetadata {
  return {
    main_module: worker.mainModule,
    ...(worker.compatibilityDate ? { compatibility_date: worker.compatibilityDate } : {}),
    compatibility_flags: worker.compatibilityFlags,
    bindings: [...bindings, { type: "plain_text", name: MARKER_VARS.digest, text: digest }],
    // Secrets are set separately and must survive every upload.
    keep_bindings: ["secret_text"],
    ...(migrations ? { migrations } : {}),
    observability: worker.observability,
    ...(worker.assets && assetsJwt ? { assets: { jwt: assetsJwt, config: worker.assets.config } } : {}),
  };
}
