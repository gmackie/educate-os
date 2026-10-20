# ADR-0001: District data ownership and root independence

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1

## Context

Schools hold records about minors: identities, coursework, conversations, grades and AI usage.
Districts must stay in control of those records. SchoolOS also needs a commercial and fleet control
plane, `schoolos.dev`, for signup, releases and entitlements.

## Decision

1. The district's Cloudflare account, or a provider the district explicitly approves, stores every
   education record. That covers principals, linked identities, workspaces, artifacts,
   conversations, assignments, submissions, assessment evidence, grades and per-principal AI usage.
2. `schoolos.dev` (the root) stores instance registration, release metadata, entitlement state, and
   health and aggregate cost only if the district opts in. It never receives prompts, chat text,
   student work or a roster.
3. No classroom path calls the root once a district is provisioned. That includes sign-in,
   authorization, lessons, AI requests, grading and budget enforcement. The district verifies
   releases and entitlements against locally held signed documents with explicit grace periods.
4. If the root is unreachable or the installer's OAuth grant is revoked, the root cannot make new
   changes. District classroom activity is not interrupted.

## Consequences

- Every domain service is district-local. Its contracts in `@schoolos/contracts` carry a
  `districtId` on every scope, and any check across districts fails (`cross-district`).
- Fleet protocol messages (R01) are designed as an allow-list of fields, never as "everything
  except PII".
- An artificial root outage is a required test in the pilot security suite (H01).
