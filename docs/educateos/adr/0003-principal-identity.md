# ADR-0003: Issuer-qualified principal identity

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1. Implementation: F04.

## Context

Today the Workshop identifies an Access user by email. `authenticateFromCfAccess` looks up
`UserDurableObject` by `idFromName(email)`, and the device-session callback and password login do
the same. Email is a poor key for a school:

- Addresses get reassigned when staff leave, recycled after students graduate, and renamed after
  name changes.
- Families share one address across siblings.
- The same teacher can hold the same address in two districts.

Keying on email can merge two people into one account, or split one person into two.

## Decision

1. A **principal** is a district-local record with an opaque ID (`prn_…`). It never derives from
   an email, a name or an external ID.
2. A principal holds one or more **external identity links**: `(districtId, issuer, subject)`, taken
   from verified tokens (`iss` and `sub`). The lookup key is the JSON encoding of that tuple
   (`externalIdentityKey`), so no choice of issuer or subject can collide with another.
3. A district lists the issuers it trusts. A link from any other issuer is rejected, and two
   principals may never share a link (`checkDirectoryIntegrity`).
4. Email is optional profile metadata. It is not unique, and nothing authenticates or authorizes
   with it.
5. Roles come from roster or local grants. They are never read from token claims. A role claim in a
   token is ignored.

## Migration (F04)

Existing users are keyed by email. F04 will:

1. Add a principal directory that maps identity links to principal IDs.
2. On first sign-in after upgrade, resolve the link. If it is new and exactly one email-keyed user
   exists, record a pending link for an administrator to confirm. Never link silently.
3. Keep the email-keyed lookup only for deployments without EducateOS enabled.

The fixtures include a Northfield teacher and a Riverbend teacher who share both an email address
and an IdP subject. They must stay two principals.

## Implementation notes (F04, SCHO-5)

`@educateos/identity` implements this decision as a library. The kernel is unchanged until its
sign-in seam lands in a separate PR.

- **Resolution.** `PrincipalResolver.resolve` reads only `issuer`, `subject` and the credential
  kind. Every other claim (email, roles, groups) is ignored. An untrusted issuer, an unknown link
  or the wrong credential kind all fail as `unauthenticated`.
- **Cloudflare Access.** `identityFromAccessPayload` takes a payload `verifyCfAccessJwt` has
  already verified. The issuer is Access's `iss`, the team domain
  (`https://<team>.cloudflareaccess.com`), and it must equal the deployment's `CF_ACCESS_ISS`
  exactly. A district that signs in through Access lists that string in `trustedIssuers`. The
  subject is Access `sub`, the Access user ID, and never `email`. A token with a missing or empty
  `sub` is rejected.
- **Service tokens.** An Access service-token JWT carries `common_name` (the client ID) and no
  `sub`. It becomes a `service` credential with subject `service-token:<common_name>`, which
  resolves only when an administrator has linked it to a `service` principal. Person credentials
  never resolve to service principals, and service credentials never resolve to people.
- **Linking.** A new identity is linked only by a district administrator approving a pending link.
  Approval re-runs every check, refuses an identity linked to anyone, and emits an audit event that
  contains no email.
- **Migration.** `planEmailKeyedMigration` sorts existing email-keyed Workshop users into
  `exact-single` (a pending adoption awaiting confirmation), `ambiguous`, `cross-district` and
  `unmatched`. It never links or merges anything itself.
- **Caveat.** Access keeps one user record per email in a Zero Trust organization. If the IdP
  reassigns an address and the old Access user is never removed, the new holder may receive the
  same `sub`. District offboarding must therefore revoke departing users in Access, too. This
  needs to be confirmed against a live organization before pilot:
  [runbooks/access-sub-stability.md](../runbooks/access-sub-stability.md) (SCHO-37) is the
  procedure, and lists what this caveat becomes for each outcome.

## Kernel seam (SCHO-35)

The kernel takes an optional `PRINCIPAL_RESOLVER` service binding
(`@gadgets/workshop-shared/principal-resolver`). `createAccessSignInResolver` in
`@educateos/identity` implements it over one district's directory; a Worker entrypoint bound as
`PRINCIPAL_RESOLVER` delegates to it.

