import { PrincipalId, EducateOsError } from "@educateos/contracts";
import { type CompetencyNode, RegistryUri } from "@educateos/registry";
import { z } from "zod";
import { catalogEntry } from "./catalog.ts";
import { canonicalJson, contentDigest } from "./digest.ts";
import { CatalogRelease } from "./release.ts";
import { CatalogKey } from "./vocabulary.ts";

/**
 * A district's decision about an installed release.
 *
 * - `proposed`: installed for review; not yet used.
 * - `approved`: the release the district uses. At most one per framework. Its content can never
 *   change again.
 * - `retired`: no longer used; kept for history, and may be approved again.
 */
export const ApprovalStatus = z.enum(["proposed", "approved", "retired"]);
/** An approval status. */
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

const Timestamp = z.iso.datetime({ offset: true });

/** A release installed in the district's mirror, with the district's decision about it. */
export const InstalledRelease = z.strictObject({
  release: CatalogRelease,
  status: ApprovalStatus,
  installedBy: PrincipalId,
  installedAt: Timestamp,
  /** Who last changed `status`, and when. Absent while the release is still as installed. */
  decidedBy: PrincipalId.optional(),
  decidedAt: Timestamp.optional(),
});
/** An installed release. */
export type InstalledRelease = z.infer<typeof InstalledRelease>;

/**
 * A district's local adjustment to one item. Overlays sit beside releases and never change them,
 * so the publisher's (or transcriber's) text is always recoverable as released.
 */
export const NodeOverlay = z.strictObject({
  nodeUri: RegistryUri,
  /** A district label shown in place of the item's code, such as a course-local short name. */
  localLabel: z.string().min(1).max(200).optional(),
  /** Hides the item from district pickers without removing it from the release. */
  hidden: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  author: PrincipalId,
  updatedAt: Timestamp,
});
/** A node overlay. */
export type NodeOverlay = z.infer<typeof NodeOverlay>;

/** Everything the mirror keeps for one framework a district selected. */
export const FrameworkMirrorState = z.strictObject({
  frameworkKey: CatalogKey,
  /** Incremented on every write; storage uses it to refuse a write based on a stale read. */
  revision: z.number().int().min(1),
  selectedBy: PrincipalId,
  selectedAt: Timestamp,
  releases: z.array(InstalledRelease),
  overlays: z.array(NodeOverlay),
});
/** A framework's mirror state. */
export type FrameworkMirrorState = z.infer<typeof FrameworkMirrorState>;

/**
 * Where the mirror keeps its state: district-local D1, KV or a Durable Object in production.
 * `put` is a compare-and-swap on `revision`, so two writers cannot both build on the same state.
 */
export interface CatalogMirrorStorage {
  /** The stored state for a framework, or undefined if the district has not selected it. */
  get(key: CatalogKey): Promise<FrameworkMirrorState | undefined>;
  /** Every stored state. */
  list(): Promise<FrameworkMirrorState[]>;
  /**
   * Stores `state` if the stored revision is `state.revision - 1` (absent when it is 1).
   *
   * @throws EducateOsError `conflict` otherwise.
   */
  put(state: FrameworkMirrorState): Promise<void>;
}

/** {@link CatalogMirrorStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryCatalogMirrorStorage implements CatalogMirrorStorage {
  readonly #states = new Map<string, FrameworkMirrorState>();

  async get(key: CatalogKey): Promise<FrameworkMirrorState | undefined> {
    const state = this.#states.get(key);
    return state === undefined ? undefined : structuredClone(state);
  }

  async list(): Promise<FrameworkMirrorState[]> {
    return [...this.#states.values()].map((state) => structuredClone(state));
  }

  async put(state: FrameworkMirrorState): Promise<void> {
    const stored = this.#states.get(state.frameworkKey);
    if ((stored?.revision ?? 0) !== state.revision - 1) {
      throw new EducateOsError("conflict", `${state.frameworkKey} changed since it was read`);
    }
    this.#states.set(state.frameworkKey, structuredClone(state));
  }
}

/**
 * Decides whether a release's signature is genuine. Supplied by the release-signing work (roadmap
 * R03); the mirror refuses any release it does not accept.
 */
export type VerifyRelease = (release: CatalogRelease) => Promise<boolean>;

/** A node in a {@link ReleaseDiff}. */
export interface DiffItem {
  uri: string;
  humanCodingScheme: string | undefined;
}

/** A node whose content changed between two releases, and which of its fields changed. */
export interface ChangedItem extends DiffItem {
  fields: string[];
}

/**
 * What changes between two releases of a framework's items. `orphanedOverlays` are the district's
 * overlays on items the newer release retires; they stay stored but no longer apply.
 */
export interface ReleaseDiff {
  fromVersion: string | undefined;
  toVersion: string;
  added: DiffItem[];
  changed: ChangedItem[];
  retired: DiffItem[];
  orphanedOverlays: string[];
}

