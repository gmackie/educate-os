# ADR-0004: Capability packs and policy floors

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1. Compiler and UI: F03.

## Context

District administrators need to turn features on for some classes, set AI budgets and privacy
rules, and preview the effect before anything changes. They should not have to face dozens of
independent toggles, and nothing they delegate should let a school or teacher undercut district
privacy or spending rules.

## Decision

1. Features ship as **capability packs** described by a `CapabilityManifest`. A manifest lists the
   pack's dependencies, conflicts, config schema, supported scopes, permissions, platform resources,
   migrations, probes and cost drivers. Packs are reviewed and version-pinned. A manifest cannot
   carry an install script.
2. **Installed**, **enabled** and **exposed** are separate states.
3. Configuration is stored as immutable, chained `ConfigurationRevision`s. That chain is what
   provides diff, audit and rollback. Secrets are never stored in a revision.
4. Policy resolves district → school → offering → activity. The district sets a complete
   `PolicySettings` floor. Each narrower level may only move a setting toward its strict end, as
   ordered in `POLICY_ORDERINGS`, or lower a numeric cap. `resolvePolicy` reports every loosening
   attempt instead of only the first, so an administrator sees the whole conflict.
5. Administrator forms, the API and the CLI all validate against the manifest's JSON Schema. No
   form has its own hand-written validation.

## Consequences

- New governance settings must come with an ordering. A setting with no clear "stricter" direction
  does not belong in the floor and should be a plain pack option.
- `automatedSelProfiling` defaults to `prohibited` in every shipped profile, and the ordering
  prevents any narrower scope from enabling it.
