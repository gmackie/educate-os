# LTI 1.3 broker (I01)

`@schoolos/lti` (`packages/schoolos-lti`) lets an LMS such as Canvas launch into SchoolOS. A launch
proves only who the platform says the user is and which course they came from. The broker turns
that into a district principal and an offering, and nothing more: what the principal may do there
is decided by policy from directory roles (ADR-0003, ADR-0005). The platform's role, name and email
claims are never read.

## Flow

```text
LMS ──login initiation──▶ /lti/login     refuse unregistered issuer/client/deployment;
                                         store state+nonce single-use (10 min); set browser cookie
    ◀──302 to platform auth endpoint──
LMS ──form post id_token+state──▶ /lti/launch
                                         require the state cookie; consume the state;
                                         verify RS256 against the platform JWKS; iss, aud (+azp),
                                         exp/iat/nbf with 60 s skew, iat at most 10 min old;
                                         nonce, deployment, target link, message type, version 1.3.0;
                                         LTI context → offering (registration rules; unknown → 403);
                                         (district, iss, sub) → principal (@schoolos/identity)
    ◀──host's response (resource link) or content picker (deep linking)──
picker ──session + activity…──▶ /lti/deep-link
                                         consume the session; host authorizes the selection;
                                         record activity links; sign LtiDeepLinkingResponse
    ◀──auto-posting form to deep_link_return_url──
LMS ──▶ /lti/jwks                        tool public keys (signing + retired)
```

A launch resolves to `ResolvedLaunch { principal, offeringId, activity?, messageType }`.

## Registrations

A `PlatformRegistration` is owned by one district and identified by `(issuer, clientId)`, because
Canvas Cloud uses one issuer (`https://canvas.instructure.com`) for every customer. It lists the
deployment IDs launches may come through, the platform's endpoints, the LTI contexts it maps to
offerings, and the links it maps to activities. The district must also list the platform issuer in
`trustedIssuers`, and each person must hold an identity link `(district, issuer, sub)`.

An activity is selected only by an explicit link in the registration, matched inside the launch's
offering:

- an administrator maps a platform `resource_link.id`, or
- Deep Linking records one: the content item carries an opaque `schoolos_link` custom parameter,
  never an activity ID. A link copied into another course resolves to no activity there.

## Canvas setup

1. In Canvas, **Admin → Developer Keys → + Developer Key → LTI Key**, choose **Paste JSON** and
   paste the output of `canvasDeveloperKey(ltiToolEndpoints("https://<district host>"))`. The
   exact JSON for `https://schoolos.example` is
   [`packages/schoolos-lti/__tests__/fixtures/canvas-developer-key.json`](../../packages/schoolos-lti/__tests__/fixtures/canvas-developer-key.json).
   It requests privacy level `anonymous` (Canvas sends `sub` but no name or email) and no LTI
   Advantage scopes (AGS and NRPS arrive with I02).
2. Set **Redirect URIs** to `https://<district host>/lti/launch`, save, and turn the key **On**.
   The key's client ID becomes the registration's `clientId`.
3. Install it as an app in the account or course (**Settings → Apps → + App → By Client ID**). The
   deployment ID Canvas shows becomes one of the registration's `deploymentIds`.
4. Register the platform with Canvas Cloud's endpoints: issuer `https://canvas.instructure.com`,
   auth login `https://sso.canvaslms.com/api/lti/authorize_redirect`, token
   `https://sso.canvaslms.com/login/oauth2/token`, JWKS
   `https://sso.canvaslms.com/api/lti/security/jwks`. Beta and test instances use their own
   issuer and hosts.

| Placement | Message | What it does |
| --- | --- | --- |
| `course_navigation` | `LtiResourceLinkRequest` | A course tab that opens the offering. |
| `link_selection` | `LtiDeepLinkingRequest` | Adds an activity to a module. |
| `assignment_selection` | `LtiDeepLinkingRequest` | Makes an activity an assignment's external tool (one item). |
| `editor_button` | `LtiDeepLinkingRequest` | Embeds an activity from the rich content editor. |

The claims Canvas sends for each placement are in
`packages/schoolos-lti/__tests__/fixtures/canvas-placements.ts`, and every placement is launched
through the broker in `canvas.test.ts`.

## Keys

- **Platform keys** are fetched with an injected `fetch`, cached for 10 minutes, and refetched at
  most every 30 seconds when a token names an unknown `kid`, so a platform's rotation takes effect
  at once and a withdrawn key stops verifying within the cache lifetime. Keys under 2048 bits are
  ignored.
- **Tool keys** are RS256 key pairs stored as private JWKs (`generateToolKey`, `importToolKey`).
  `rotateToolKeys` switches signing to a new key and keeps the previous public key published, so
  platforms can still verify a response signed just before the rotation.

## Deployment requirements

- The state, nonce and deep linking session stores must take values atomically
  (`SingleUseStore.take`): a Durable Object or a `DELETE … RETURNING` row, not eventually consistent
  KV. The in-memory stores are for tests and a single isolate.
- `/lti/launch` requires the `__Host-lti-state-<state>` cookie set by `/lti/login`, which stops an
  attacker from signing a victim's browser into the attacker's account. It is `SameSite=None;
  Partitioned` so it works in the Canvas iframe in browsers with partitioned cookies. Browsers that
  block third-party cookies outright will refuse launches in an iframe until the LTI client-side
  storage fallback lands; until then, place the tool to open in a new window there.
