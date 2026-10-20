# ADR-0005: Default-deny authorization vocabulary

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1. Enforcement: A02.

## Context

SchoolOS is reached through UI routes, HTTP APIs, MCP tools and agents acting for a principal. If
each surface authorized in its own way, the checks would drift. An agent can also be talked into
claiming whatever identity or permission a prompt suggests.

## Decision

1. Every surface builds the same `AuthorizationRequest`: a resolved subject principal, an `Action`,
   a `ResourceRef` (kind, scope, classification, owner) and context (channel, term state). Only
   trusted server-side data fills it.
2. The vocabulary is closed. Unknown actions, resource kinds, classifications and extra fields fail
   to parse, and a request that fails to parse is denied (`invalid-request`). That covers tool
   annotations such as `readOnlyHint`, a caller-supplied role, and any field nobody anticipated.
3. `precheckAuthorization` runs before any policy rule. It parses the request and denies requests
   across districts. Policy engines allow only what they explicitly match.
4. Personal and course spaces are different resource kinds, not one kind with a flag, so a rule for
   course work cannot match personal work by accident. Teachers have no default access to
   `personal-private` content.
5. A decision is `allow`, `deny` or `require-approval`. AI-suggested grades and similar
   consequential actions produce `require-approval`.
6. The reason for a denial is written to the audit log. Callers see `not-found` for resources they
   may not know exist and `forbidden` for ones they can already see, so probing IDs reveals
   nothing.
