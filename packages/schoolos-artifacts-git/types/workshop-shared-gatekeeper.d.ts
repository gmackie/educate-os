// The one type this package's Node typecheck needs from `@gadgets/workshop-shared/gatekeeper`,
// which gatekeeper-kit's `git-objects` and `git-diff` import type-only. The real module declares the
// gatekeeper RPC surface against Workers types (`cloudflare:workers`, `Fetcher`), which the Node
// typecheck shared with `@schoolos/learning-artifacts` cannot load. `tsconfig.transport.json`
// typechecks against the real module.

/** A Git object ID: 40 lowercase hex digits. Identical to the real module's alias. */
export type GitOid = string;
