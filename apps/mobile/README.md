# EducateOS Mobile

Native iOS, iPadOS, and Android EducateOS, built with Expo SDK 58 and React Native 0.88.

STATUS: SOURCE IMPLEMENTATION FOR REVIEW. This is NOT yet a signed, tested or deployed app.
Dependencies are locked with pnpm. Verified app links, signing and physical-device tests remain release prerequisites.

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

This is an independent pnpm project under apps/mobile and does not modify the pnpm/workerd lockfile.
Run these commands from the repository root:

    cd apps/mobile
    pnpm install --frozen-lockfile
    pnpm exec expo install --check
    pnpm run typecheck
    pnpm test
    pnpm exec expo start --dev-client

Native cookies and universal links require an Expo development build, not plain Expo Go.
The committed pnpm-lock.yaml pins the isolated mobile dependency tree.
Expo patch versions are pinned below today's releases to respect the 24-hour dependency-age policy;
`expo.install.exclude` records these three deliberate pins.

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

1. Run pnpm install --frozen-lockfile in apps/mobile; check deliberate Expo patch pins before updates.
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

## Local standalone builds

EAS project: https://expo.dev/accounts/gmacko/projects/educateos-mobile
(project ID `4bb5e5bd-0dbb-453e-843b-1c96c4307851`).

Run EAS commands from `apps/mobile`, using the account and project linked in `app.config.ts`.
The root `.easignore` uploads only this standalone app and excludes native output, dependencies,
local environment files and signing credentials. Inspect the upload before changing that boundary:

    eas build:inspect --platform ios --profile development-simulator --stage archive --output /tmp/educateos-eas-archive

Build profiles:

- `development-simulator`: iOS simulator development client; no Apple signing required.
- `development`: physical iOS development client and Android APK; iOS needs registered devices.
- `preview`: standalone internal distribution; Android APK and iOS ad hoc signing.
- `production`: store distribution, Android AAB, and remote build-number/version-code increments.

Build locally by default; these commands do not use EAS cloud build workers or build credits.
Run from `apps/mobile`:

    pnpm build:ios:local --output /tmp/educateos-preview.ipa
    pnpm build:android:local --output /tmp/educateos-preview.apk

Both use the `preview` profile and embed the JavaScript bundle, so the installed app needs no
Metro server. iOS requires macOS, Xcode 26+, CocoaPods and Fastlane. Android requires the Android
SDK and a compatible JDK. The linked Mac mini has the iOS tools installed. EAS CLI must be installed
and signed in; local builds still contact Expo for project metadata, remote versioning and signing
credentials. Registered iOS devices remain necessary for ad hoc installation. Keep the generated IPA
or APK outside the repository. Cloud builds require an explicit decision; omit `--local` only then.

Profiles pin Node 24.14.0 and pnpm 11.17.0. Both platforms use EAS's latest image; SDK 58
requires Xcode 26 or newer. Channels are omitted until `expo-updates` and a runtime-version
policy are configured. Store builds do not submit themselves; `eas submit` is a separate step.
EAS manages signing credentials remotely; never commit downloaded credentials or private keys.

## School setup QR codes

Encode an enrollment link as a QR code. Scan it using the phone's Camera app and open EducateOS.
The app fills the enrollment form for review; it does not sign in or save the school automatically.
Only public school addresses belong in the code, never credentials, student details or session tokens.

Example for the Google demo:

```text
educateos://enroll?name=Harbor+Charter&portal=https%3A%2F%2Fharbor.educateos.io&workshop=https%3A%2F%2Fschoolos.gmac.io
```

The iOS association file in `app-links/.well-known/apple-app-site-association` uses the verified
Apple team ID P4SWQXAB5H and bundle ID io.educateos.mobile. Publish `app-links` as static assets
at mobile.educateos.io, with the `_headers` rules, no Access login and no redirects on the
association file. This host is required independently of QR enrollment. A fresh install may be
needed after publishing because iOS caches domain associations. Android still needs its own
assetlinks.json using the actual signing certificate; this directory does not claim Android verification.

## Connect from a signed-in computer

On the computer, open https://mobile.educateos.io/pair, confirm the school and workspace addresses,
and create a pairing QR. On the phone, scan it with Camera and open EducateOS. Review the school,
choose **Connect this phone**, compare the code on both screens, then approve on the computer and
confirm the signed-in identity in Workshop. Pairing expires in two minutes and needs a new QR after
cancellation, expiry or use. The phone retains the encryption private key; the relay gets ciphertext
only. Do not scan unsolicited pairing codes or approve a code that does not match.

The callback host is now published, including its verified Apple association. If iOS cached an
older/missing association, reinstall the newest standalone app. School enrollment also accepts
`https://mobile.educateos.io/enroll#` followed by the same URL-encoded public school parameters.
HTTPS links have a browser fallback with an **Open EducateOS** button.
