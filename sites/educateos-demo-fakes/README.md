# educateos-demo-fakes

The public provider-fakes Worker (SCHO-210). The six EducateOS demo districts connect to it as if
it were Clever, ClassLink, Google, a OneRoster server, Google Classroom, Canvas and Schoology. It
serves the wire-faithful fakes of [`@educateos/provider-fakes`](../../packages/educateos-provider-fakes/README.md)
at `https://fakes.demo.educateos.io`, one Durable Object per district, with credentials derived
from a Worker secret and an admin surface behind Cloudflare Access.

> **Never register these issuers as Cloudflare Access identity providers** (in the `gmacko` team or
> any other), and never point anything that guards real access at them. The OIDC fakes have no
> sign-in page: `login_hint` signs in whichever synthetic person the caller names, administrators
> included. The Worker refuses to serve while `OIDC_REDIRECT_URIS` names a `*.cloudflareaccess.com`
> callback.

These are fakes. A district working against them proves nothing about the real vendors (see
[maturity.md](../../docs/educateos/maturity.md#provider-fakes)), and every person in them is
synthetic.

## Not part of a district release

The Worker lives in `sites/`, not `packages/`, as `sites/educateos-io` does. Release discovery
(`readDeployablePackages` in `scripts/release/manifest-lib.ts`), the staging and preview config
generator (`scripts/preview/staging-config.ts`), the production config generator
(`scripts/production/production-config.ts`), `pnpm configs:generate`/`configs:check`, the dev
server and `generate-worker-types.ts` all scan `packages/` only. None of them sees this Worker, so it
never ships in a release manifest and no staging or preview deployment deploys it. It is still a
workspace package (`pnpm-workspace.yaml` lists it), so `pnpm build` typechecks it and `pnpm test`
runs its workerd suite. Its `wrangler.jsonc` is hand-written, not generated.

Deploy it on its own: `pnpm exec wrangler deploy` in this directory.

## URL layout

`<origin>/<slug>/<vendor>/…`, where each fake serves its vendor's own paths below its base, so a
client configured with the base works unchanged. A district serves only the fakes its integration
profile uses; any other district, fake or path is a 404. `GET /` lists every base URL.

| District | Fakes |
| --- | --- |
| northfield | `oneroster`, `lti/canvas` |
| riverbend | `oneroster` |
| prairie | none (all local) |
| cedarvalley | `clever`, `google`, `classroom` |
| lakeshore | `classlink`, `oneroster`, `lti/schoology` |
| harbor | `google`, `classroom` |

A district on Google Classroom also gets Google sign-in: its access tokens, when granted Classroom
scopes, are accepted by the Classroom fake, as Google's are by Classroom.

With `B = https://fakes.demo.educateos.io/<slug>`:

| Client | URL |
| --- | --- |
| Clever Data API | API host `B/clever`; requests to `B/clever/v3.1/…`. `links[].uri` and `data[].uri` are absolute paths (`/<slug>/clever/v3.1/users?…`): resolve them against the origin. |
| Clever SSO (OIDC) | issuer `B/clever`, discovery `B/clever/.well-known/openid-configuration`, authorize `B/clever/oauth/authorize`, token `B/clever/oauth/tokens`, JWKS `B/clever/oauth/certs`, userinfo `B/clever/userinfo` |
| ClassLink (OIDC) | issuer `B/classlink`, authorize `/oauth2/v2/auth`, token `/oauth2/v2/token`, JWKS `/oauth2/v2/jwks`, userinfo `/v2/my/profileinfo`, all below `B/classlink` |
| Google (OIDC) | issuer `B/google`, authorize `/o/oauth2/v2/auth`, token `/token`, JWKS `/oauth2/v3/certs`, userinfo `/v1/userinfo`, all below `B/google` |
| OneRoster 1.2 REST | base `B/oneroster`, rostering `B/oneroster/ims/oneroster/rostering/v1p2`, token `B/oneroster/token` (client credentials, Basic or form) |
| Google Classroom | base `B/classroom/v1` (`B/classroom/v1/courses`, …) |
| Canvas LTI 1.3 | issuer `B/lti/canvas`; OIDC auth `B/lti/canvas/api/lti/authorize_redirect` (which redirects to `B/lti/canvas/api/lti/authorize`); token `B/lti/canvas/login/oauth2/token`; JWKS `B/lti/canvas/api/lti/security/jwks`; Dynamic Registration's OpenID configuration `B/lti/canvas/api/lti/security/openid-configuration` and registrations `B/lti/canvas/api/lti/registrations`; AGS and NRPS under `B/lti/canvas/api/lti/courses/<id>/` |
| Schoology LTI 1.3 | issuer `B/lti/schoology`; OIDC auth `B/lti/schoology/lti-service/authorize-redirect`; token `B/lti/schoology/lti-service/access-token`; JWKS `B/lti/schoology/lti-service/.well-known/jwks`; services under `B/lti/schoology/lti-service/tool/<client_id>/` |

Issuers are the base URLs, not the vendors' (`https://clever.com`, …). A client that discovers its
endpoints, or is configured with them, works; one that hard-codes the vendor's issuer does not.

`/healthz` answers `ok` and reads nothing.

## Credentials

Every credential is derived from the secret `FAKES_SECRET`: HMAC-SHA-256 of the secret over
`<slug>:<purpose>`, shaped like the vendor's (`src/credentials.ts`). They are stable across restarts
and deploys, distinct per district, and unguessable from the repository; rotating the secret
rotates them all. They are:

- Clever: the district token of the Data API, and the SSO client ID and secret.
- ClassLink and Google: each OIDC client's ID and secret.
- OneRoster: the client ID and secret, granted `roster-core.readonly`, `roster.readonly` and
  `roster-demographics.readonly`.

OIDC clients accept the redirect URIs in the `OIDC_REDIRECT_URIS` var (comma-separated, exact
match, https, `{slug}` replaced by the district). It defaults to
`https://{slug}.educateos.io/api/sso/callback`, a district-side callback. No district SSO
connector receives codes yet (SCHO-203/204), so that path is a neutral choice: change the var to
the connector's real callback when it exists. The deployed var also lists the demo Workshop's Clever
connector, `https://northfield.educateos.io/gatekeeper/clever/oauth` (SCHO-282), which signs Cedar
Valley's people in against the `clever` fake. A URI that is not https, or whose host is
`cloudflareaccess.com` or below it, makes the Worker answer 503 to every fake and admin request
until it is fixed.

LTI tools are not derived: an operator registers them (admin `lti/<flavour>/tools`), or a tool
registers itself by Dynamic Registration (Canvas) with a token an operator starts. Each gets a
random client ID in the platform's shape. Tools are stored, so they survive restarts.

Read a district's credentials with `GET /_admin/<slug>/credentials`.

## Admin

`/_admin/<slug>/…`, JSON in and out. It sits behind a Cloudflare Access application with a
service-token policy. The Worker also verifies the `Cf-Access-Jwt-Assertion` (RS256 against
`https://gmacko.cloudflareaccess.com/cdn-cgi/access/certs`, issuer
`https://gmacko.cloudflareaccess.com`, audience `ADMIN_ACCESS_AUD`, expiry). With
`ADMIN_ACCESS_AUD` unset every admin request is refused.

| Method and path | Does |
| --- | --- |
| `GET /_admin/<slug>` | The district's fakes, active faults and LTI tools. |
| `GET /_admin/<slug>/credentials` | Every base URL, endpoint and credential an operator needs to configure the district's connectors. |
| `POST /_admin/<slug>/reset` | Rebuilds every fake from the seed: tokens, faults, mutations and large removals are gone. LTI tools are kept; `?registrations=clear` drops them too. |
| `GET /_admin/<slug>/faults` | The faults injected since the last reset. |
| `POST /_admin/<slug>/faults` | Injects a fault. Body: `{ "kind": "outage", "status"?: 503 }`, `{ "kind": "rate-limit", "retryAfterSeconds"?: 30 }`, `{ "kind": "malformed-record" }` or `{ "kind": "large-removal", "fraction": 0.5 }`, each with optional `vendor` (one fake; default all of the district's), `times` and `match: { method?, path? }` (`path` a substring). A large removal changes the data; only a reset undoes it. |
| `DELETE /_admin/<slug>/faults` | Clears every fault. `DELETE /_admin/<slug>/faults/<id>` clears one. |
| `GET`, `POST`, `DELETE /_admin/<slug>/lti/<canvas\|schoology>/tools` | Lists, registers (`{ name?, initiateLoginUri, redirectUris, jwksUri, targetLinkUri?, scopes?, custom?, privacyLevel? }`, https URLs) or clears the platform's tools. |
| `POST /_admin/<slug>/lti/canvas/registrations` | Starts Dynamic Registration of `{ toolRegistrationUrl }`: answers the URL to open, with its `openid_configuration` and a one-hour, single-use `registration_token`. |
| `POST /_admin/<slug>/lti/<flavour>/launches` | Starts a launch: `{ personId, sectionId, clientId?, messageType?, placement?, resourceLinkId?, deploymentId? }` (seed IDs). Answers the tool's login initiation URL to open; the launch expires in 10 minutes. |
| `POST /_admin/<slug>/classroom/tokens` | Mints a Classroom token for `{ personId, scopes? }` (default every Classroom scope). |

## State

One `DemoFakesDistrict` Durable Object per district, named by slug and reached through
`ctx.exports`. It builds the district's fakes on first use from `fakeSeed(demoDistrict(slug))` and
keeps them in memory: tokens, codes, launches, faults, OneRoster or Clever changes and AGS scores.
When the object is evicted or restarts, all of that starts again from the seed. Clients see expired
tokens and refetch, as they would after a vendor's own token revocation.

Two things are stored in the object's SQLite storage, because a configured district would notice
them change: each issuer's and platform's RS256 signing key (so JWKS and `kid`s stay the same) and
each LTI platform's registered tools.

## Hardening

What a public deployment needed beyond the in-process fakes (SCHO-201's review):

- Nothing exposes `requests`, and each fake records none (`maxRecordedRequests: 0`), since it would
  hold client secrets.
- Credentials are secret-derived (above). The fakes' public defaults (the seed-derived Clever token,
  `DEFAULT_ONEROSTER_CLIENT`) are refused.
- Clever's rate limit gives each caller (by IPv4 address or IPv6 /64) its own 1,200-a-minute budget per token, so one
  caller cannot spend a district's budget.
- Request bodies are capped at 64 KiB, declared or streamed (413).
- Each client may make `RATE_LIMIT_PER_MINUTE` (600) requests a minute to one district's fakes,
  counted in the object's memory (429 with `Retry-After`). A client is an IPv4 address or an IPv6
  /64, so one subscriber cannot multiply itself across its prefix. Clever's per-caller budget
  counts the same way. No paid rate-limiting product is used.
- Pending OIDC authorization codes, which anyone knowing a client ID and redirect URI can request,
  are capped at 1,000 per issuer (oldest forgotten), as are LTI launches and deep linking requests.
- A tool's JWKS is fetched at most every five minutes (sooner, once per 30 seconds, when the tool
  signs with a key it lacks).
- Admin assertions must carry `exp`.
- Unknown districts, fakes and paths are 404s.

Fixed in the fakes themselves, with tests, in `@educateos/provider-fakes`: LTI Dynamic Registration
tokens are single-use; tool and section service URLs are indexed rather than scanned; launches
expire; launch hints and deep linking `data` are random rather than derived from a counter and the
clock; a Deep Linking response must come back to its own course's return URL; OIDC tokens and codes
of people a large removal took out stop working; an AGS score without `scoreGiven` clears the result
(as Canvas does, not verified against a live Canvas); Clever `/events` cursors are found by index.

Not hardened:

- **Anyone can sign in as anyone.** The OIDC fakes have no sign-in page: the person is named by
  `login_hint` (a seed ID, email or subject). Whoever can start a district's sign-in can be any of
  its synthetic people, administrators included. That suits a public demo of synthetic districts
  and nothing else: never make one a Cloudflare Access identity provider (see the warning above).
- LTI tools' JWKS URLs are fetched from the Worker. Only an operator, or a tool holding an
  operator-issued registration token, can set one.
- The per-IP limit is per object instance and per minute; it bounds abuse, it does not stop a
  distributed caller.
- Signing keys never rotate.
