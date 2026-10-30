# District Workshop mint policy (SCHO-299)

Stacked on SCHO-292 / GitHub PR #14. `DistrictWorkshopCapabilityPolicy` is a named service
entrypoint of `@educateos/district-worker`, implementing the shared Workshop capability-policy
contract. Nothing enables it automatically. Without `DISTRICT_CONFIG.workshopPolicy`, this
entrypoint denies every mint. The Workshop kernel still preserves upstream behavior when no
policy binding exists at all; integration must configure both sides.

## Trust and authority

Only bind this entrypoint to the Workshop backend as `WORKSHOP_CAPABILITY_POLICY`. Holding the
binding permits asserting a Workshop user ID. The service accepts only `principal:<PrincipalId>`;
it does not authenticate an arbitrary caller's assertion of another principal. Workshop must build
that ID from its persisted authenticated user, using the principal resolver. Never expose this
binding, the district object's namespace, or a forwarding RPC route to gadgets, browsers, generic
MCP tools, external Workers or other untrusted code. Public fetch exposes no policy method.
Direct RPC callers cannot supply roles or district scope, but a compromised holder of this binding
could impersonate any active principal; Workers service binding isolation is part of this boundary.

Each call loads the live district directory, checks the principal's district, kind and active status,
and invokes the existing audited ABAC engine. That engine resolves current roles, dated assignments,
active enrollments and scope existence from district stores. No decisions are cached. Revocation
stops subsequent checked mints, including after object restart. With the Workshop's SCHO-309
revocation, a principal who stops being active, or whom this adapter stops allowing `gadget.execute`
or `agent.execute`, also loses what they already hold: the Workshop rechecks every 60 s and restarts
the objects hosting it ([live capability revocation](live-capability-revocation.md)).
`DistrictPrincipalResolver.principalStanding` answers that recheck from the live directory.
Deployment grant changes require updating DISTRICT_CONFIG and deploying/restarting the district
Worker. Role/status revocation needs no deploy.

## Explicit grant configuration

`workshopPolicy` is a strict optional object in DISTRICT_CONFIG. Example (IDs are illustrative):

```json
{
  "personalCreation": true,
  "personalBlueprints": ["approved-notebook"],
  "classBlueprints": [{"blueprintId": "english-authoring", "offeringId": "off_nf-eng9-fall-p3"}],
  "models": [{"provider": "cloudflare", "modelId": "approved-model"}],
  "connectors": [{
    "vendorId": "educateos", "accountId": 7,
    "resourceUrlPatterns": ["school://approved"], "resources": ["SchoolTools"]
  }],
  "workspaceActions": [{
    "kind": "staff",
    "actions": ["workspace.create.query", "workshop.authoring.query", "gadget.create",
                "gadget.execute", "agent.execute", "workspace.share", "blueprint.publish",
                "blueprint.import"]
  }]
}
```

- Workspace actions (SCHO-309): `gadget.execute`, `agent.execute`, `gadget.create`, `workspace.share`,
  `blueprint.publish`, `blueprint.import` and the two advisory queries are granted by active principal
  kind only, since the district has no record of Workshop workspaces; ownership and collaborator
  roles remain the Workshop's to check. Absent or empty `workspaceActions` denies all of them, so
  every Gadget, agent turn, share and publication is refused. Granting `student` lets active
  students run Gadgets and agents in workspaces shared with them; do so only with that intent.

- Personal creation: active students/staff create their own personal workspace through
  `personal.owner` ABAC. Source blueprints must match `personalBlueprints` exactly; bare creation
  requires `personalCreation` too. Other principals, unknown blueprints and arbitrary role fields deny.
- Class authoring: exact blueprint mapping identifies a server-configured offering, never a scope
  parsed from the workspace ID. Active staff must pass `create` on an unowned teacher-only
  course-workspace in that offering, in an active term. ABAC recognizes scoped teachers/co-teachers
  and course administrators. Duplicate mappings or personal/class ambiguity deny. This authorizes
  the mint only; it does not associate the new Workshop workspace with a district course record.
- Configuration: exact provider/model pair, or exact vendor/account and pattern/resource grant,
  followed by `update` on the district through `admin.district.directory`. School administrators,
  teachers and students have no district configuration authority. No credentials cross this service.
- Connector accounts match exactly, including absence: a grant without accountId is for initial
  connection only. Resource URL patterns must equal the entire approved set (omission is not a safe subset); the adapter
  does not interpret wildcard patterns or URLs. Configuration authors must understand any broad
  pattern they approve. Resource names are opaque exact identifiers; URL/role/prefix manipulation
  grants nothing. Do not configure generic external MCP vendors here without a separate audited
  server-owned endpoint and capability design. An account bound to an unapproved endpoint must
  never be added just because it has an approved-looking resource name.

Unknown actions and malformed inputs deny (or generated RPC validation rejects them). Store/engine
failures reject the call and the Workshop kernel fails closed. Denials contain no district records.

## Integration captain: manifest wiring

The release school profile (`scripts/release/school-profile.ts`) binds `WORKSHOP_CAPABILITY_POLICY`
to `$WORKER_NAME(educateos-district-worker)`'s `DistrictWorkshopCapabilityPolicy`. The hosted
production instance binds it through `capabilityPolicyBinding: true` in
`scripts/production/schoolos-gmac-io.ts` (SCHO-309), which also sets
`REQUIRE_WORKSHOP_CAPABILITY_POLICY` and requires `principalBinding: "resolver"`; regenerate
`wrangler.production.jsonc` with `pnpm production:configs`. Deploy the district entrypoint (with
`principalStanding`) and its `workshopPolicy` before the backend binding. Keep the adapter
inaccessible to frontend/auth/public routes.

This PR supplies an adapter only; it does not complete the Workshop sandbox security perimeter.
All remaining choke points in [the kernel policy slice](workshop-capability-policy.md) still apply:
publication/import, sharing, execution, ambient/selection/configurator/account paths and already
minted capabilities. Resource mint descriptors carry no trusted class/workspace context: student
and teacher connector/model mints therefore remain denied, even when a class tool might otherwise
be educationally appropriate. AI call governance remains a separate per-call control.
