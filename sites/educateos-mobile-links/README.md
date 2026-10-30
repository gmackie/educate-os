# EducateOS mobile links (SCHO-256, SCHO-262)

The native app's public App Link host, https://mobile.educateos.io, owned by account
`c07a7e704db1808e1fff91bed2b1cd49`. It is independent of district releases: no district Worker
depends on it, and it holds no school data. The Expo app is `apps/mobile`; the static pages are
served from `apps/mobile/app-links`.

## What it serves

- `/.well-known/apple-app-site-association`: the real Apple team and every variant's bundle ID, the exact app
  paths below, and `webcredentials` for the HTTPS sign-in callback (static file).
- `/.well-known/assetlinks.json`: the Android Digital Asset Links statements (`app-links.ts`), one
  per build variant: `io.educateos.mobile` (store), `com.gmacko.educateos.preview` and
  `com.gmacko.educateos.dev` (SCHO-265), each listing the SHA-256 of the EAS keystore that signs it
  (SCHO-262). After Play App Signing enrollment, add Google's app signing certificate
  too (Play Console > Test and release > App integrity), or store installs fail verification.
- `/j`: the pairing QR (`/j#o=<district origin>&r=<room>&s=<secret>`). The room lives on the
  district's own `/api/pair/*` (pairing v2, docs/educateos/mobile.md); this host only opens the app
  or says how to get it. The district's `/connect-phone` page also returns here.
- `/enroll`: a school setup link (public school addresses only).
- `/oauthredirect` and `/authpopup`: app sign-in callbacks. If the app does not catch them, the
  Worker answers with a plain "return to the app" page and never reflects the callback.
- `/`: "Get the EducateOS app".
- `/healthz`: liveness.

## Deprecated: the SCHO-256 pairing relay

`/pair`, `/pair-phone`, `/pairings*` and the `pair-v1.` callback on `/oauthredirect` are the first
pairing relay (`relay.ts`, its `PhonePairing` Durable Object, `pairing.ts`, `pair-browser.ts`).
Pairing v2 lives on each district at `/api/pair` and does not use this host beyond `/j`.

The relay is kept for one release only, because installed builds from before SCHO-262 still
scan `/pair-phone` codes and claim them here. Removal plan:

1. Now: pairing v2 is the path for every school with a v2 district. The current app still accepts
   `/pair-phone` codes (`app/legacy-pair.tsx`) for schools that are not there yet.
2. Once the first store build with pairing v2 has shipped and the districts serve `/api/pair`,
   remove `/pair` and `pair-browser.ts` (the `qrcode` and `esbuild` dependencies with them),
   `/pairings*`, the `pair-v1.` callback and `app/legacy-pair.tsx`.
3. Then delete the `PhonePairing` class with a `deleted_classes` migration (do not just drop the
   binding: the Worker owns the Durable Object), and drop `/pair-phone` from the AASA, the Android
   intent filter and `_headers`.

How it works, while it lasts: the phone generates and keeps its own ephemeral P-256 private key and
claims a QR with its phone-only capability. The browser has a separate capability and must compare
the displayed 32-bit code, then approve the phone and confirm identity and consent in Workshop.
Workshop's single-use handoff encrypts the credential for the phone. The relay holds public school
details, hashed capabilities, the public key and state, and ciphertext for at most two minutes.
One claim, one callback and one retrieval are accepted; a successful retrieval deletes the
record. Durable Object alarms delete abandoned data. Creation is limited to ten attempts per IP per
five minutes, and request sizes are bounded. No cookies, CORS or third-party QR service. Invocation
observability is off because callback URLs carry encrypted transfers. QR possession alone never
authorizes the session transfer.

## Build and deploy

Deployed by hand with Wrangler; it is not part of any release or production automation.

```sh
pnpm --filter @educateos/mobile-links run build:site
node sites/educateos-mobile-links/generate.ts
pnpm exec wrangler deploy --config sites/educateos-mobile-links/wrangler.jsonc
```

`cloudflare.config.ts` is authoritative; `generate.ts` renders the committed Wrangler config,
including account ownership and the public host. `pnpm lint` includes the workspace build (type
check, browser bundle, config). The browser bundle `apps/mobile/app-links/pair.js` is generated and
ignored by Git; build before deploying. EAS excludes the hosting assets.

## Tests

```sh
pnpm exec vp run -F @educateos/mobile-links test
```

That runs the unit tests (`pairing.test.ts`, `app-links.test.ts`) and `verify-relay.mjs`, which
starts a temporary local workerd runtime and exercises the relay (browser and phone role
separation, approval, a real Workshop backend envelope, replay rejection, single-use retrieval)
plus the App Link metadata and landing pages. No live account or production credential is used.
