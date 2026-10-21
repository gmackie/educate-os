import type { GitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { MAX_DIFF_BLOB_BYTES, type GitTreeEntry, type TreeDiffSource } from "@gadgets/gatekeeper-kit/git-diff";
import { SchoolOsError, type PrincipalId, type WorkspaceId } from "@schoolos/contracts";
import { NO_COMMIT, type ArtifactsNamespace, type ArtifactsRepository, type GitTransport } from "./artifacts-api.ts";
import { GitCredentialBroker, INTERNAL_TOKEN_TTL_SECONDS, type CredentialLedger } from "./credentials.ts";
import { DIRECTORY_MODE, encodeCommit, encodeTree, FILE_MODE, gitObject, gitObjectId } from "./git-objects.ts";
import type { BuiltTree, RepositoryName } from "./model.ts";

/**
 * Whether the district's plan includes Cloudflare Artifacts (roadmap §15.5). Where it does not,
 * project versions are kept as bundles in learning-artifacts' own text or R2 storage.
 */
export type ArtifactsAvailability = { status: "available" } | { status: "unavailable"; reason: "not-on-plan" };

/** What a plan with Artifacts provides: the binding and the Git remote it serves. */
export interface ArtifactsPlan {
  artifacts: ArtifactsNamespace;
  transport: GitTransport;
}

/** The one branch a project repository has. Versions are commits on it. */
export const PROJECT_BRANCH = "main";

/** The most commits a baseline scan walks before refusing to vouch for the history. */
export const MAX_SCANNED_COMMITS = 5000;

/** A commit found by a history scan, with every file path its tree holds. */
export interface ScannedCommit {
  commit: GitOid;
  paths: string[];
}

/**
 * The Cloudflare Artifacts content backend and versioning provider for project artifacts: one
 * repository per project, named by a random ID that says nothing about its owner, and one commit
 * per saved version. It holds the binding's authority, so nothing outside this package reaches it;
 * every token it mints is recorded per workspace and the ones it uses itself are revoked at once.
 */
export class ArtifactsGitBackend {
  readonly #plan: ArtifactsPlan | undefined;
  readonly #broker: GitCredentialBroker | undefined;

  /** `plan` is absent where the district's plan has no Artifacts. */
  constructor(options: { plan: ArtifactsPlan | undefined; ledger: CredentialLedger }) {
    this.#plan = options.plan;
    this.#broker = options.plan === undefined ? undefined : new GitCredentialBroker({ artifacts: options.plan.artifacts, ledger: options.ledger });
  }

  /** Whether this backend can be used. */
  availability(): ArtifactsAvailability {
    return this.#plan === undefined ? { status: "unavailable", reason: "not-on-plan" } : { status: "available" };
  }

  /** The token broker, for credentials handed to a principal's own Git client. */
  get credentials(): GitCredentialBroker {
    return this.#require().broker;
  }

  /** Creates an empty repository for a new project and revokes the token creation returns. */
  async createRepository(): Promise<RepositoryName> {
    const { plan } = this.#require();
    const name = `sos-${crypto.randomUUID()}`;
    const created = await plan.artifacts.create(name, { setDefaultBranch: PROJECT_BRANCH });
    await this.#withRepository(name, (repo) => repo.revokeToken(created.token));
    return name;
  }

  /** Deletes a repository, as undoing a project whose record could not be saved. */
  async deleteRepository(name: RepositoryName): Promise<void> {
    await this.#require().plan.artifacts.delete(name);
  }

  /** The repository's HTTPS remote. */
  async remote(name: RepositoryName): Promise<string> {
    return this.#withRepository(name, async (repo) => (await repo.info()).remote);
  }

  /**
   * Writes `built` as a commit on the repository's branch, with `parent` as its only parent (none
   * for a first version), pushed with a write token minted for `principalId` alone and revoked as
   * soon as the push ends. The branch moves from wherever it is: the parent comes from the version
   * record, so a commit left behind by an earlier failed save is simply superseded.
   */
  async commit(input: {
    repository: RepositoryName;
    workspaceId: WorkspaceId;
    principalId: PrincipalId;
    built: BuiltTree;
    parent: GitOid | undefined;
    message: string;
    at: Date;
  }): Promise<GitOid> {
    const { plan, broker } = this.#require();
    const commit = await gitObject("commit", encodeCommit({
      tree: input.built.tree,
      parents: input.parent === undefined ? [] : [input.parent],
      author: { name: input.principalId, email: `${input.principalId}@principals.schoolos.invalid`, seconds: Math.floor(input.at.getTime() / 1000) },
      message: input.message,
    }));
    const remote = await this.remote(input.repository);
    const token = await broker.mint({
      repository: input.repository,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      scope: "write",
      ttlSeconds: INTERNAL_TOKEN_TTL_SECONDS,
    });
    try {
      const head = await plan.transport.readBranch(remote, token.plaintext, PROJECT_BRANCH);
      await plan.transport.push(
        remote,
        token.plaintext,
        { branch: PROJECT_BRANCH, oldSha: head ?? NO_COMMIT, newSha: commit.oid },
        [...input.built.objects, commit],
      );
    } finally {
      // A token that fails to revoke expires within a minute, and stays in the ledger for revokeAll.
      await broker.revoke(input.repository, token.id).catch(() => {});
    }
    return commit.oid;
  }

  /** A diff source over the repository's objects, each verified against its ID as it is read. */
  async withTreeSource<T>(name: RepositoryName, use: (source: TreeDiffSource) => Promise<T>): Promise<T> {
    return this.#withRepository(name, (repo) => use(verifiedSource(repo)));
  }

  /** Every file of a tree, path to verified bytes. */
  async readFiles(name: RepositoryName, tree: GitOid): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
    return this.#withRepository(name, async (repo) => {
      const source = verifiedSource(repo, Infinity);
      const files = new Map<string, Uint8Array<ArrayBuffer>>();
      for (const { path, oid } of await listFiles(source, tree)) {
        const bytes = await source.getBlob(oid);
        if (bytes === "unavailable") throw unavailable();
        files.set(path, new Uint8Array(bytes));
      }
      return files;
    });
  }

  /**
   * Every commit reachable from `head` by any parent, with the paths in each one's tree: the whole
   * history a fork could expose, as the repository holds it rather than as records describe it.
   */
  async scanHistory(name: RepositoryName, head: GitOid): Promise<ScannedCommit[]> {
    return this.#withRepository(name, async (repo) => {
      const source = verifiedSource(repo);
      const pathsByTree = new Map<GitOid, string[]>();
      const scanned: ScannedCommit[] = [];
      const seen = new Set<GitOid>();
      const queue: GitOid[] = [head];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (seen.size > MAX_SCANNED_COMMITS) {
          throw new SchoolOsError("policy-violation", "This baseline's history is too long to check; re-create it as a fresh snapshot.");
        }
        const commit = await repo.readCommit(oid);
        if (commit === null) throw unavailable();
        let paths = pathsByTree.get(commit.treeHash);
        if (paths === undefined) {
          paths = (await listFiles(source, commit.treeHash)).map((f) => f.path);
          pathsByTree.set(commit.treeHash, paths);
        }
        scanned.push({ commit: oid, paths });
        queue.push(...commit.parents);
      }
      return scanned;
    });
  }

  #require(): { plan: ArtifactsPlan; broker: GitCredentialBroker } {
    if (this.#plan === undefined || this.#broker === undefined) {
      throw new SchoolOsError("unavailable", "Project history is not available on this district's plan.");
    }
    return { plan: this.#plan, broker: this.#broker };
  }

  async #withRepository<T>(name: RepositoryName, use: (repo: ArtifactsRepository) => Promise<T>): Promise<T> {
    const repo = await this.#require().plan.artifacts.get(name);
    try {
      return await use(repo);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }
}

