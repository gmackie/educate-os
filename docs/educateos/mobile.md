# EducateOS Mobile

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

The pairing relay (`/api/pair/*`, which comes later) and the browser sign-in path register a device
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

### Configuration

`DEVICE_TOKEN_SECRET` is a district Worker secret of at least 32 random characters. The district
uses it to MAC access tokens. Rotating it invalidates every access token, which phones recover from
with a refresh; refresh tokens stay valid. Without the secret, device sign-in is off.
