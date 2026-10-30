# Upstream delta governance

The generator compares committed trees using NUL-delimited name/status records
and rename detection, not merge-base. JSON and Markdown group changes by package
and classify runtime kernel, UI shell, domain, integration and release. Additions,
modifications, removals, type changes and renames are included. Unrecognized renames
appear as deletion plus addition, both governed. No production runtime changes.

From repository root with Node 24 or newer:

```sh
git fetch origin main
git fetch upstream main
node --test scripts/education-architecture/inventory.test.mjs
node scripts/education-architecture/inventory.mjs --upstream upstream/main --head HEAD --out /tmp/educateos-delta
pnpm lint
```

Outputs: `/tmp/educateos-delta/inventory.json` and `inventory.md`. Reproduce historical
reports by passing their recorded upstream/head SHAs. No timestamps or absolute
paths enter output. Commit first: working tree changes are not included. Unknown
refs, malformed manifests and unexpected statuses fail closed; kernel violations
fail after reports are written. CI runs for every PR (including runtime-only edits),
fetches upstream and prints Markdown to its summary. No secrets or package install.

## Intentional exceptions

Inspect actual code and emitted fingerprint. Update only that exact path in
`scripts/education-architecture/exceptions.json` with a file-specific rationale,
alternatives, security implications and a review reference. Independent review
must assess manifest and code together. Do not blindly regenerate the baseline.
Wildcards and duplicate paths are rejected. Remove stale entries during upstream
reconciliation; they cannot authorize another fingerprint. Script/manifest edits
are review-sensitive, and reviewer requirements must be enforced externally.

See [ADR and trust boundary](0001-thin-product-fork.md), [roadmap](roadmap.md),
and [validation](validation.md). No automatic tracker synchronization is claimed.
