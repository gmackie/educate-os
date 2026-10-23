# ADR-0012: Guardians read through confirmed relationships, and roles can be dated

- Status: Accepted
- Date: 2026-10-23
- Issues: SCHO-188, SCHO-184. Contract foundation of LMS-lite slice L4; guardian routes and UI
  follow.

## Context

LMS-lite needs parents and other caregivers to see how their child is doing: what the child is
enrolled in, what is due, the feedback and grades the child has been given, and class
announcements. SchoolOS had no principal for them. `PrincipalKind` was `student`, `staff` or
`service`, and the closed `SchoolRole` enum had no guardian. OneRoster import skips guardian,
parent and relative rows on purpose (A03), because a roster's family links are not reliable
enough to open a child's records.

A guardian is unlike every existing principal. Their access is to *one person's* records, not to
a scope: a role at an offering would give a parent the whole class. Families are also where
access goes wrong in practice. Siblings share an email address (ADR-0003), custody changes,
courts restrict one parent, and a student who reaches majority may hold the rights to their own
records.

Separately, district staff asked for roles that end on their own, such as a substitute's cover
for two weeks. `RoleAssignment` had no dates, so an administrator had to remember to remove one.

## Decision

1. **A guardian is its own principal kind.** `PrincipalKind` gains `guardian`: neither staff nor
   student. A guardian holds no `SchoolRole` and no enrollment. `checkDirectoryIntegrity`
   refuses either, and the policy information points (`subjectFactsFrom`, `principalFactsFrom`)
   give a guardian no roles even if one were stored. A guardian signs in with a `person`
   credential like any other person, so ADR-0003's rules apply unchanged.