function unavailable(): SchoolOsError {
  return new SchoolOsError("unavailable", "This project's files are missing from storage or failed their integrity check.");
}

/**
 * Reads trees and blobs through the binding, re-hashing each so that what the diff or a fork sees
 * is exactly what the version recorded. A tree that does not re-encode to its ID reads as missing.
 */
function verifiedSource(repo: ArtifactsRepository, maxBlobBytes = MAX_DIFF_BLOB_BYTES): TreeDiffSource {
  return {
    async getTree(oid) {
      const entries = await repo.readTree(oid);
      if (entries === null) return null;
      const mapped: GitTreeEntry[] = entries.map((e) => ({ mode: e.mode, name: e.name, oid: e.hash }));
      if (mapped.some((e) => e.mode !== FILE_MODE && e.mode !== DIRECTORY_MODE)) return null;
      const payload = encodeTree(mapped.map((e) => ({ name: e.name, mode: e.mode as typeof FILE_MODE, oid: e.oid })));
      return (await gitObjectId("tree", payload)) === oid ? mapped : null;
    },
    async getBlob(oid) {
      const blob = await repo.readBlob(oid);
      if (blob === null || blob.size > maxBlobBytes) return "unavailable";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return (await gitObjectId("blob", bytes)) === oid ? bytes : "unavailable";
    },
  };
}

/** Every file under a tree, with its path and blob ID. */
export async function listFiles(source: TreeDiffSource, tree: GitOid, prefix = ""): Promise<{ path: string; oid: GitOid }[]> {
  const entries = await source.getTree(tree);
  if (entries === null) throw unavailable();
  const files: { path: string; oid: GitOid }[] = [];
  for (const entry of entries) {
    if (entry.mode === DIRECTORY_MODE) files.push(...(await listFiles(source, entry.oid, `${prefix}${entry.name}/`)));
    else files.push({ path: `${prefix}${entry.name}`, oid: entry.oid });
  }
  return files;
}
