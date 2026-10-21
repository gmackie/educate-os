# Project artifacts on Cloudflare Artifacts (W03)

`@schoolos/artifacts-git` (`packages/schoolos-artifacts-git`) keeps project-style artifacts, such as
multi-file notebooks, code and datasets, as versioned Git history in Cloudflare Artifacts. This page
describes how it fits into learning artifacts and where its privacy boundary is.

## How it fits

A project is an ordinary `@schoolos/learning-artifacts` artifact of type `notebook`, `dataset` or
`interactive`. Each saved version is an ordinary revision. The revision's content is a small project
manifest (`text/vnd.schoolos.project+json`) that lists every file's path, size, SHA-256 and Git blob
ID. It also records the version's Git tree ID and a `contentDigest` over the canonical file listing.
Pinning, submissions, export, history and every policy decision therefore work for projects exactly
as they do for essays. The revision digest that receipts cite covers the manifest, and the manifest
names every byte of every file.

| learning-artifacts | Project |
| --- | --- |
| Artifact | One project, with one Artifacts repository |
| Revision | One saved version, which is one commit, and a protected ref to it |
| Revision content | `registered` content of provider `artifacts-git`: the manifest, read out of the version commit |
| Revision digest | SHA-256 of the manifest |
| (in the manifest) `tree`, `contentDigest` | The files alone: the same files give the same values, wherever and whenever they are saved |

### How a version is stored

Each save pushes two refs, with a write token minted for the service alone and revoked as soon as
the pushes end:

1. `refs/heads/schoolos/versions/<commit>` (`VERSION_REF_PREFIX`) to a **version commit**. Its tree
   holds one file, `version.json`, the version's manifest, and its only parent is the project commit.
   The ref keeps the project commit, its history and the manifest reachable whatever happens to
   `main`, so a garbage-collecting server can never drop a recorded version.
2. `main` to the **project commit**, which is what a student's own Git client sees.

learning-artifacts' content backends are open: a package registers a `ContentProvider`, and a
revision's content can then be a `registered` reference (`{ provider, key, digest }`) that
learning-artifacts reads back through the provider and checks against the digest, before recording
it and on every read. `ArtifactsGitBackend.contentProvider` is the `artifacts-git` provider. Its key
is `<repository>/<version commit>`, and it reads the manifest out of that commit, checking the tree
and blob against their IDs. Register it with the district's content store:

```ts
const git = new ArtifactsGitBackend({ plan, ledger });
const content = new BackendArtifactStore({ text, r2, providers: [git.contentProvider] });
```

Where it is not registered, versions are still pushed the same way, and the manifest is recorded as
inline text instead, as before.

`ProjectArtifacts` is the service. Students see three actions, and no Git terms appear in the API:

- **Save** (`checkpoint`) records the editor's working tree as a new version.
- **History** (`history`) lists the versions.
- **Diff** (`diff`) compares two versions file by file and line by line. It uses gatekeeper-kit's
  `diffGitTrees`.

`ArtifactsGitBackend` is the only code that holds the Artifacts binding. The binding and Git
transport are modelled by interfaces (`ArtifactsNamespace`, `GitTransport`) built from the calls
`gatekeeper-context`'s `artifact-sync.ts` already makes. `InMemoryArtifacts` is the fake, and
`SmartHttpGitTransport` (`@schoolos/artifacts-git/smart-http`) is the real Git remote, built on
gatekeeper-kit's pkt-line framing and send-pack client.

### When the plan has no Artifacts

Artifacts availability depends on the district's plan (roadmap §15.5). Without it,
`ArtifactsGitBackend.availability()` reports `{ status: "unavailable", reason: "not-on-plan" }`. A
project's versions are then **bundles**: the manifest carries the files themselves, and
learning-artifacts keeps it inline as text or, when it is large, in R2. Save, History and Diff work
the same way, and the tree and content digests are the same. Git credentials are not available.

A project keeps the storage it was created with. If a plan loses Artifacts, the project's history is
still listed, but reading its files answers `unavailable`.

## Privacy boundary

- **Per-student repositories.** Every project has its own repository, named by a random ID
  (`sos-<uuid>`) that says nothing about its owner or course. There are no shared repositories and
  no shared remotes. Two students' work never shares an object store.
