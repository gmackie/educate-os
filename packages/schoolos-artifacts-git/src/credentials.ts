import { PrincipalId, SchoolOsError, WorkspaceId } from "@schoolos/contracts";
import type { ArtifactsNamespace, GitAccess } from "./artifacts-api.ts";
import type { RepositoryName } from "./model.ts";

/**
 * How long a project credential lives. Short, so a leaked one is soon useless; a desktop Git
 * client asks for a fresh one per session.
 */
export const CREDENTIAL_TTL_SECONDS = 15 * 60;

/** How long the service's own token for one push lives. It is revoked as soon as the push ends. */
export const INTERNAL_TOKEN_TTL_SECONDS = 60;

/**
 * Who holds a token: the `service`, for one push it makes itself, or a `principal`'s own Git client.
 * Only service tokens may write the protected version refs (see `VERSION_REF_PREFIX`).
 */
export type TokenHolder = "service" | "principal";

/**
 * The record of one minted token: who it was minted for, which repository and workspace it opens,
 * its scope and its holder. Never the token itself, which is shown once and never stored.
 */
export interface CredentialGrant {
  tokenId: string;
  repository: RepositoryName;
  workspaceId: WorkspaceId;
  principalId: PrincipalId;
  scope: GitAccess;
  holder: TokenHolder;
  expiresAt: string;
}

/** Where the record of minted tokens is kept, so a workspace's can all be revoked. */
export interface CredentialLedger {
  /** Records a grant. */
  record(grant: CredentialGrant): Promise<void>;
  /** Every recorded grant for a workspace. */
  forWorkspace(workspaceId: WorkspaceId): Promise<CredentialGrant[]>;
  /** Forgets grants, once their tokens are revoked. */
  remove(tokenIds: readonly string[]): Promise<void>;
}

/** A {@link CredentialLedger} held in memory, for tests and the local harness. */
export class InMemoryCredentialLedger implements CredentialLedger {
  readonly #grants = new Map<string, CredentialGrant>();

  async record(grant: CredentialGrant): Promise<void> {
    this.#grants.set(grant.tokenId, { ...grant });
  }

  async forWorkspace(workspaceId: WorkspaceId): Promise<CredentialGrant[]> {
    return [...this.#grants.values()].filter((g) => g.workspaceId === workspaceId).map((g) => ({ ...g }));
  }

  async remove(tokenIds: readonly string[]): Promise<void> {
    for (const id of tokenIds) this.#grants.delete(id);
  }

  /**
   * Who holds a recorded token, if it is still recorded. Synchronous, so `InMemoryArtifacts` can
   * ask it while deciding a push, as a real ref-protection rule would ask the token's issuer.
   */
  holderOf(tokenId: string): TokenHolder | undefined {
    return this.#grants.get(tokenId)?.holder;
  }

  /** Every recorded grant, for tests. */
  all(): CredentialGrant[] {
    return [...this.#grants.values()].map((g) => ({ ...g }));
  }
}

/**
 * A Git credential for one principal and one project repository. The token is held in a private
 * field and left out of JSON, so logging or persisting the object cannot leak it; only
 * {@link GitCredential.reveal} returns it, at the HTTP boundary that hands it to the user's client.
 */
export class GitCredential {
  /** The repository's HTTPS remote. */
  readonly remote: string;
  /** The username to send with the token. */
  readonly username: string;
  readonly scope: GitAccess;
  readonly expiresAt: string;
  readonly #token: string;

  constructor(fields: { remote: string; username: string; scope: GitAccess; expiresAt: string; token: string }) {
    this.remote = fields.remote;
    this.username = fields.username;
    this.scope = fields.scope;
    this.expiresAt = fields.expiresAt;
    this.#token = fields.token;
  }

  /** The token itself. */
  reveal(): string {
    return this.#token;
  }

  /** The credential without its token. */
  toJSON(): { remote: string; username: string; scope: GitAccess; expiresAt: string } {
    return { remote: this.remote, username: this.username, scope: this.scope, expiresAt: this.expiresAt };
  }
}

/** A token minted for one use: its plaintext and ID, which the minter revokes when done. */
export interface MintedToken {
  id: string;
  plaintext: string;
  expiresAt: string;
}

/**
 * Mints repository tokens and records them per workspace, so that closing a course revokes every
 * one (W01's grant revocation, applied to Git access). It does not decide who may have one: that is
 * `ProjectArtifacts`' job, which asks the policy engine first.
 */
export class GitCredentialBroker {
  readonly #artifacts: ArtifactsNamespace;
  readonly #ledger: CredentialLedger;

  constructor(options: { artifacts: ArtifactsNamespace; ledger: CredentialLedger }) {
    this.#artifacts = options.artifacts;
    this.#ledger = options.ledger;
  }

  /**
   * Mints and records a token on `repository`, which belongs to `workspaceId`: for `principalId`'s
   * own Git client, or for one push the service makes on their behalf.
   */
  async mint(input: {
    repository: RepositoryName;
    workspaceId: WorkspaceId;
    principalId: PrincipalId;
    scope: GitAccess;
    holder: TokenHolder;
    ttlSeconds: number;
  }): Promise<MintedToken> {
    const repo = await this.#artifacts.get(input.repository);
    try {
      const token = await repo.createToken(input.scope, input.ttlSeconds);
      await this.#ledger.record({
        tokenId: token.id,
        repository: input.repository,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        scope: input.scope,
        holder: input.holder,
        expiresAt: token.expiresAt,
      });
      return { id: token.id, plaintext: token.plaintext, expiresAt: token.expiresAt };
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  /** Revokes one token now, and forgets it. */
  async revoke(repository: RepositoryName, tokenId: string): Promise<void> {
    const repo = await this.#artifacts.get(repository);
    try {
      await repo.revokeToken(tokenId);
      await this.#ledger.remove([tokenId]);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  /**
   * Revokes every token minted for a workspace's projects, as closing its course requires. Tokens
   * that could not be revoked stay recorded, so a retry finishes the job, and the call then fails.
   */
  async revokeAll(rawWorkspaceId: WorkspaceId): Promise<{ revoked: number }> {
    const workspaceId = WorkspaceId.parse(rawWorkspaceId);
    const grants = await this.#ledger.forWorkspace(workspaceId);
    const done: string[] = [];
    let failures = 0;
    for (const grant of grants) {
      try {
        await this.revoke(grant.repository, grant.tokenId);
        done.push(grant.tokenId);
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      throw new SchoolOsError("unavailable", `${failures} project credentials could not be revoked yet; retry.`);
    }
    return { revoked: done.length };
  }
}
