# EducateOS Mobile

Native iOS, iPadOS, and Android EducateOS, built with Expo SDK 58 and React Native 0.88.

STATUS: SOURCE IMPLEMENTATION FOR REVIEW. This is NOT yet a signed, tested or deployed app.
Dependencies are locked with pnpm. Verified app links, signing and physical-device tests remain release prerequisites.

## Implemented mobile UI

- expo-router navigation (`app/`) with deep links: `educateos://class/<id>`, `/assignment/<id>`,
  `/review/<id>`, and the `https://mobile.educateos.io/j#…` pairing QR (SCHO-262)
- Onboarding: scan a school code (in-app scanner), find my school (off by default), or one web address
  checked against `/.well-known/educateos.json`; code-comparison pairing; optional notifications and Face ID
- Device credentials (`src/api/device.ts`): a P-256 key in SecureStore, ES256 request proofs,
  single-flight refresh, and a "signed out by your school" screen when the district revokes the phone
- Role-aware tabs: student Today · Classes · AI · Inbox · Me; teacher Today · Classes · Review · AI · Me;
  family Family · Calendar · Inbox · Me. AI is hidden when the school's manifest says it has none
- Light and dark themes (system or user choice), passed to the AI workspace WebView; school accent from the manifest
- Legacy two-address schools and the SCHO-256 Workshop pairing still work, and saved schools migrate to one origin
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

## Try it in the Simulator with real data

`pnpm educateos:mobile-district` (from the repository root, after `pnpm install`) serves a seeded
Northfield on http://localhost:4810. It is the browser demo's district (`@educateos/demo`) with
phone pairing turned on: a student (Amara Okafor), a teacher (Sam Rivera), a guardian (Grace
Okafor) and an administrator, with classes, assignments, submissions, feedback and announcements.

    pnpm educateos:mobile-district                     # terminal 1, repository root
    cd apps/mobile && pnpm exec expo run:ios           # terminal 2: builds EducateOS Dev into the Simulator

In the app choose **I have a web address**, enter `http://localhost:4810` (with `http://`), then
**Sign in with a demo person** and pick who to be. The page approves the phone through the real
pairing relay, so the app holds a real device credential. Development builds accept loopback school
addresses (`DEV_LOOPBACK` in `src/security.ts`); release builds never do. The district keeps
everything in memory: restarting it signs the phone out, so remove the school from the welcome
screen and pair again. On an Android emulator, run `adb reverse tcp:4810 tcp:4810` first.

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

Each profile sets `APP_VARIANT`, which picks the app's name and identifiers (`VARIANTS` in
`app.config.ts`, SCHO-265). Development builds (and local `expo start`/`expo run:*`, where
`APP_VARIANT` is unset) are `com.gmacko.educateos.dev` ("EducateOS Dev"); preview builds are
`com.gmacko.educateos.preview` ("EducateOS Preview"); only production is `io.educateos.mobile`. The
same value is the iOS bundle ID and the Android package, so the three install side by side. Each
has its own Apple bundle ID (Associated Domains and Push Notifications enabled), ad hoc profile and
EAS Android keystore. A new variant needs the Apple bundle ID with those capabilities, an EAS
keystore, and an entry in the AASA and `sites/educateos-mobile-links/app-links.ts`.

If the Apple ID sign-in is unavailable, EAS can manage iOS credentials with the App Store Connect
API key instead: set `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID` and
`EXPO_APPLE_TEAM_ID`. Set `EXPO_NO_CAPABILITY_SYNC=1` as well when the capabilities are already
configured on the bundle ID: EAS's sync tries to turn Push Notifications off, and Apple rejects that request.
`eas.json` turns off EAS's push-key prompt during builds, because creating an APNs key needs the
Apple ID session. The bundle IDs and profiles already carry the Push Notifications entitlement; add
the key separately with `eas credentials -p ios` when remote push is needed.

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
`eas.json` names the App Store Connect app ("EducateOS", `io.educateos.mobile`, app ID 6828552856,
team P4SWQXAB5H). Upload a production IPA with the App Store Connect API key environment variables
above set:

    eas submit -p ios --profile production --path /tmp/educateos.ipa
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
Apple team ID P4SWQXAB5H and lists every variant's bundle ID (io.educateos.mobile,
com.gmacko.educateos.preview and com.gmacko.educateos.dev). Publish `app-links` as static assets
at mobile.educateos.io, with the `_headers` rules, no Access login and no redirects on the
association file. This host is required independently of QR enrollment. A fresh install may be
needed after publishing because iOS caches domain associations. The Worker serves Android's
assetlinks.json from `sites/educateos-mobile-links/app-links.ts`, with one statement per variant
package listing the SHA-256 of its EAS keystore; add the Play App Signing certificate there once the app is enrolled in Play.

## Connect a phone to a one-origin school

On a computer signed in to the school, choose **Connect phone**. The page shows a QR for
`https://mobile.educateos.io/j#o=<school origin>&r=<room>&s=<secret>`. Scan it in the app (or with the
Camera app), check the school and origin, choose **Connect this phone**, compare the 8-character code
on both screens and approve on the computer. The district seals the device credential to the phone's
key. The relay contract is documented at the top of `src/api/pairing.ts`.

## Connect from a signed-in computer (legacy Workshop pairing)

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