/** A node without its retrieval time, which changes on every import without changing the content. */
function comparable(node: CompetencyNode): Record<string, unknown> {
  const { provenance: { retrievedAt: _, ...provenance }, ...rest } = node;
  return { ...rest, provenance };
}

const diffItem = (node: CompetencyNode): DiffItem => ({ uri: node.uri, humanCodingScheme: node.humanCodingScheme });

/** Diffs two releases' nodes by URI. */
export function diffReleases(
  from: CatalogRelease | undefined,
  to: CatalogRelease,
  overlays: readonly NodeOverlay[] = [],
): ReleaseDiff {
  const before = new Map((from?.content.nodes ?? []).map((node) => [node.uri, node]));
  const after = new Map((to.content.nodes ?? []).map((node) => [node.uri, node]));
  const added: DiffItem[] = [];
  const changed: ChangedItem[] = [];
  for (const [uri, node] of after) {
    const previous = before.get(uri);
    if (previous === undefined) {
      added.push(diffItem(node));
      continue;
    }
    const [a, b] = [comparable(previous), comparable(node)];
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((field) => canonicalJson(a[field]) !== canonicalJson(b[field]))
      .toSorted();
    if (fields.length > 0) changed.push({ ...diffItem(node), fields });
  }
  const retired = [...before.values()].filter((node) => !after.has(node.uri)).map(diffItem);
  const retiredUris = new Set(retired.map((r) => r.uri));
  return {
    fromVersion: from?.version,
    toVersion: to.version,
    added,
    changed,
    retired,
    orphanedOverlays: overlays.filter((o) => retiredUris.has(o.nodeUri)).map((o) => o.nodeUri),
  };
}

/** Who performs a mirror operation, and when. */
export interface Actor {
  by: PrincipalId;
  at: string;
}

/**
 * A district's local mirror of the catalog: which frameworks it selected, the releases it pinned,
 * its approval decisions and its overlays.
 *
 * The mirror records who acted but does not decide who may: callers authorize first (district
 * administrators only), through the EducateOS authorization vocabulary.
 */
export class CatalogMirror {
  readonly #storage: CatalogMirrorStorage;
  readonly #verifyRelease: VerifyRelease;

  constructor(options: { storage: CatalogMirrorStorage; verifyRelease: VerifyRelease }) {
    this.#storage = options.storage;
    this.#verifyRelease = options.verifyRelease;
  }

  /**
   * Selects a catalog framework for the district. Selecting it again changes nothing.
   *
   * @throws EducateOsError `not-found` if the catalog has no such framework.
   */
  async select(key: string, actor: Actor): Promise<FrameworkMirrorState> {
    const entry = catalogEntry(key);
    const existing = await this.#storage.get(entry.key);
    if (existing !== undefined) return existing;
    const state = FrameworkMirrorState.parse({
      frameworkKey: entry.key,
      revision: 1,
      selectedBy: actor.by,
      selectedAt: actor.at,
      releases: [],
      overlays: [],
    });
    await this.#storage.put(state);
    return state;
  }

  /** The district's state for a framework, or undefined if it has not selected it. */
  async get(key: string): Promise<FrameworkMirrorState | undefined> {
    return this.#storage.get(CatalogKey.parse(key));
  }

  /** The state of every framework the district selected. */
  async selections(): Promise<FrameworkMirrorState[]> {
    return this.#storage.list();
  }

  /** The release the district uses for a framework, if it approved one. */
  async approvedRelease(key: string): Promise<CatalogRelease | undefined> {
    return (await this.get(key))?.releases.find((r) => r.status === "approved")?.release;
  }

