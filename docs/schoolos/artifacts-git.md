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
| Revision | One saved version, which is one commit |
| Revision digest | SHA-256 of the manifest |
| (in the manifest) `tree`, `contentDigest` | The files alone: the same files give the same values, wherever and whenever they are saved |

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
- **Revocation on course close.** `ProjectArtifacts.revokeAll(workspaceId)` revokes every token
  minted for a workspace's projects. This applies W01's grant revocation to Git access. Run it
  beside `WorkspaceDirectory.reconcileCourseGrants` when a course closes. Tokens that fail to revoke
  stay recorded, so a retry finishes the job.

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

- An Artifacts token covers a whole repository, so a student's own write credential can move the
  project branch. This never changes recorded versions: every version names its commit, and the
  next save's parent comes from the version record rather than the branch. A garbage-collecting
  server could still drop an unreachable version commit. A protected ref per version is a follow-up.
- Project files have no executable bit, symlinks or submodules.
