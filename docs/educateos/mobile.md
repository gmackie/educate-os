# EducateOS Mobile

## The app (SCHO-254, SCHO-262)

The first-party EducateOS app (`apps/mobile`, Expo) is a native interface to each school's own
district. It is not a central service that stores student records: every request goes to the
district's origin, under `/api/m/*` with the device credential below.

| Capability | Native app | District |
| --- | --- | --- |
| School setup | Checks the school's manifest and saves its HTTPS origin | Publishes the manifest |
| Sign-in | Its own P-256 device key; tokens in SecureStore | Pairing (`/api/pair/*`), device tokens, revocation |
| Learning, review, family | Native screens over `/api/m/*` | Access checks, work, grades, guardian scope |
| AI workspace | Sandboxed WebView | The Workshop at `/ai` |

Credentials live in the device keychain or keystore. AsyncStorage keeps only the chosen schools'
origins, never profiles, student work or grades; cached data is in memory only.

`https://mobile.educateos.io` (`sites/educateos-mobile-links`, deployed by hand) is the app's App
Link host: the Apple and Android association files, the `/j` pairing link, the sign-in callbacks
and a "get the app" page. It also runs the deprecated SCHO-256 pairing relay for one more release;
its README has the removal plan. The callback URLs carry encrypted transfers, so nothing may log
their query strings.

### Checks

