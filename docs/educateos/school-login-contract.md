# School login and onboarding contract

School deployments bind `PRINCIPAL_RESOLVER` and configure both `CF_ACCESS_ISS` and
`CF_ACCESS_AUD`. Access verifies signatures, issuer, audience and token lifetime before
claims reach the resolver. The kernel also checks expiration when resolving a principal,
including when a retained public RPC capability asks to authenticate again.

`PrincipalResolver.resolveAccessSignIn({ issuer, subject, email? })` accepts only verified
Access claims. It returns `resolved` with a deployment-unique `principalId` and initial
`displayName`, `unauthenticated`, or `adoption-pending`. Rejection fails closed.
Email is an adoption hint, never an account selector. `(issuer, subject)` is exact and
stable across email changes. The backend exposes these decisions through the existing
`PublicApi.authenticateFromCfAccess()` RPC; there is no new OAuth implementation.

A resolved login addresses `principal:<principalId>`. Password login/signup, auth
gatekeeper login and all legacy session tokens are refused with the resolver bound,
even if Access configuration is incomplete. Device callbacks must independently verify
Access and resolve the same principal that staged the ticket before consuming it.
A missing audience or issuer cannot enable anonymous device delivery.
Without a resolver, the existing email and optional alternate login behavior is retained.

## Onboarding and preserving existing data

1. Provision students and staff through the district roster. A new guardian can request
   a guardian link; only an active district administrator can approve it.
2. Link a verified issuer/subject through `requestIdentityLink` and
   `approveIdentityLink`, rechecking the current directory at decision time. Claims
   cannot assign roles or select someone else's principal by email.
3. Inventory existing email-keyed Workshop users with `planEmailKeyedMigration`.
   Shared addresses and cross-district matches require manual investigation. Persist
   pending requests privately; never expose candidate records to the login caller.
4. Approval of an identity link does **not** move Workshop data. While an exact-single
   migration entry is pending, even an already-linked principal receives
   `adoption-pending`, regardless of its current email. The migration owner must transfer
   and verify the existing data before removing that pending entry and enabling login.
   This branch provides no data transfer endpoint; do not discard the migration plan to
   clear a login error. Deployments migrating existing users must supply that plan.

## District revocation and session limits

Set a principal's directory status to `inactive` or `graduated` to deny new resolution
through Access, LTI and confirmed Workshop account links. Retain the principal, external
identities and stored records: revocation does not delete data. Inactive administrators
cannot approve/reject identity links or confirm Workshop account links. Removed or
untrusted identity links also deny resolution.

Resolvers index snapshots. The service must reload the authoritative directory and build
fresh resolvers after changes (the district LTI adapter already does so per launch).
Reusing an old snapshot cannot provide immediate revocation. Existing authenticated RPC
capabilities and downstream capabilities are not retroactively revoked by this change;
closing existing connections and enforcing revocation on already-issued capabilities
requires session lifecycle integration. Do not claim that a directory update alone ends
all live sessions. Access expiration is checked on principal authentication and device
handoff; this does not add per-method authorization to the Workshop API.