- **Every version is authorized before it is written.** Save asks the policy engine for the same
  `update` decision learning-artifacts makes before anything is pushed. learning-artifacts then asks
  again when it records the version. Only the owner may save, and only while the term allows changes.
- **No teacher write access to student repositories.** A teacher is never issued a write
  credential, and the service never pushes on a teacher's behalf to a student's project.
- **Teacher read access only through policy, and only for course work.** A read credential is
  issued only after `LearningArtifacts.getArtifact` has authorized the read. For anyone but the
  owner, the artifact must also be classified `course`. `personal-private` projects are owner-only
  and answer `not-found`.
- **Credentials.** Tokens are minted per principal per repository, scoped `read` or `write`, and
  live 15 minutes. The service's own push tokens live one minute and are revoked as soon as the
  push ends. They are issued only to a person's own HTTP session, never to the `agent` or
  `mcp-tool` channels. A `GitCredential` keeps its token out of JSON, so the token cannot be logged
  or persisted by accident. Neither the manifests nor the credential ledger hold a token: the ledger
  records the token ID, repository, workspace, principal and scope. A token opens only the
  repository it was minted for. Artifacts enforces this, and the fake does too.
- **Revocation when course access ends.** `ProjectArtifacts.revokeEndedCourseAccess()` applies
  W01's grant revocation to Git access: it revokes every token minted for a course workspace whose
  course grants are all revoked, which is what `WorkspaceDirectory.closeTerm` does to a closed
  term's workspaces and `reconcileCourseGrants` to a dropped student's. Run it right after either.
  A workspace whose revocation answers `unavailable` is retried, then reported `pending`; tokens
  that failed to revoke stay recorded, so running it again finishes the job.
  `ProjectArtifacts.revokeAll(workspaceId)` does the same for one workspace.
- **Protected version refs.** Only the service writes `refs/heads/schoolos/versions/*`. Every
  ledger entry records whether its token is the service's (`holder: "service"`) or a principal's
  own, and `InMemoryArtifacts`, given `isServiceToken`, refuses a principal's token any create,
  move or delete of a version ref.

## Sanitized forks of teacher baselines

Git history keeps anything a later commit removed (roadmap §6.2), so a baseline whose answer key was
deleted in version 3 still carries the key in versions 1 and 2. Roadmap §14 lists this case:
"Blueprint Git baseline contains answer key in old commit: publication blocked or sanitized".

- `checkBaseline` walks every commit reachable from the chosen version, by every parent, in the
  repository itself rather than the version records. It reports each file that matches one of the
  assignment's `answerKeyGlobs` or was marked `teacherOnly` when saved. Patterns match
  case-insensitively.
- `forkFromBaseline` creates a new project in a new repository. Its one commit has no parent and
  holds only the chosen version's files, and no other object is pushed. The fork is **blocked**,
  with the report, if any version reachable from the chosen one holds a teacher-only file.
- `recreateBaseline` re-creates the baseline as a fresh, parentless snapshot in the teacher's own
  workspace. It is refused only if the chosen version itself holds a teacher-only file. The
  snapshot can then be forked.
- Artifacts' native `repo.fork()` copies the whole history, so it is never used.

Only the baseline's owner may check, re-create or fork it.

## Known limits

- **Real Artifacts does not yet protect refs.** An Artifacts token covers a whole repository with
  `read` or `write` scope and no per-ref rule, so on the real service a student's own write
  credential could still move or delete a version ref, which the fake refuses. What SchoolOS needs
  from Cloudflare Artifacts is a ref rule: writes to `refs/heads/schoolos/versions/*` only with
  tokens the binding marks as service tokens (or a pre-receive hook to the same effect). Until then:
  - recorded versions do not change: a revision names its version commit by ID, and the next save's
    parent comes from the record, not from `main` or any ref;
  - nothing yet re-creates a version ref a student deletes, so that version becomes unreachable
    to a garbage-collecting server. A periodic check that re-pushes missing or moved version refs
    is a follow-up;
  - the alternative that needs nothing from Cloudflare is to proxy students' Git through SchoolOS,
    which can refuse ref updates in the receive-pack command block before forwarding them.
- Keeping a project from a closed class (`promoteArtifact`) is refused for now: its versions live in
  the class workspace's repository, so a copy needs a new repository, as a fork makes.
- Project files have no executable bit, symlinks or submodules.
