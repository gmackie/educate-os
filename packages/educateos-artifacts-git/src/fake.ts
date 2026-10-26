import { parseGitTreePayload, treeEntryKind } from "@gadgets/gatekeeper-kit/git-diff";
import { parseGitCommitPayload, type GitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { EducateOsError } from "@educateos/contracts";
import type {
  ArtifactsCommit,
  ArtifactsNamespace,
  ArtifactsRepository,
  ArtifactsToken,
  ArtifactsTreeEntry,
  BranchUpdate,
  GitAccess,
  GitTransport,
} from "./artifacts-api.ts";
import { NO_COMMIT, isVersionRef } from "./artifacts-api.ts";
import { gitObjectId, type GitObject } from "./git-objects.ts";

interface FakeToken {
  id: string;
  plaintext: string;
  scope: GitAccess;
  expiresAt: number;
  revoked: boolean;
}

interface FakeRepository {
  name: string;
  remote: string;
  defaultBranch: string;
  objects: Map<GitOid, GitObject>;
  branches: Map<string, GitOid>;
  tokens: FakeToken[];
}

/**
 * Cloudflare Artifacts held in memory, for tests and the local harness: both the binding
 * ({@link ArtifactsNamespace}) and the token-authenticated Git remote ({@link GitTransport}). Like
 * the service it stands in for, the remote accepts a token only for the repository it was minted
 * for, within its scope, before it expires and until it is revoked; and a push only if every object
 * hashes to its ID, the new commit's whole graph is present, and the branch has not moved.
 *
 * Given `isServiceToken`, it also enforces the ref protection EducateOS needs and Cloudflare
 * Artifacts does not yet offer: a push that creates, moves or deletes a version ref
 * (`VERSION_REF_PREFIX`, or the legacy one: `isVersionRef`) is refused unless its token is the service's own. Without it, like
 * Artifacts today, any write token may move any ref.
 */
export class InMemoryArtifacts implements ArtifactsNamespace, GitTransport {
  readonly #repositories = new Map<string, FakeRepository>();
  readonly #now: () => Date;
  readonly #isServiceToken: ((tokenId: string) => boolean) | undefined;

  constructor(options: { now?: () => Date; isServiceToken?: (tokenId: string) => boolean } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#isServiceToken = options.isServiceToken;
  }

  // The binding

  async create(name: string, opts: { setDefaultBranch?: string } = {}): Promise<{ name: string; remote: string; defaultBranch: string; token: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error(`INVALID_REPO_NAME: ${name}`);
    if (this.#repositories.has(name)) throw new Error(`ALREADY_EXISTS: ${name}`);
    const repository: FakeRepository = {
      name,
      remote: `https://artifacts.educateos.example/git/${name}.git`,
      defaultBranch: opts.setDefaultBranch ?? "main",
      objects: new Map(),
      branches: new Map(),
      tokens: [],
    };
    this.#repositories.set(name, repository);
    const token = this.#mint(repository, "write", 86400);
    return { name, remote: repository.remote, defaultBranch: repository.defaultBranch, token: token.plaintext };
  }

  async get(name: string): Promise<ArtifactsRepository> {
    const repository = this.#repositories.get(name);
    if (repository === undefined) throw new Error(`NOT_FOUND: ${name}`);
    return this.#handle(repository);
  }

  async delete(name: string): Promise<boolean> {
    return this.#repositories.delete(name);
  }

  // The Git remote

  async readBranch(remote: string, token: string, branch: string): Promise<GitOid | null> {
    const { repository } = this.#authorize(remote, token, "read");
    return repository.branches.get(branch) ?? null;
  }

  async push(remote: string, token: string, update: BranchUpdate, objects: readonly GitObject[]): Promise<void> {
    const { repository, minted } = this.#authorize(remote, token, "write");
    if (isVersionRef(update.branch) && this.#isServiceToken !== undefined && !this.#isServiceToken(minted.id)) {
      throw new EducateOsError("forbidden", `push rejected for refs/heads/${update.branch}: saved versions are protected`);
    }
    for (const object of objects) {
      if ((await gitObjectId(object.type, object.payload)) !== object.oid) throw new Error(`push rejected: object ${object.oid} is corrupt`);
    }
    const incoming = new Map(objects.map((o) => [o.oid, o]));
    const lookup = (oid: GitOid) => incoming.get(oid) ?? repository.objects.get(oid);
    if (update.newSha !== NO_COMMIT) assertConnected(lookup, update.newSha);
    const current = repository.branches.get(update.branch) ?? NO_COMMIT;
    if (current !== update.oldSha) throw new Error(`push rejected for refs/heads/${update.branch}: stale info`);
    for (const object of objects) repository.objects.set(object.oid, object);
    if (update.newSha === NO_COMMIT) repository.branches.delete(update.branch);
    else repository.branches.set(update.branch, update.newSha);
  }

  // Inspection, for tests

  /** Whether a repository exists. */
  has(name: string): boolean {
    return this.#repositories.has(name);
  }

  /** Every object ID a repository holds. */
  objectIds(name: string): GitOid[] {
    return [...(this.#repositories.get(name)?.objects.keys() ?? [])];
  }

  /** The commit a branch points at. */
  branchHead(name: string, branch = "main"): GitOid | undefined {
    return this.#repositories.get(name)?.branches.get(branch);
  }

  /** Every branch of a repository and the commit it points at. */
  branches(name: string): Map<string, GitOid> {
    return new Map(this.#repositories.get(name)?.branches);
  }

  /** Every commit reachable from a branch, by any parent, newest first by discovery. */
  reachableCommits(name: string, branch = "main"): ArtifactsCommit[] {
    const repository = this.#repositories.get(name);
    const head = repository?.branches.get(branch);
    if (repository === undefined || head === undefined) return [];
    const seen: ArtifactsCommit[] = [];
    const queue = [head];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.some((c) => c.hash === oid)) continue;
      const commit = decodeCommit(repository, oid);
      if (commit === null) continue;
      seen.push(commit);
      queue.push(...commit.parents);
    }
    return seen;
  }

  /** The tokens of a repository that the remote would still accept. */
  activeTokenIds(name: string): string[] {
    const now = this.#now().getTime();
    return (this.#repositories.get(name)?.tokens ?? []).filter((t) => !t.revoked && t.expiresAt > now).map((t) => t.id);
  }

  // Internals

  #handle(repository: FakeRepository): ArtifactsRepository {
    return {
      info: async () => ({ name: repository.name, remote: repository.remote, defaultBranch: repository.defaultBranch }),
      createToken: async (scope, ttl) => {
        const token = this.#mint(repository, scope, ttl);
        return { id: token.id, plaintext: token.plaintext, scope, expiresAt: new Date(token.expiresAt).toISOString() } satisfies ArtifactsToken;
      },
      revokeToken: async (tokenOrId) => {
        const token = repository.tokens.find((t) => t.id === tokenOrId || t.plaintext === tokenOrId);
        if (token === undefined || token.revoked) return false;
        token.revoked = true;
        return true;
      },
      readCommit: async (hash) => decodeCommit(repository, hash),
      readTree: async (hash) => {
        const object = repository.objects.get(hash);
        if (object?.type !== "tree") return null;
        return parseGitTreePayload(object.payload, hash).map((e): ArtifactsTreeEntry => ({
          name: e.name,
          mode: e.mode,
          hash: e.oid,
          type: entryType(e.mode),
        }));
      },
      readBlob: async (hash) => {
        const object = repository.objects.get(hash);
        return object?.type === "blob" ? new Blob([object.payload]) : null;
      },
    };
  }

  #mint(repository: FakeRepository, scope: GitAccess, ttl: number): FakeToken {
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31536000) throw new Error("INVALID_TTL");
    const token: FakeToken = {
      id: `tok_${crypto.randomUUID()}`,
      plaintext: `art_${crypto.randomUUID().replaceAll("-", "")}`,
      scope,
      expiresAt: this.#now().getTime() + ttl * 1000,
      revoked: false,
    };
    repository.tokens.push(token);
    return token;
  }

  /** The repository at `remote` and the token, if it was minted for that repository, is live, and allows `access`. */
  #authorize(remote: string, token: string, access: GitAccess): { repository: FakeRepository; minted: FakeToken } {
    const repository = [...this.#repositories.values()].find((r) => r.remote === remote);
    const minted = repository?.tokens.find((t) => t.plaintext === token);
    if (
      repository === undefined || minted === undefined || minted.revoked ||
      minted.expiresAt <= this.#now().getTime() || (access === "write" && minted.scope !== "write")
    ) {
      throw new EducateOsError("forbidden", "The project's storage refused this access.");
    }
    return { repository, minted };
  }
}

function decodeCommit(repository: FakeRepository, hash: string): ArtifactsCommit | null {
  const object = repository.objects.get(hash);
  if (object?.type !== "commit") return null;
  const parsed = parseGitCommitPayload(object.payload, hash);
  return { hash, treeHash: parsed.tree, parents: parsed.parents, message: parsed.message.replace(/\n$/, "") };
}

function entryType(mode: string): ArtifactsTreeEntry["type"] {
  switch (treeEntryKind(mode)) {
    case "dir": return "tree";
    case "symlink": return "symlink";
    case "gitlink": return "gitlink";
    default: return mode === "100755" ? "exec" : "blob";
  }
}

/** Throws unless the commit `oid`, its tree, every object under that tree, and every ancestor are present. */
function assertConnected(lookup: (oid: GitOid) => GitObject | undefined, oid: GitOid): void {
  const pending: GitOid[] = [oid];
  const checked = new Set<GitOid>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (checked.has(next)) continue;
    checked.add(next);
    const object = lookup(next);
    if (object === undefined) throw new Error(`push rejected: missing object ${next}`);
    if (object.type === "commit") {
      const parsed = parseGitCommitPayload(object.payload, next);
      pending.push(parsed.tree, ...parsed.parents);
    } else if (object.type === "tree") {
      for (const entry of parseGitTreePayload(object.payload, next)) {
        if (treeEntryKind(entry.mode) !== "gitlink") pending.push(entry.oid);
      }
    }
  }
}
