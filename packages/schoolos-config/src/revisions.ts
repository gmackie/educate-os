import {
  ConfigRevisionId,
  ConfigurationRevision,
  SchoolOsError,
  type PrincipalId,
} from "@schoolos/contracts";
import { canonicalJson, contentHash, sha256Hex } from "./canonical.ts";
import { compileDistrictConfig, type CompiledConfig, type ConfigProblem } from "./compile.ts";
import { CONFIG_API_VERSION, DesiredState } from "./document.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { pointerSegment } from "./secrets.ts";

/** A revision together with the content hash of its desired state. */
export interface HashedRevision {
  /** The revision. */
  revision: ConfigurationRevision;
  /** The content hash of `revision.desired` (see {@link revisionContentHash}). */
  contentHash: string;
}

/** A draft revision and its compilation, or every problem with the document. */
export type DraftRevisionResult =
  | (HashedRevision & { ok: true; compiled: CompiledConfig })
  | { ok: false; problems: ConfigProblem[] };

/** The content hash of a revision's desired state. Equal desired states always hash alike. */
export function revisionContentHash(revision: ConfigurationRevision): Promise<string> {
  return contentHash(revision.desired);
}

/**
 * A revision's ID is derived from its content hash and its predecessor, so submitting the same
 * document on the same head twice yields the same revision (idempotent), while rolling back to an
 * earlier state yields a new revision rather than reusing the earlier one's ID.
 */
async function revisionId(hash: string, previous: ConfigurationRevision | undefined): Promise<ConfigRevisionId> {
  const digest = await sha256Hex(canonicalJson({ contentHash: hash, previousRevisionId: previous?.id ?? null }));
  return ConfigRevisionId.parse(`cfg_${digest.slice(0, 32)}`);
}

function assertDistrictScope(revision: ConfigurationRevision, districtId: string): void {
  const { scope } = revision;
  if (scope.districtId !== districtId || scope.schoolId !== undefined || scope.offeringId !== undefined) {
    throw new SchoolOsError("conflict", "the previous revision belongs to a different configuration scope");
  }
}

/**
 * Compiles a district configuration document into a draft revision chained after `previous`.
 * Nothing is stored or applied: the caller persists the draft and later plans and applies it.
 */
export async function createDraftRevision(input: {
  document: unknown;
  registry: CapabilityRegistry;
  actorPrincipalId: PrincipalId;
  previous?: ConfigurationRevision;
}): Promise<DraftRevisionResult> {
  const result = compileDistrictConfig(input.document, input.registry);
  if (!result.ok) return result;
  const { desired } = result.compiled;
  if (input.previous !== undefined) assertDistrictScope(input.previous, desired.district);
  const hash = await contentHash(desired);
  const revision = ConfigurationRevision.parse({
    id: await revisionId(hash, input.previous),
    scope: { districtId: desired.district },
    schemaVersion: CONFIG_API_VERSION,
    desired,
    status: "draft",
    actorPrincipalId: input.actorPrincipalId,
    ...(input.previous === undefined ? {} : { previousRevisionId: input.previous.id }),
  });
  return { ok: true, revision, contentHash: hash, compiled: result.compiled };
}

/**
 * Rolls back by creating a new draft revision, chained after `head`, whose desired state equals
 * `target`'s. History is never rewritten: the rollback is itself an auditable revision.
 */
export async function createRollbackRevision(input: {
  target: ConfigurationRevision;
  head: ConfigurationRevision;
  actorPrincipalId: PrincipalId;
}): Promise<HashedRevision> {
  const { target, head } = input;
  if (canonicalJson(target.scope) !== canonicalJson(head.scope)) {
    throw new SchoolOsError("conflict", "a rollback target must belong to the same configuration scope");
  }
  if (target.id === head.id) throw new SchoolOsError("conflict", "the configuration is already at this revision");
  const parsed = DesiredState.safeParse(target.desired);
  if (!parsed.success) throw new SchoolOsError("validation-failed", "the rollback target's desired state is not valid");
  const hash = await contentHash(parsed.data);
  const revision = ConfigurationRevision.parse({
    id: await revisionId(hash, head),
    scope: head.scope,
    schemaVersion: target.schemaVersion,
    desired: parsed.data,
    status: "draft",
    actorPrincipalId: input.actorPrincipalId,
    previousRevisionId: head.id,
  });
  return { revision, contentHash: hash };
}

/** One difference between two desired states. */
export interface DiffEntry {
  /** JSON Pointer to the value that differs. */
  path: string;
  /** Whether the value was added, removed or changed. */
  change: "added" | "removed" | "changed";
  /** The value before, absent when added. */
  before?: unknown;
  /** The value after, absent when removed. */
  after?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValues(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
    for (const key of keys) {
      const childPath = `${path}/${pointerSegment(key)}`;
      if (!Object.hasOwn(after, key)) out.push({ path: childPath, change: "removed", before: before[key] });
      else if (!Object.hasOwn(before, key)) out.push({ path: childPath, change: "added", after: after[key] });
      else diffValues(before[key], after[key], childPath, out);
    }
    return;
  }
  // Arrays are compared whole: an index-by-index diff of a reordered list reads as noise.
  if (canonicalJson(before) !== canonicalJson(after)) out.push({ path, change: "changed", before, after });
}

/**
 * The structural difference between two desired states, as JSON Pointer paths in sorted order. The
 * result depends only on the two values, so the same pair always yields the same diff.
 */
export function diffDesired(before: Record<string, unknown> | undefined, after: Record<string, unknown>): DiffEntry[] {
  const out: DiffEntry[] = [];
  diffValues(before ?? {}, after, "", out);
  return out;
}

/** The difference between two revisions' desired states; `before` is absent for a first revision. */
export function diffRevisions(before: ConfigurationRevision | undefined, after: ConfigurationRevision): DiffEntry[] {
  return diffDesired(before?.desired, after.desired);
}
