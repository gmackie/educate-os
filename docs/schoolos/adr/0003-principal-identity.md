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
3. Keep the email-keyed lookup only for deployments without SchoolOS enabled.

The fixtures include a Northfield teacher and a Riverbend teacher who share both an email address
and an IdP subject. They must stay two principals.