2. **Authority comes only from a `GuardianRelationship` record.** Each record names one guardian
   and one student in one district, with an ID (`grl_…`). Nothing else makes anyone a guardian:
   not a roster row, not a token claim, not the guardian's own assertion, not a shared email
   address. The record carries:
   - `status`: `pending` (recorded, unconfirmed), `active` (confirmed by a district admin) or
     `revoked` (ended, kept). Only `active` grants anything, and revoking never deletes it.
   - `validFrom` and an optional `validUntil`, enforced at each decision.
   - `readableKinds`: which of the readable kinds it opens. A district narrows this to honour a
     restriction, such as withholding grades from one guardian.
   - optional `offeringIds`, narrowing it to some of the child's offerings.
   - `consent`: `not-required` for a minor; `granted` or `withdrawn` once the student holds the
     rights (FERPA's eligible student). `withdrawn` stops every read.
   - optional `suspended` (who, when, an opaque reason code): access stops without ending the
     relationship, such as while a court order is reviewed. The reason is a code, never free
     text, so no family detail reaches the record.
   - `created`, `confirmed` and `revoked` stamps (who and when). The schema refuses an `active`
     record with no confirmation, a `pending` one with one, and a revoked stamp that does not
     match the status.
3. **Guardians are read-only in v1.** A guardian reads (`read`, `list`) these kinds and nothing
   else (`GUARDIAN_READABLE_KINDS`):
   - the child's `offering`s, while the child is actively enrolled as a student;
   - their `course` `activity` records (assignments and their due dates), never `teacher-only`
     activity definitions;
   - `feedback` and `official-grade` records the child owns, including in offerings the child has
     left and completed terms, as the child can;
   - the offerings' `announcement`s.

   Only `public`, `district-internal` and `course` classifications match, so `teacher-only`,
   `personal-private` and `restricted` content never does. Services build a guardian's view from
   the child's own view: a guardian never sees more than the child. In particular feedback the
   teacher has not released to the child is not released to the guardian.
4. **What a guardian never reads.** Personal workspaces and conversations, shared conversations,
   the child's working artifacts, submissions and course workspaces, rosters and enrollments,
   the directory, any other child's records, district reference data and tools. Discussions are
   excluded until a district policy setting allows guardians to see them; no such setting exists
   yet. Every write, export, share and tool invocation is denied.
5. **Two rules, first in the table.** `guardian.child.read` allows the reads above when the subject
   is a guardian holding a `guardian-of` relationship to the resource. `guard.guardian.child-records-only`
   denies a guardian everything else. They come before every other rule, so no rule written for
   "any principal of the district" (reference data, published resources, tools, shares) can
   reach a guardian. Rules can now name `principalKinds`, read from the directory.
6. **The relationship source checks the child, not the record.** `guardianRelationships(store,
   directory, now)` is a `RelationshipSource` (ADR-0010). It yields `guardian-of` for a
   relationship that is in force, names the subject as guardian, and covers the resource: the
   child owns it (feedback, grades), or it is unowned at an offering where the child is actively
   enrolled (offering, activities, announcements), within `readableKinds` and `offeringIds`.
   Both principals are re-read from the directory on every decision, so an inactive guardian or a
   graduated child ends access at once. The deciding relationship's ID is the decision's
   `grantId`, so every read is audited with the record that allowed it. Because a guardian
   relationship names a person rather than one record, it can also answer a `list` at a scope;
   the information point now asks every source, and record-bound sources (shares, appeal
   grants) still return nothing for a resource with no `id`.
7. **Managing relationships is a district admin's decision.** A `guardian-relationship` is a new
   `restricted` resource kind. `admin.district.guardian-relationships` lets only a district admin
   create, list, read, update and approve them, as with identity links (ADR-0003, SCHO-38): they
   decide who may read a child's records. A school admin cannot, and neither can the guardian.
8. **Onboarding is three separate decisions.** A district admin invites a guardian for a named
   student. The guardian signs in through a trusted issuer, which produces a pending identity
   link (ADR-0003); an invitation is never authority, and redeeming one only starts that request.
   A district admin approves the link, which is what makes the sign-in a guardian principal. The
   relationship then stays `pending` until a district admin confirms it. An administrator can
   decide all three, but each is recorded on its own.
9. **Role assignments can be dated.** `RoleAssignment` gains optional `validFrom` and
   `validUntil` (exclusive). `roleAssignmentInForce` is the one test. The policy engine applies
   it at each decision to whatever facts its information point returned, so an expired role
   grants nothing even through cached or hand-built facts; the information points, the academic
   role-table authorizer, the identity-link and Workshop-link admin checks and the AI guard's
   subject also honour it. An expired assignment stays on record. The directory refuses one
   whose `validUntil` is not after its `validFrom`.

### What changes in ADR-0005's closed vocabulary

ADR-0005 keeps its rule that adding a member is a contract change. This ADR adds:

- `PrincipalKind`: `guardian`.
- `ResourceKind`: `announcement` (an unowned `course` notice at an offering, posted by its
  instructors and read by its students, their guardians and administrators over it) and
  `guardian-relationship`.
- The policy `Relationship` enum: `guardian-of`.
- `RuleCondition.principalKinds`.
- Optional `validFrom` and `validUntil` on `RoleAssignment`, and the `grl` ID prefix.

`SchoolRole` is unchanged: guardian is a kind of principal, not a role at a scope. A caller still
cannot assert a kind; it is read from the directory like everything else in a request's facts.

## Consequences

- Guardians cannot be imported from a roster. A district that wants roster-sourced family links
  will have to stage them as `pending` relationships for an administrator to confirm, never as
  live ones.
- Every guardian read costs a store and directory read. They are small, per-district reads, and
  correctness depends on them being fresh.
- A student's sharing of a personal artifact cannot reach a guardian: the guardian rules come
  before `share.grantee.read`. Learning-artifacts still accepts a guardian as a share grantee;
  refusing that at share time is follow-up work.
- Admin oversight and student reads now cover `announcement`, ahead of the service that stores
  them.

## Follow-ups (guardian routes and UI wave)

- A durable `GuardianRelationshipStore` in the district's control Durable Object, and a
  `GuardianRelationships` service (record, confirm, narrow, suspend, revoke) authorized on
  `guardian-relationship`, after `AppealGrants`.
- Invitations, and creating a guardian principal when its first identity link is approved: a
  `Principal` needs an identity today, so identity-links has to learn to create one.
- Wiring `guardianRelationships` into the district app's policy information point, and guardian
  routes that build the child's view and filter lists to the child's records.
- A guardian UI, and an announcements store and routes.
- Pilot-gate rows for guardian isolation, once the routes exist to test over HTTP.
- A policy-floor setting for guardian access to discussions, if districts want it.

## Implementation (SCHO-188, guardian routes and UI)

- **Store and service.** `GuardianRelationshipStore` keeps each relationship with an append-only
  history of `GuardianRelationshipAuditEvent`s, written in the same commit, and refuses a commit
  planned against a record that has since changed. `GuardianRelationships` (`@schoolos/policy`)
  records, confirms, changes the scope of, suspends, resumes and revokes relationships, each decided
  on a `guardian-relationship`. The district Worker's object holds the durable store
  (`DurableObjectGuardianRelationshipStore`).
- **Onboarding.** `GuardianInvitations` (`@schoolos/identity-links`) issues a single-use token
  (only its digest is kept) with a `pending` relationship naming a reserved principal ID. Redeeming
  it records a pending identity link whose `newPrincipal` makes approval create the guardian's
  principal (`requestNewPrincipalLink` in `@schoolos/identity`); a sign-in that is already an
  active guardian's joins the relationship instead. Email delivery waits for L5: the admin route
  returns the link, with the token in its fragment, for the administrator to hand over.
- **Routes.** The district app wires `guardianRelationships` into its information point. The
  `guardian` surface lists a guardian's children, a child's classes, and one class's assignments
  with the feedback released to the child (`AssessmentService.releasedFeedback`, the child's own
  view) and official grades. The `onboarding` surface answers a verified sign-in with no principal
  yet, for redeeming an invitation only. Admin routes manage relationships and decide sign-ins.
- **Sharing.** Learning-artifacts refuses a guardian as a share grantee.
- **Still to come.** Announcements (no store yet), a child's classes from completed enrollments
  the child has left (the policy allows reading those grades; the routes list active enrollments
  only), and pilot-gate rows for guardian isolation.
