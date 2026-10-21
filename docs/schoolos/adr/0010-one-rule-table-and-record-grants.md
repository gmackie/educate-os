# ADR-0010: One rule table, record-backed grants, and flags that need a second reviewer

- Status: Accepted
- Date: 2026-10-21
- Issues: SCHO-87, SCHO-103, SCHO-54, SCHO-56, SCHO-128

## Context

The Content Studio (C03) and the curriculum service (C05) each shipped a local `Authorizer`
written in the A02 vocabulary but decided outside the policy engine, so their decisions were not
in the audit trail and their rules drifted from the district app's copy. Three questions from A02
were open: how a share recorded by learning-artifacts can take effect, whether administrators may
reach student work for appeals and retention, and how directory prechecks get audited. H01 also
found that a teacher could approve an imported item carrying a `blocking` flag.

## Decision

1. **One rule table.** The Content Studio's learning-resource rules and the curriculum activity
   rules are part of `DEFAULT_POLICY_RULES`. Both services take the district's `PolicyEngine` as
   their `Authorizer`; the local authorizers are deleted. Activities split by classification:
   `teacher-only` definitions are authored, published and installed by the offering's teacher
   only, installs need a planned or active term, and students are refused them
   (`classification-restricted`). `course` activities (assignments) stay manageable by all course
   staff.
2. **Scopes must exist.** The engine refuses (`scope.unknown`) a scope naming a school or offering
   the directory lacks, or an offering under the wrong school. The local authorizers checked
   this; a caller-built scope could otherwise fall inside another school's grants.
3. **Relationships come from records.** A rule may require a relationship to the specific
   resource (`share-grantee`, `appeal-reviewer`). The policy information point asks
   `RelationshipSource`s, which the owning services provide (`artifactShareRelationships`,
   `appealGrantRelationships`). Only an active principal holds relationships, and the audit event
   names the record (`grantId`) the deciding rule relied on.
4. **Shares respect the floor.** A grantee reads a shared `personal-private` artifact only while
   `studentPersonalConversations` is `shared-by-student`. Under `private` the owner cannot share
   personal-private content at all, and earlier grants stop working. This floor setting already
   governs whether students may share personal material; a dedicated setting can replace it later.
5. **Appeals use a purpose-bound grant.** A district admin issues an `AppealAccessGrant`: one
   purpose, one administrator, one student, one submission, artifact or feedback, a reason of at
   least ten characters, and an expiry of at most 14 days. Issuing and revoking are decided and
   audited as actions on a `restricted` `access-grant`; the reason stays in the grant, never in the
   content-free trail. The `appeal.reviewer.read` rule allows reads only, only of `course` work,
   only while the grantee still holds an admin role over it. `personal-private` content is never
   reachable. A district admin may name themselves: the grant and every read stay on record.
6. **Retention sees records, not content.** A district admin may list personal workspace records
   (`WorkspaceDirectory.listPersonalWorkspaceRecords`): owner, dates, lifecycle and legal hold,
   never the storage handle. Reading any one workspace stays owner-only.
7. **Prechecks are audited.** `AcademicDirectory` passes each request as built to its
   authorizer, so cross-district and malformed requests are audited as `precheck.*`, and still
   denies whatever `precheckAuthorization` refuses. `Caller.correlationId` carries one ID through
   nested calls; the school tool runner sets it, so a tool invocation's decisions share it.
8. **Blocking flags need an acknowledgement, and rights flags need a curriculum admin.** Approving
   an item requires acknowledging every `blocking` flag, recorded on the decision and in the
   item's audit trail. `license-conflicting` additionally requires `review` at the item's scope,
   which only a curriculum admin holds: it questions the district's right to use the content, and
   only a curriculum admin decides rights (only they widen them). `instruction-like-text` is about
   what the content says, which the reviewing teacher can judge. Imported text is only ever
   passed as data, so an acknowledged injection attempt still instructs nothing (threat T7).

## Consequences

- The district app's `DISTRICT_APP_RULES` is now the default table. It still has to wire the
  relationship sources and the appeals and retention routes (follow-ups).
- A co-teacher can no longer author, publish or install `teacher-only` activity definitions
  through the district app; the district app's previous table allowed it.
- `teacher.approveResource` must accept `acknowledgedFlags` before a teacher can approve a
  flagged item over HTTP. Until then such items can only be rejected there.
