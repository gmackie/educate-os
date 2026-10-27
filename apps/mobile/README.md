# EducateOS Mobile

Native iOS, iPadOS, and Android EducateOS, built with Expo SDK 58 and React Native 0.88.

STATUS: SOURCE IMPLEMENTATION FOR REVIEW. This is NOT yet a signed, tested or deployed app.
A subsequent EAS agent will finish dependency pinning, verified app links, signing and device tests.

## Implemented mobile UI

- District chooser and self-hosted deployment enrollment with HTTPS origin validation
- CloudflareOS per-installation encrypted native authentication flow
- Secure platform storage and account switching
- Today, Classes, Calendar, Inbox, AI Workspace and Account navigation
- Student class/grade summary, activity details, submission receipts and written response creation
- Teacher roster, assignments, submission feedback, recorded grading and release controls
- Guardian-linked children, classes, released grade summaries and announcements
- Secure WebView for the full Workshop/Gadget UI, bridge, and external gatekeeper OAuth sessions
- Accessible action labels, error/loading/empty states, iPad layout support

## Setup

This is an independent npm project under apps/mobile and does not modify the pnpm/workerd lockfile.
Run these commands from the repository root:

    cd apps/mobile
    npm install
    npx expo install --check
    npm run typecheck
    npm test
    npx expo start --dev-client

Native cookies and universal links require an Expo development build, not plain Expo Go.
The build agent must generate and commit a reproducible package-lock.json.

## Authentication

For each sign-in the app generates an ephemeral P-256 keypair and opaque state. The app passes
only the public key and state to the district's Workshop sign-in, which requires explicit browser
confirmation and returns a single-use encrypted two-minute transfer to a claimed HTTPS app link.
ECDH, HKDF-SHA-256 and AES-GCM with state-bound AAD decrypt the transfer on the device. Credentials
are stored only in Expo SecureStore; ephemeral private keys are wiped.

The default first-party callback host is https://mobile.educateos.io
- /oauthredirect for installation sessions
- /authpopup for gatekeeper reauthentication

The fork's Workshop backend supports optional NATIVE_APP_CALLBACK_ORIGIN, and its frontend supports
VITE_NATIVE_APP_CALLBACK_ORIGIN. They must both match the verified app-link host in production.

App links need REAL identities. Host an Apple AASA file at
https://mobile.educateos.io/.well-known/apple-app-site-association
using the actual Apple Team ID + bundle ID. Host Android Digital Asset Links at
https://mobile.educateos.io/.well-known/assetlinks.json
using the actual signing certificate SHA-256. Do not publish fake placeholders. The next agent
must verify both on signed physical-device builds.

District academic APIs require a Cloudflare Access assertion accepted by the district Worker.
Opaque Workshop password sessions are NOT district credentials. With password-only sign-in, the
app opens the full Workshop but academic native pages explain why Access is not available.

## EAS handoff checklist

1. npm install in apps/mobile, pin versions via expo install --fix if necessary, commit lockfile.
2. Run typecheck, unit tests, expo-doctor, and PR CI.
3. Use a simulator and physical iOS/Android devices to test P-256 auth interoperability, logout,
   callback replay, expiry, origin switching, and secondary gatekeeper OAuth.
4. Set up real EAS project ID, Apple and Google signing credentials, icons and splash screen.
5. Publish validated AASA / Android Asset Links and verify universal links.
6. Build EAS development and preview profiles, then TestFlight and Android distribution.
7. Test authorized student, teacher, guardian, nonmember, expired-session, revoked-policy and
   pending-grade-approval scenarios against a district test deployment.
8. Review app-store policies, children's privacy and export compliance.
9. Report EAS build URLs and physical device results; do not claim release readiness from TypeScript.

The native inbox polls while the app is foregrounded. Remote APNs/FCM push enrollment is NOT
implemented until a district-approved delivery service exists. Upstream CloudflareOS's internal
central notification service is not currently open source; do not send student device tokens
to an untrusted central relay.

Rich quizzes, complex content authoring, and advanced district administration are available
through the authenticated Workshop/School apps instead of duplicated native editors. Student
work is never cached offline without an approved encryption, retention and revocation plan.
