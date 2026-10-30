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
A broader creator entitlement needs a backend capability contract in a separate track.

This is presentation, not authorization. The district still authorizes school requests. Backend
policy must separately restrict student access to arbitrary models, MCP providers and Workshop
capabilities; hiding these controls cannot enforce that policy. Embedded School app workspace
requests and all direct API requests remain subject to backend authorization.
