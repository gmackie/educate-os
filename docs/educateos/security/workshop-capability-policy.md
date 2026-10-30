# Workshop capability policy: first enforcement slice (SCHO-292)

Deployments may provide a Workers RPC service binding named `WORKSHOP_CAPABILITY_POLICY`
implementing `@gadgets/workshop-shared/capability-policy`. No binding preserves upstream behavior.
This branch does not enable any deployment binding or change credentials.

The User DO constructs descriptors from its persisted profile ID (a principal name when the
principal resolver is used), action, and requested resource identifiers. It never accepts a role
from the caller. Domain policy belongs in the deployment service: resolve identity, roles and
scoped grants from authoritative storage, treat all resource strings as data, deny unknown scopes,
and return only messages safe for the requesting user. Never return private educational records.
The kernel accepts only an explicit `outcome: "allow"`; failures and malformed decisions refuse the
operation. Decisions are not cached. Revocation affects the next checked mint, not capabilities
already issued or operations already admitted. The existing ownership/admin checks still apply.

## Enforced operations

- `UserDurableObject.newWorkspace`, including ordinary creation, creation from a Blueprint, and
  external/registration paths that delegate to it. The scope includes the new workspace ID and,
  for the Blueprint creation RPC, its source Blueprint ID.
- Model add and update, before reading or persisting model credentials. The model profile supplied
  by the client is a model identifier, never the requesting user's identity.
- Gatekeeper account connect, reconnect, grant widening and auto-provisioning. Optional MCP
  connectors use these same generic vendor checks. Automatic provisioning catches errors upstream
  as before, but a denied account is not minted.
- Gatekeeper resource class acquisition and external resource creation, checked before the external
  call. Applies to UI/agent requests and Blueprint binding assignment through these methods.

## Remaining choke points and deployment limits

This is **not a complete student security boundary**. Do not enable unrestricted student access on
its strength. Follow-up slices must cover Blueprint publication/import, sharing/collaboration and
share links (with authenticated collaborator identity), code execution and existing-capability
revocation. This branch deliberately does not gate publication late in `updateBlueprint`, since
`propagateBlueprint` has already written R2 by then. Sharing requires checks at all manager mint
paths, not merely the visible add-collaborator button. Code execution needs a trusted initiating
principal across autonomous, scheduled and collaborator turns, not the model author's profile.

Existing account login handoffs, selection exchanges, configurator/UI capabilities, ambient
singleton injection and capabilities already stored in workspaces are not comprehensively gated.
A policy cannot yet authorize based on workspace context for resource mints made through the User
DO. Policies needing that distinction must deny the action until those descriptors and checks are implemented. A policy should allow only
explicitly recognized actions; adding future action types must not silently grant authority.

The district adapter is documented in [district-workshop-capability-policy.md](district-workshop-capability-policy.md). The original enforcement slice includes no domain adapter: that domain service needs the district's authoritative grant
model (`packages/educateos-policy`) and a trusted mapping from these Workshop scopes. Tests use a
deny-by-default fixture policy to exercise scoped teacher grants, student denial, revocation, and injection attempts without inventing a client role.
