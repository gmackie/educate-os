# EducateOS Mobile architecture and deployment handoff

The first-party EducateOS app is a native interface for independent school-owned deployments.
It is not a centralized SaaS service storing student records.

## Ownership and authority

| Capability | Native app | School-hosted service |
| --- | --- | --- |
| District setup | Checks and saves HTTPS deployment origins | Owns installation |
| Authentication | Ephemeral P-256 private key, secure local credential | Verifies login, single-use transfer |
| Student learning | Native courses, assignments, documents, inbox | Access checks, stores work and grades |
| Teacher review | Native comments, grade proposal and release UI | Checks staff rights and approval policy |
| Guardian view | Displays authorized child/class projections | Enforces guardian scope |
| Agent workspace | Sandboxed WebView + versioned bridge | Agents, Gadgets, Gatekeepers |
| Alerts | Foreground inbox and unread indication | Event generation; push service is separate |

Credentials live in the device keychain/keystore. AsyncStorage contains only selected school
origins, not profiles, student work or grade records. Cached data is in-memory only.

## Callback ownership

The upstream Cloudflare OS client claims os.cloudflare.app, which cannot be redirected to an
unrelated native build. This fork defaults to mobile.educateos.io and optionally accepts an
alternative canonical HTTPS app origin via server/backend and frontend build configuration.
The target app must prove ownership through AASA and Android Asset Links using real signing IDs.
The callback must never log query strings, since those include an encrypted credential transfer.

## Access separation

Only a valid Cloudflare Access session can authenticate the direct district REST client.
The existing district Worker independently verifies the cf-access-jwt-assertion, issuer and
explicit audience before mapping the signed-in user to a principal. A Workshop password token
does not grant district REST access. Agent authorizations, teaching approvals and Hall Monitor
policies remain server-side.

## Deployment readiness is separate

This PR implements mobile UI and adapter/source code. The EAS handoff agent is responsible for
on-device authentication tests,
native app signing, callback-domain deployment, release/distribution, icons and splash,
privacy/store review, and any approved native push notification backend.

Do not mistake JS compilation or a WebView simulator screenshot for a successful school rollout.
Verify revoked users, switched users, multi-district profiles, role-scoped access, storage on
device lock, sign-out data removal, and real grade-approval policy before release.

## Development verification (SCHO-254)

Mobile dependencies live in their own pnpm workspace under `apps/mobile`; run
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and
`pnpm exec expo install --check` there. `pnpm exec expo export --platform all` checks
both Hermes bundles. The handoff tests exercise the real backend WebCrypto encryptor
against the native decryptor, plus state substitution, expiry and tampering.

SDK 58's ExpoModulesJSI requires Swift 6.2 or newer: Xcode 16.4 cannot build it.
Use Xcode 26 or newer for native iOS builds. Simulator builds need no signing identity.
The callback origin must have working DNS, HTTPS and verified platform association
files before testing sign-in; source and simulator checks do not establish that setup.
