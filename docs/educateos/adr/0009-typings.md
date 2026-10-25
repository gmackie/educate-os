# ADR-0009: EducateOS libraries type-check against the web-standard surface

- Status: Accepted
- Date: 2026-10-21
- Issue: SCHO-106

## Context

EducateOS library sources run in three places: Workers (production), Node 24 (the harness, the
pilot gate and every Vitest suite) and browsers (the UIs validate responses with the district
app's route schemas, which reach most domain packages). TypeScript checks a source file under the
typings of whichever package compiles it, so a library is effectively checked once per consumer.

The packages had grown three typings sets: `types: []`, `["node"]` and
`["@cloudflare/workers-types"]`. Workers' typings are the widest of the three: `crypto.subtle.digest`
and stream writers accept any byte view, and `clearTimeout` accepts `null`. Node's and the DOM's
typings accept only views over an `ArrayBuffer` and only `number | undefined`. Code that compiled
under Workers' typings therefore failed in its Node and browser consumers. Six declaration shims
papered over that, plus a `paths` stand-in for a Workers-typed kernel module that gatekeeper-kit's
git helpers imported type-only.

## Decision

1. Every EducateOS library package type-checks its `src` against `lib: ["ESNext", "DOM"]` with
   `types: []`. That is the web-standard surface (fetch, streams, WebCrypto, `TextEncoder`,
   `URL`, timers) that Workers, Node 24 and browsers all provide, with the narrowest signatures
   any of the three declares.
2. Node's typings are added only where Node code lives: a `__tests__/tsconfig.json` (or
   `scripts/tsconfig.json`) that extends the package's config with `types: ["node"]`, checked by
   the build task as `tsc && tsc -p __tests__`. A package whose tests need nothing from Node keeps
   them in its main config.
3. Packages that are Node programs rather than libraries (`harness`, `installer`, `pilot-gate`)
   use the same `lib` plus `types: ["node"]`.
4. UI packages stay on the DOM (`lib: ["ESNext", "DOM", "DOM.Iterable"]`) with `vite/client`.
5. Workers' own typings belong only to code that imports `cloudflare:workers` or Workers-only
   bindings: deployable Workers, and `@educateos/artifacts-git`'s smart HTTP transport
   (`tsconfig.transport.json`), which compiles gatekeeper-kit's Workers-typed transport module.
6. `allowImportingTsExtensions` and `erasableSyntaxOnly` stay on everywhere, because Node runs these
   sources directly.

`@educateos/ai-governance` and `@educateos/ai-guard` are outside this change: the AI-governance work
owns them, and `ai-guard` is a deployable Worker.

## Why not Workers' typings

Workers' typings are a superset that accepts calls Node's and the DOM's typings reject, so a library
checked only against them still breaks its other consumers; the shims were the symptom. They also
conflict with the DOM library, so UIs could not share them. Checking against the narrowest common
surface means that a source which compiles in its own package compiles in every consumer.

## Consequences

- Any EducateOS package can import any other without a shim. The shims under `types/` and the
  `@gadgets/workshop-shared/gatekeeper` `paths` stand-in are gone.
- A byte view handed to WebCrypto or a stream writer must be over an `ArrayBuffer`. Code that
  accepts an arbitrary `Uint8Array` copies one over shared memory first (`bytes.slice()`).
- Timers are held as `ReturnType<typeof setTimeout> | undefined`, never `null`.
- gatekeeper-kit's `git-objects` declares its own `GitOid` alias (identical to the kernel's), so
  its git helpers load no Workers-typed module.
- The DOM lib declares browser-only globals (`document`, `window`) that Workers and Node lack.
  Tests running in Node catch a library that reaches for one.