The app has its own pnpm workspace and lockfile, outside the root workspace. In `apps/mobile`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec expo install --check
pnpm exec expo export --platform all --output-dir /tmp/mobile-export   # both Hermes bundles
```

ForgeGraph CI runs these in the `mobile` job of `.forgejo/workflows/ci.yml`, with the mobile-links
tests (`pnpm exec vp run -F @educateos/mobile-links test`). The GitHub mirror runs
`.github/workflows/educateos-mobile.yml`.

SDK 58's ExpoModulesJSI needs Swift 6.2 or newer, so native iOS builds need Xcode 26 or newer.
Simulator builds need no signing identity. Source checks and simulator screenshots do not prove a
school rollout: signing, the association files with real certificate fingerprints, store review and
on-device tests of revoked, switched and multi-district users all come before a release.

## Device credentials (SCHO-261)

A phone signs in to its district with a credential the district issues and binds to a key only the
phone holds. The phone never carries a Cloudflare Access session. Every request it makes goes to
`/api/m/*` on the district's origin. Each `/api/m/*` path serves the same route as the matching
`/api/*` path, with the same request and response schemas, and the same policy applies, as the
person the device belongs to. For example, `GET /api/m/me` serves `GET /api/me`, and
`POST /api/m/student/workspaces/personal` serves `POST /api/student/workspaces/personal`.

`/api/m/*` is meant to sit behind an Access bypass once the one-origin cutover lands. The district
Worker therefore enforces device auth itself: one middleware (`serveDeviceApi` in
`packages/educateos-district-app/src/devices.ts`) rejects a request with 401 before any handler
runs unless it carries a valid access token, a valid proof and an active device. Until the cutover,
production `/api/m` stays behind Access as well.

### The device key

- Make a P-256 (ES256) key pair on the device. Keep the private key in SecureStore with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; a later release moves it to the Secure Enclave or StrongBox.
- The district identifies the key by its RFC 7638 JWK thumbprint. Only one active device can hold
  a given key, so make a new key pair each time the phone pairs again.

### Registration

The pairing relay (`/api/pair/*`, see [Pairing v2](#pairing-v2-scho-261)) and the browser sign-in path register a device
for the person who approved it. Both call `registerDevice(principalId, registration)`, which is
`DistrictObject.registerDevice` in the district Worker. The registration is:

```json
{
  "publicJwk": { "kty": "EC", "crv": "P-256", "x": "<43 chars>", "y": "<43 chars>" },
  "label": "Ava's iPhone",
  "platform": "ios",
  "model": "iPhone 16",
  "appVersion": "1.4.0"
}
```

`platform` is one of `ios`, `android`, `web` or `other`. The label can be up to 80 characters, the
model up to 80 and the app version up to 40. The phone receives:

```json
{
  "deviceId": "dev_…",
  "accessToken": "dat1.<claims>.<mac>",
  "accessTokenExpiresAt": "2026-10-28T12:15:00.000Z",
  "refreshToken": "<opaque>",
  "refreshTokenExpiresAt": "2026-11-27T12:00:00.000Z"
}
```

Store the refresh token in SecureStore next to the key. Treat both tokens as opaque.

### Every request

```
Authorization: Device <accessToken>
Device-Proof: <compact JWS>
```

The proof is a compact JWS (`base64url(header).base64url(payload).base64url(signature)`), signed
with the device's private key:

- Header: `{"alg":"ES256","typ":"device-proof+jwt"}`. No other algorithm is accepted.
- Payload:
  - `htm`: the request method, such as `GET`.
  - `htu`: the request path without its query, such as `/api/m/me/notifications`.
  - `iat`: the time now, in seconds since the epoch.
  - `ath`: base64url (no padding) of the SHA-256 of the access token's ASCII bytes.
  - `jti`: a fresh random ID for this proof, 16 to 128 characters (a UUID will do).
- Signature: the 64-byte raw `r || s` ECDSA P-256 / SHA-256 signature (IEEE P1363, which is what
  WebCrypto produces), not DER.

The district checks the proof against the device's registered key. It rejects a proof whose `iat`
is more than 60 seconds away from the district's clock, or whose method, path or token hash don't
match the request. It also rejects a `jti` the device has already used within that window. Make a
new proof for every request, retries included.

### Refreshing

An access token lasts 15 minutes. When a request is refused with `token-expired` (or just before
`accessTokenExpiresAt`), refresh:

```
POST /api/m/token/refresh
Content-Type: application/json
Device-Proof: <proof with htm "POST", htu "/api/m/token/refresh", ath = SHA-256 of the refresh token>

{"refreshToken": "<refresh token>"}
```

The response has the same shape as the registration response. Every refresh rotates the refresh
token, and the new one expires 30 days later, so a phone that is used at least once a month stays
signed in. Replace both stored tokens at once. Presenting a refresh token that has already been
used revokes the device, because only a copy could still hold it. Run refreshes one at a time:
if two concurrent requests both refresh, the second one signs the phone out.

### Errors

A refused request is a 401 with `WWW-Authenticate: Device error="<reason>"` and this body:

```json
{ "code": "unauthenticated", "reason": "token-expired", "message": "…" }
```

| `reason` | What the app does |
| --- | --- |
| `token-expired` | Refresh, then retry once with a new proof. |
| `missing-credentials`, `invalid-token`, `invalid-proof`, `proof-replayed` | A client bug or a clock problem: refresh once; if that fails, sign in again. |
| `device-revoked`, `refresh-token-reused` | Show "This phone was signed out by your school" and forget the tokens and key. |
| `invalid-refresh-token`, `refresh-token-expired` | Sign in again (pair the phone again). |

If the district has no `DEVICE_TOKEN_SECRET`, every `/api/m/*` request is a 503 with
`{"code":"unavailable","reason":"device-auth-unavailable"}`. A route's own errors (403 `forbidden`,
404 `not-found`, 400 `validation-failed`, and so on) are the web API's error bodies, unchanged.

### Revocation and Your devices

Revocation takes effect on the device's next request, because every request checks the registry.

- `GET /api/me/devices` lists the caller's devices, newest first. Each entry has its label,
  platform, model, app version, created, last seen, last country, push on or off, and status. Its
  key and push token are never included.
- `POST /api/me/devices/:deviceId/revoke` signs out one of the caller's own devices. Another
  person's device is `not-found`.
- `POST /api/me/devices/revoke-all` signs out everywhere.

These are web-session routes for the "Your devices" page, and a phone can call them too, under
`/api/m/me/devices…`. When an administrator sets a person inactive or graduated, their devices are
revoked. A device whose person is deactivated some other way, such as a roster sync, is revoked on
its next request. Reactivating the person doesn't bring the old devices back. Administrators and
operators revoke through `DistrictObject.revokeDevice` and `revokePrincipalDevices`; the signed
`/api/ops` API will expose these later.

`last_seen_at` and the last country (from Cloudflare's `CF-IPCountry`) are recorded at most once a
minute per device.

### Push token

`POST /api/m/me/devices/push-token` with `{"token": "ExponentPushToken[…]", "provider": "expo",
"platform": "ios"}` stores the device's Expo push token and answers 204. `DELETE` on the same path
clears it (204). The token must look like `ExponentPushToken[…]` (or `ExpoPushToken[…]`), at most
256 characters, with only letters, digits, `-` and `_` inside the brackets; anything else is a 400
`validation-failed`. The token belongs to the device, not the person, so there is no web-session
route for it. Your devices shows only whether push is on.

### Configuration

`DEVICE_TOKEN_SECRET` is a district Worker secret of at least 32 random characters. The district
uses it to MAC access tokens. Rotating it invalidates every access token, which phones recover from
with a refresh; refresh tokens stay valid. Without the secret, device sign-in is off.

## Pairing v2 (SCHO-261)

A phone gets its device credential by pairing with a signed-in browser on the district's own
origin. The relay is `packages/educateos-district-app/src/pairing.ts`; the app's side is
`apps/mobile/src/api/pairing.ts`. Rooms are kept in the district's Durable Object
(`educateos_pair_rooms`), so a pairing survives the object restarting. Without
`DEVICE_TOKEN_SECRET` every `/api/pair/*` route answers 503 with `reason: "device-auth-unavailable"`,
as `/api/m/*` does.

### Rooms

- A room ID is 16 random bytes and its secret 32, both base64url. The district stores only the
  secret's SHA-256.
- A room waits 2 minutes for a phone, then 2 minutes from the claim for the person's approval, then
  2 minutes from approval for the phone to collect its tokens. It holds one phone and is used once.
- Opening a new room expires the person's earlier open room.
- The phone's endpoints compare the secret in constant time. The fifth wrong secret expires the
  room, and drops any sealed tokens it held.
- Finished rooms are kept for an hour, so a late poll learns what happened, then purged.

### The QR code

```
https://mobile.educateos.io/j#o=<district origin, URL-encoded>&r=<room>&s=<secret>
```

### Browser endpoints

These use the district's web sign-in, resolved exactly as `/api/me` is, and answer only the room's
creator: anyone else gets 404. Without a sign-in they answer 401. A POST whose `Origin` is another
site (or whose `Sec-Fetch-Site` is `cross-site`) is 403. `/api/pair/*` is an Access bypass path
after the one-origin cutover, so Access adds no assertion header there; the district reads the
same assertion from the browser's `CF_Authorization` cookie on these paths only.

| Request | Answer |
|---|---|
| `POST /api/pair/rooms` | 201 `{ room, secret, qr, expiresAt }` |
| `GET /api/pair/rooms/:room/status` | `{ state: "waiting" \| "claimed" \| "approved" \| "denied" \| "expired", code?, device? }`; `code` and `device` once claimed |
| `POST /api/pair/rooms/:room/approve` | 200 `{ deviceId }`; 409 unless a phone has claimed it, 410 once expired or used |
| `POST /api/pair/rooms/:room/deny` | 200 `{ state: "denied" }` |

Approval calls `registerDevice(principalId, { publicJwk, label, platform, model, appVersion })` for
the signed-in person, seals the tokens to the phone's key and keeps the sealed blob in the room. If
the registration fails (for example, the person is no longer active), the room goes back to
`claimed` and the error is returned.

### Phone endpoints

Authenticated only by the room secret. A wrong or missing secret is 403, an unknown room is 404,
and neither says anything about the room.

| Request | Answer |
|---|---|
| `POST /api/pair/rooms/:room/claim` `{ secret, publicJwk, device: { label, platform, model, appVersion } }` | 200 `{ code }`; 409 if a phone already claimed it, 410 once expired, 400 for a key that is not a P-256 point or an invalid device |
| `GET /api/pair/rooms/:room?secret=<secret>` | `{ state: "waiting" \| "approved" \| "denied" \| "expired", sealed? }`; `sealed` once, then 410 |
| `POST /api/pair/self-rooms` `{ publicJwk, device }` | 201 `{ room, secret, code, expiresAt }`; 429 `too-many-rooms` while 100 self-rooms are open |

Poll about every 1.5 seconds.

### The code

Both screens show the same 8 characters: take SHA-256 over the UTF-8 bytes of the room ID followed
by the key's RFC 7638 thumbprint (base64url), and map each of its first 8 bytes, modulo 36, into
`ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`. The district returns it from the claim and the status.

### Sealing

- The district makes an ephemeral P-256 key `epk` for each approval. The ECDH shared secret with
  the phone's `publicJwk` is the X coordinate (32 bytes, what WebCrypto's `deriveBits` returns).
- HKDF-SHA-256 with that as the input key, the UTF-8 bytes of the room ID as the salt and
  `educateos-pair-v2` as the info gives a 32-byte AES-256-GCM key.
- A random 12-byte IV and no additional data. `sealed` is `{ epk: { kty, crv, x, y }, iv, ct }`,
  with `iv` and `ct` (which includes the tag) in base64url.
- The plaintext is JSON: `{ deviceId, accessToken, refreshToken, principalId,
  accessTokenExpiresAt, refreshTokenExpiresAt }`, with the expiries repeated as `accessExpiresAt`
  and `refreshExpiresAt`.

### Signing in without a computer

The school manifest's `mobileApi.max` is 2 when the district serves this.

1. The phone makes a self-room with `POST /api/pair/self-rooms`. The room is already claimed by its
   key.
2. It opens `<origin>/connect-phone?method=<signIn id>&r=<room>&s=<secret>&k=<key thumbprint>` in
   the system browser. The page is behind Access, so the person signs in there.
3. The page checks the room, the secret and that `k` is the claiming key's thumbprint, then asks
   "Approve this phone?" with the code and the device's label. It is a small server-rendered page
   with a nonce-based CSP, `Referrer-Policy: no-referrer` and no caching.
4. Approve or Deny posts `{ secret }` to the room's approve or deny endpoint. Holding the secret is
   what lets the signed-in person decide a self-room; they become its creator. The page then sends
   the browser to `https://mobile.educateos.io/j#o=<origin>&r=<room>&s=<secret>`.
5. The phone polls the room as above.