- **Unbound.** Sign-in keys `UserDurableObject` by email, exactly as before.
- **Bound.** Access sign-in passes the verified `iss` and `sub` (and `email`, as an adoption hint
  only) to the resolver, and the user DO is named `principal:<principalId>`. An unresolved sign-in
  fails with `PRINCIPAL_UNRESOLVED` and a pending adoption with `PRINCIPAL_ADOPTION_PENDING`;
  neither falls back to email. The device-session callback checks its handoff against the resolved
  principal's DO.
- **Other sign-in is off while bound.** Session tokens, passwords and authentication gatekeepers
  name email- or username-keyed users, so `authenticate`, password login and gatekeeper sign-in are
  refused. Gatekeeper sign-in needs its own seam, for gatekeepers to report a verified issuer and
  subject.
- **Admins.** `ADMINS` lists user DO names, so a principal deployment lists
  `principal:<principalId>` entries.

## Pending links and adoptions (SCHO-38)

`@educateos/identity-links` keeps a district's pending identity links and Workshop user adoptions in
an append-only log, held by the district's control Durable Object (`DurableObjectIdentityLinkStore`).

- **Who decides.** `IdentityLinkAdminService` authorizes every list, approval and rejection through
  the policy engine as an `identity-link` resource at district scope. The rule
  `admin.district.identity-links` grants it to `district-admin` alone: not school administrators,
  and not the person being linked.
- **Approval** claims the request in the log, writes the directory through `approveIdentityLink`
  (which re-runs every check), then records the decision with its `IdentityLinkAuditEvent`. A
  rejection cannot land between the two writes, and approving again finishes an interrupted
  approval without linking twice.
- **Adoption** confirmation records a `WorkshopUserRebindIntent` with its audit event: the
  email-keyed Workshop user's data is to be rebound to the principal, never deleted. A Workshop user
  is adopted into one principal, and a principal adopts one Workshop user. The kernel rebind that acts
  on the intent is separate work.
- **No email** reaches the log: links and adoptions carry identifiers only, and their schemas are
  strict.

## Migrating email-keyed Workshop users (SCHO-259)

The district Worker implements the seam as `DistrictPrincipalResolver`, over
`createAccessSignInResolver` with no adoption flow: a sign-in resolves to the principal its Access
`(iss, sub)` is linked to, or is refused with "Your school hasn't set up your account here yet". A
district that cannot answer refuses every sign-in with a retryable message; nothing falls back to
email.

Existing users move by **alias**, not by copy. `matchEmailKeyedUsers` (over
`planEmailKeyedMigration`, so only `exact-single` emails) proposes a principal for each email-keyed
user; a Workshop administrator reviews a dry run and applies it. Applying records
`principal:<id>` → `<email>` in the Workshop's user directory, and sign-in then addresses the
existing email-named Durable Object. That object stays authoritative and keeps its name and ID, so
its workspaces, shares, connected accounts, sessions and every other object's reference to it keep
working, and nothing is moved or deleted.

- **Why not copy.** A user Durable Object is referenced by its ID from overseers, shares and
  pending handoffs, and holds state (connected accounts, notification devices) that other objects
  call back into. Copying it would mean rewriting those references while users are signed in, and
  a partial copy would split one person in two. An alias is one row, and a run can stop at any
  point.
- **Idempotent and conservative.** Each principal and each user is aliased at most once. A run
  skips, as a `conflict`, a principal that already has its own account (aliasing would hide it), so
  run the migration before `PRINCIPAL_RESOLVER` is bound (`PRINCIPAL_MIGRATION` binds the same
  entrypoint without changing sign-in).
- **What stays email-named.** An aliased user's ID (`AiChatAuthorInfo.id`, what the AI call guard
  sees, and what `ADMINS` lists) is still its email. Only users created after the cutover are named
  `principal:<id>`.

The procedure is in [the production instance runbook](../runbooks/production-instance.md#principal-identity-cutover-scho-259).

