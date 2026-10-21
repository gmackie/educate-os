# ADR-0001: District data ownership and root independence

- Status: Accepted. Amended by [ADR-0011](0011-open-source-charter-and-module-ownership.md) (2026-10-21)
- Date: 2026-10-20
- Issue: SCHO-1

## Context

Schools hold records about minors: identities, coursework, conversations, grades and AI usage.
Districts must stay in control of those records. SchoolOS also needs a commercial and fleet control
plane, `schoolos.dev`, for signup, releases and entitlements. (Withdrawn by the amendment below:
SchoolOS has no commercial control plane.)

## Decision

1. The district's Cloudflare account, or a provider the district explicitly approves, stores every
   education record. That covers principals, linked identities, workspaces, artifacts,
   conversations, assignments, submissions, assessment evidence, grades and per-principal AI usage.
2. `schoolos.dev` (the root) stores instance registration, release metadata, entitlement state, and
   health and aggregate cost only if the district opts in. It never receives prompts, chat text,
   student work or a roster. (Entitlement state withdrawn by the amendment.)
3. No classroom path calls the root once a district is provisioned. That includes sign-in,
   authorization, lessons, AI requests, grading and budget enforcement. The district verifies
   releases and entitlements against locally held signed documents with explicit grace periods.
   (Entitlements withdrawn by the amendment; release verification stands.)
4. If the root is unreachable or the installer's OAuth grant is revoked, the root cannot make new
   changes. District classroom activity is not interrupted.

## Consequences

- Every domain service is district-local. Its contracts in `@schoolos/contracts` carry a
  `districtId` on every scope, and any check across districts fails (`cross-district`).
- Fleet protocol messages (R01) are designed as an allow-list of fields, never as "everything
  except PII". (R01 is optional and off by default since the amendment.)
- An artificial root outage is a required test in the pilot security suite (H01).

## Amendment (2026-10-21, ADR-0011)

SchoolOS is open source and has no commercial control plane
([ADR-0011](0011-open-source-charter-and-module-ownership.md)). The original text above is kept as
the record of what was decided on 2026-10-20.

Withdrawn:

- The commercial and fleet control plane in the context. `schoolos.dev` may host documentation,
  an optional guided bootstrap and public release artifacts. It is not a control plane.
- Entitlement state in rule 2, and entitlement verification in rule 3. The default runtime checks
  no entitlements.
- The fleet protocol (R01) as a required part of an installation. Instance registration is opt-in,
  content-free and off by default; where an organization enables it, the allow-list rule in the
  consequences still applies.

Unchanged:

- Rule 1: the organization's account, or a provider it explicitly approves, stores every education
  record.
- Rule 3, apart from entitlements: no classroom path calls `schoolos.dev`, and releases are verified
  against locally held signed documents with explicit grace periods.
- Rule 4 and the root-outage test: an unreachable `schoolos.dev`, or a revoked installer grant,
  never interrupts classroom activity.
- The `districtId` scoping and the `cross-district` denial.
