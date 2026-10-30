# School presentation

Build the Workshop frontend with `VITE_EDUCATEOS_SCHOOL_MODE=true` to use the school shell and
school sign-in guidance. The default build retains the ordinary Workshop and onboarding wizard.
The existing Vite task declares `VITE_*` as cache inputs.

The shell reuses the School Gatekeeper app (`educateos`), including its existing student, teacher,
family and administration screens. Available views come from the app's district-derived navigation;
the selected view is ephemeral navigation state. Neither URL role parameters nor local storage
provide role assignments. No records are copied into a separate frontend store. Missing, failed or
changed sessions show connection guidance rather than the Workshop onboarding/provider selectors.

Advanced Workshop requires a fresh `amIAdmin()` response for the current API session. This is a
conservative creator entry point: school administrator navigation does not grant Workshop access.
The read-only `getWorkshopAuthoringCapability({ operation, sourceBlueprintId })` query now asks the
configured policy for the authenticated principal, returning false without a binding or on failure.
It accepts no role or principal and grants no capability. A policy adapter must explicitly implement
`workshop.authoring.query`; old adapters deny unknown actions.

Authoring remains unavailable in the school view, including for teachers and explicitly granted
students. Discovery alone cannot safely open the existing advanced editor: it exposes provider/MCP
configuration, and the `agent.execute` checks currently have workspace scope without approved
Blueprint provenance. A focused creator must preserve that provenance at every agent/tool mutation,
use approved school connectors and models, and support revocation before enabling Create Gadget or
Adapt Blueprint. This is a delivery blocker, not an authorization workaround. The district-worker
adapter is owned separately and is intentionally unchanged here. Dependencies: SCHO-292 / PR #20.

Advanced Workshop selection is tied to the current authenticated API identity, so switching sessions
cannot carry the previous user's open editor into another session.

This is presentation, not authorization. The district still authorizes school requests. Backend
policy must separately restrict student access to arbitrary models, MCP providers and Workshop
capabilities; hiding these controls cannot enforce that policy. Embedded School app workspace
requests and all direct API requests remain subject to backend authorization.
