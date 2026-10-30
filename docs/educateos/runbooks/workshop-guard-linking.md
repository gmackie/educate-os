# Linking Workshop accounts to the district AI guard

An authenticated district sign-in does not by itself admit AI calls. The guard must use the same
district, and that district must hold an administrator-confirmed Workshop account link. Email
matching is never automatic. Confirming a link assigns no role, enrollment or funding.

An existing district administrator can use these authenticated district API routes:

- `GET /api/admin/workshop-user-links` reads the confirmed links.
- `POST /api/admin/workshop-user-links` accepts exactly `workshopUser` and `principalId`. The server
  records the authenticated administrator as `confirmedBy` and its own time as `confirmedAt`.

For a newly created principal-keyed Workshop account, use `principal:<principalId>`. That key must
name the principal being linked. For a migrated account, use the existing email-keyed Workshop ID
verified during the migration; a directory email alone does not prove that account's identity.
Use the account's actual kernel ID, never a Google user ID or Access subject. Duplicate accounts or
principals return `409`, including concurrent confirmations. Read the existing link rather than
retrying a successful POST. Teachers and students cannot read or create these links.

The production generator binds the district worker's `DistrictGuardDirectory` as the guard's
`EDUCATEOS_DISTRICT` whenever the instance deploys a district (SCHO-283). The guard reads it only
once its `AI_GUARD_CONFIG` says `contextSource: "district"`; until then it keeps its configured
directory, so an operator-only installation moves over by changing that configuration.

Roll out through Forge in this order:

1. Deploy the district linking API, preserving the existing guard configuration and bindings.
2. Confirm and read back each intended account link through an existing district administrator.
   Include the teacher/operator accounts before changing the guard.
3. Prepare `AI_GUARD_CONFIG` in the guard's Forge app: `contextSource: "district"`, the district's
   actual ID, funding pools scoped to that district, model rates/catalog, the policy floor and all
   four audience profiles. Keep student input moderation enabled, output moderation required and
   failure mode `fail-closed`. Unknown grades use `student-k5`. Do not promote students to educator
   profiles. Keep credentials and the private configuration outside source/evidence.
4. Set the guard's `AI_GUARD_CONFIG` secret to that configuration in Forge and redeploy the guard
   through Forge. Do not switch it before the links in step 2 are read back, or the operator's own
   assistant goes off. Changing district ID starts that district's ledger; the previous synthetic
   ledger remains separate and is not migrated or erased.
5. Verify teacher admission, student moderated input/output, unknown-account refusal and student
   refusal after deactivation. Read back the deployment ID, commit and actual provider version.

The binding reads current district records for every request and refuses a different district ID.
An inactive or graduated student has no guard subject. This setup enables policy-governed AI;
Google OAuth and an enrolled own-student Classroom resource are independent prerequisites.
