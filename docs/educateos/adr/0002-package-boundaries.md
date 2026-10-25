# ADR-0002: Package boundaries and kernel seams

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1

## Context

`workshop-backend` and `workshop-shared` are the Workshop kernel. Every line in them is reviewed,
and they track an upstream we want to keep merging (see `AGENTS.md`). EducateOS needs a lot of new
domain code: directories, policy, workspaces, artifacts, assessment and governance.

## Decision

1. EducateOS domain code goes in new `packages/educateos-*` packages and in Gatekeepers
   (`gatekeeper-educateos`). The kernel changes only where an extension seam is missing, and each
   such change is its own small PR that names the seam it adds.
2. `@educateos/contracts` is the shared vocabulary. It has no runtime dependencies beyond `zod`,
   imports nothing from the kernel, and the kernel imports nothing from it. Integration happens in
   adapters.
3. Domain services are typed functions behind provider interfaces. HTTP routes and MCP tools are
   thin layers over the same functions, so both get identical authorization (roadmap §10, API
   layering).
4. EducateOS packages without a `wrangler.jsonc` are libraries. Adding one makes a package
   deployable through the release manifest, so that requires its own review.
5. District control Workers run no dynamically loaded plugin code. Untrusted lesson or student code
   runs only in Gadget sandboxes or isolated CI.

## Known seams the kernel will need

| Seam | Needed by | Current kernel behavior |
| --- | --- | --- |
| Principal resolution at sign-in | F04 | `UserDurableObject` is addressed by `idFromName(email)` (`server.ts`, `auth/login-flow.ts`). |
| Authorization hook before capability mint | A02 | `user.ts:#assertResourceEnabled()` enforces admin enablement only. |
| Workspace creation on behalf of a principal | W01 | Workspaces are created interactively by a signed-in user. |
| AI usage attribution | G01 | AI Gateway billing is per deployment and per user, not per class or funding pool. |

Each row becomes its own reviewed kernel PR when its consumer lands.
