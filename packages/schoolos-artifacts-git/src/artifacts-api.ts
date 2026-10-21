// The part of Cloudflare Artifacts this package uses, as interfaces: the Workers binding's
// namespace and repository handles (the same calls `gatekeeper-context`'s `artifact-sync.ts` and
// context collections make), and a token-authenticated Git transport for pushing versions. A real
// `Artifacts` binding satisfies `ArtifactsNamespace` structurally; `InMemoryArtifacts` is the fake.
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type { GitObject } from "./git-objects.ts";

/** A token's access: `read` clones and fetches; `write` also pushes. */
export type GitAccess = "read" | "write";

/** A newly minted repository token. The plaintext is shown once and never stored. */
export interface ArtifactsToken {
  id: string;
  plaintext: string;
  scope: GitAccess;
  expiresAt: string;
}

/** A commit as the binding decodes it. */
export interface ArtifactsCommit {
  hash: string;
  treeHash: string;
  parents: string[];
  message: string;
}

/** One entry of a tree as the binding lists it. */
export interface ArtifactsTreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/** A handle to one repository, with the binding's own (server-side) authority. */
export interface ArtifactsRepository {
  /** The repository's remote URL and default branch. */
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  /** Mints a token for this repository alone. `ttl` is in seconds. */
  createToken(scope: GitAccess, ttl: number): Promise<ArtifactsToken>;
  /** Revokes a token by ID or plaintext. False if there was no such token. */
  revokeToken(tokenOrId: string): Promise<boolean>;
  /** A commit, or null if missing. */
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  /** A tree's immediate entries, or null if missing. */
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  /** A blob's bytes, or null if missing. */
  readBlob(hash: string): Promise<Blob | null>;
  /** Releases the handle, which is an RPC stub on Workers. */
  [Symbol.dispose]?(): void;
}

/** Namespace-level Artifacts operations. */
export interface ArtifactsNamespace {
  /** Creates an empty repository. Its initial token is returned once. */
  create(name: string, opts?: { description?: string; setDefaultBranch?: string }): Promise<{ name: string; remote: string; defaultBranch: string; token: string }>;
  /** A handle to an existing repository; rejects if there is none. */
  get(name: string): Promise<ArtifactsRepository>;
  /** Deletes a repository and every token for it. */
  delete(name: string): Promise<boolean>;
}

/**
 * Git over a repository's HTTPS remote, authenticated by a repository token. The server enforces
 * the token: its repository, scope, expiry and revocation.
 */
export interface GitTransport {
  /** The commit `branch` points at, or null if it does not exist. A read or write token. */
  readBranch(remote: string, token: string, branch: string): Promise<GitOid | null>;
  /**
   * Sends `objects` and moves `update.branch` from `update.oldSha` (`ZERO_OID` to create it) to
   * `update.newSha`, refusing if the branch has moved. A write token.
   */
  push(remote: string, token: string, update: BranchUpdate, objects: readonly GitObject[]): Promise<void>;
}

/**
 * One compare-and-swap branch move: gatekeeper-kit's `GitRefUpdate`, which `SmartHttpGitTransport`
 * passes it as. Restated here because the kit's transport module is typed for Workers only.
 */
export interface BranchUpdate {
  /** A branch name, not a full ref name. */
  branch: string;
  /** The commit the branch must point at now, or {@link NO_COMMIT} if it must not exist. */
  oldSha: GitOid;
  /** The commit to point it at. */
  newSha: GitOid;
}

/** "No commit": the kit's `ZERO_OID`, the old value of a branch being created. */
export const NO_COMMIT: GitOid = "0".repeat(40);

/** The username Artifacts expects beside a repository token, as `artifact-sync.ts` sends it. */
export const ARTIFACTS_TOKEN_USERNAME = "x-access-token";

