# EducateOS mobile links (SCHO-256)

Public callback and QR pairing host: https://mobile.educateos.io, owned by account
`c07a7e704db1808e1fff91bed2b1cd49`. Independent of customer/district releases.

- `/.well-known/apple-app-site-association`: real Apple team/bundle identity and exact app paths.
- `/pair`: create a two-minute computer pairing QR. Use the computer's existing Workshop login.
- `/pair-phone` and `/enroll`: HTTPS links open the app, with a custom-scheme button fallback.
- `/j`: the one-origin pairing QR (`/j#o=<school origin>&r=<room>&s=<secret>`, SCHO-262). The room
  lives on the school's own `/api/pair/*`; this host only opens the app (or says how to get it).
- `/oauthredirect`: ordinary app callback fallback, or ciphertext delivery for an approved pairing.
- `/healthz`: liveness.

The phone generates and retains its own ephemeral P-256 private key. It claims a QR using its
phone-only capability. The browser has a separate capability and must compare the displayed
32-bit code, then approve the phone and confirm identity/consent in Workshop. Workshop's existing
single-use handoff encrypts the credential for the phone. The relay holds public school details,
hashed capabilities, the public key/state, and ciphertext for at most two minutes. One claim,
one callback and one retrieval are accepted; successful retrieval deletes the record. Durable
Object alarms delete abandoned data. Creation is limited to ten attempts per IP per five minutes.
Request sizes are bounded. No cookies/CORS or third-party QR service; QR generation is local.
Invocation observability is disabled because callback URLs contain encrypted transfers.

QR possession alone never authorizes the Workshop session transfer. Users must compare the phone
code and approve only a connection they started. Scanning an unsolicited code is unsafe. Android
verified links still require the actual signing-certificate Asset Links file; this host currently
verifies Apple only.

Build and deploy from the repository root:

```sh
pnpm --filter @educateos/mobile-links run build:site
node sites/educateos-mobile-links/generate.ts
pnpm exec wrangler deploy --config sites/educateos-mobile-links/wrangler.jsonc
```

`cloudflare.config.ts` is authoritative; `generate.ts` renders the committed Wrangler config including
account ownership and public-host settings. `pnpm lint` includes its workspace build.
The browser bundle `apps/mobile/app-links/pair.js` is generated and ignored by Git. Build before
deploying; EAS excludes the hosting assets. This Worker has its own Durable Object migration.

Tests:

```sh
pnpm --filter @educateos/mobile-links run test:run
node sites/educateos-mobile-links/verify-relay.mjs
```

The integration runner starts a temporary real workerd runtime and exercises browser/phone role
separation, approval, actual Workshop backend envelope delivery, replay rejection and single-use
retrieval. Mobile tests separately decrypt the actual backend envelope. No live Google account
or production credential is used by these automated tests.