  /**
   * Installs a release as `proposed`, and returns the diff from the release currently approved.
   * Installing the same bytes again changes nothing. A proposed release may be replaced by
   * different bytes under the same version; an approved or retired one may not.
   *
   * @throws EducateOsError `validation-failed` if the release is malformed or its content does not
   *   match its digest, `policy-violation` if `verifyRelease` rejects it, `not-found` if the
   *   framework is not selected, or `conflict` if the version is already pinned to other bytes.
   */
  async install(input: unknown, actor: Actor): Promise<{ release: InstalledRelease; diff: ReleaseDiff }> {
    const parsed = CatalogRelease.safeParse(input);
    if (!parsed.success) throw new EducateOsError("validation-failed", "not a catalog release");
    const release = parsed.data;
    await this.#checkIntegrity(release);
    if (!(await this.#verifyRelease(release))) {
      throw new EducateOsError("policy-violation", `release ${release.frameworkKey}@${release.version} failed signature verification`);
    }

    const state = await this.#require(release.frameworkKey);
    const existing = state.releases.find((r) => r.release.version === release.version);
    const approved = state.releases.find((r) => r.status === "approved");
    if (existing !== undefined && existing.release.contentDigest === release.contentDigest) {
      return { release: existing, diff: diffReleases(approved?.release, release, state.overlays) };
    }
    if (existing !== undefined && existing.status !== "proposed") {
      throw new EducateOsError("conflict", `${release.frameworkKey}@${release.version} is ${existing.status} and cannot change`);
    }

    const installed = InstalledRelease.parse({ release, status: "proposed", installedBy: actor.by, installedAt: actor.at });
    await this.#write(state, {
      releases: [...state.releases.filter((r) => r.release.version !== release.version), installed],
    });
    return { release: installed, diff: diffReleases(approved?.release, release, state.overlays) };
  }

  /**
   * Approves a proposed release, or reinstates a retired one, retiring the release it replaces.
   * Returns the diff the approval puts into use. A retired release's content never changed, so
   * reinstating it is the same decision as approving it was.
   *
   * @throws EducateOsError `not-found` if there is no such release, `conflict` if it is already
   *   approved, or `validation-failed` if its stored content no longer matches its digest.
   */
  async approve(key: string, version: string, actor: Actor): Promise<ReleaseDiff> {
    const state = await this.#require(key);
    const target = this.#find(state, version);
    if (target.status === "approved") throw new EducateOsError("conflict", `${key}@${version} is already approved`);
    await this.#checkIntegrity(target.release);
    const previous = state.releases.find((r) => r.status === "approved");
    const decided = { decidedBy: actor.by, decidedAt: actor.at };
    await this.#write(state, {
      releases: state.releases.map((r) =>
        r === target ? { ...r, status: "approved", ...decided } : r === previous ? { ...r, status: "retired", ...decided } : r),
    });
    return diffReleases(previous?.release, target.release, state.overlays);
  }

  /**
   * Retires a proposed or approved release. Retiring the approved release leaves the framework
   * selected with nothing in use.
   *
   * @throws EducateOsError `not-found` if there is no such release, or `conflict` if it is already retired.
   */
  async retire(key: string, version: string, actor: Actor): Promise<void> {
    const state = await this.#require(key);
    const target = this.#find(state, version);
    if (target.status === "retired") throw new EducateOsError("conflict", `${key}@${version} is already retired`);
    await this.#write(state, {
      releases: state.releases.map((r) => (r === target ? { ...r, status: "retired", decidedBy: actor.by, decidedAt: actor.at } : r)),
    });
  }

  /**
   * The diff between two installed releases of a framework.
   *
   * @throws EducateOsError `not-found` if either release is not installed.
   */
  async diff(key: string, fromVersion: string, toVersion: string): Promise<ReleaseDiff> {
    const state = await this.#require(key);
    return diffReleases(this.#find(state, fromVersion).release, this.#find(state, toVersion).release, state.overlays);
  }

  /**
   * Sets the district's overlay on an item of the approved release, replacing any earlier one.
   *
   * @throws EducateOsError `validation-failed` if the overlay is malformed, `not-found` if the
   *   framework has no approved release or the item is not in it.
   */
  async setOverlay(key: string, input: unknown): Promise<NodeOverlay> {
    const parsed = NodeOverlay.safeParse(input);
    if (!parsed.success) throw new EducateOsError("validation-failed", "not a node overlay");
    const overlay = parsed.data;
    const state = await this.#require(key);
    const approved = state.releases.find((r) => r.status === "approved");
    if (!approved?.release.content.nodes?.some((node) => node.uri === overlay.nodeUri)) {
      throw new EducateOsError("not-found", `${key} has no approved item ${overlay.nodeUri}`);
    }
    await this.#write(state, { overlays: [...state.overlays.filter((o) => o.nodeUri !== overlay.nodeUri), overlay] });
    return overlay;
  }

  async #require(key: string): Promise<FrameworkMirrorState> {
    const state = await this.get(key);
    if (state === undefined) throw new EducateOsError("not-found", `the district has not selected ${key}`);
    return state;
  }

  #find(state: FrameworkMirrorState, version: string): InstalledRelease {
    const found = state.releases.find((r) => r.release.version === version);
    if (found === undefined) throw new EducateOsError("not-found", `${state.frameworkKey}@${version} is not installed`);
    return found;
  }

  async #checkIntegrity(release: CatalogRelease): Promise<void> {
    if ((await contentDigest(release.content)) === release.contentDigest) return;
    throw new EducateOsError("validation-failed", `release ${release.frameworkKey}@${release.version} does not match its digest`);
  }

  async #write(state: FrameworkMirrorState, change: Partial<Pick<FrameworkMirrorState, "releases" | "overlays">>): Promise<void> {
    const next = FrameworkMirrorState.parse({ ...state, ...change, revision: state.revision + 1 });
    if (next.releases.filter((r) => r.status === "approved").length > 1) {
      throw new EducateOsError("conflict", `${state.frameworkKey} would have two approved releases`);
    }
    await this.#storage.put(next);
  }
}
