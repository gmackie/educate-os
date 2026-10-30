# @educateos/provider-fakes

Wire-faithful fakes of the providers EducateOS integrates with (SCHO-201). Each one is built from
the vendor's published API documentation, including its response shapes, paging, authentication,
errors and rate limits. Each is a fetch handler, `(request: Request) => Promise<Response>`, so it
runs in process in tests. The demo districts reach them as a public Worker,
[`sites/educateos-demo-fakes`](../../sites/educateos-demo-fakes/README.md) (SCHO-210).

This package is a library, not a deployable Worker. It has no `wrangler.jsonc`, so release
discovery ignores it.

A run against a fake is not evidence of interoperating with the vendor. See
[maturity.md](../../docs/educateos/maturity.md#provider-fakes).

## The fakes

| Fake | Module | Serves |
| --- | --- | --- |
| `OidcFake` with presets `clever`, `classlink`, `google` | `src/oidc` | Discovery, authorize (code flow with optional PKCE S256), token (`client_secret_basic` or `client_secret_post`), JWKS and userinfo. Preset claims include Clever's `user_type`, `district` and `user_id`, ClassLink's `SourcedId` and tenant, and Google's `hd` and `email_verified`. |
| `CleverDataFake` | `src/clever` | Clever Data API v3.1 at `https://api.clever.com/v3.1`: districts, schools, sections, terms, courses, and users with the `role` filter (student, teacher, staff, district_admin, contact). Also `/events` with `starting_after`/`ending_before`. Bearer district tokens, `links`-based paging, and Clever's 429 rate-limit headers. Records follow Clever's v3.1 OpenAPI spec (a course is `id`, `name`, `number`, `district`); a field the seed has nothing for is left out, or with `nulls: true` the spec's nullable fields, and each role a user does not hold, are `null`, as some districts' data has them. |
| `OneRosterFake` | `src/oneroster` | OneRoster 1.2 Rostering REST with OAuth2 client credentials (the ClassLink profile): orgs, academicSessions, courses, classes, users and enrollments. Supports `limit`/`offset`, `X-Total-Count` and `Link`, `sort`/`orderBy`, the 1.2 `filter` grammar and `fields`. A delta is a `dateLastModified` filter, with deletions served as `tobedeleted`. |
| `GoogleClassroomFake` | `src/google-classroom` | Classroom API v1: courses (with their aliases and free-text sections), teachers, students, courseWork and studentSubmissions, including patching `assignedGrade`/`draftGrade` and `:return`. Paging by `pageToken`, a per-method OAuth scope check, and Google's error bodies (`@ProjectPermissionDenied` for coursework another project created). |
| `LtiPlatformFake` with `canvasFlavour` and `schoologyFlavour` | `src/lti` | An LTI 1.3 platform: OIDC login initiation, signed id_tokens, JWKS, the Advantage token endpoint (the client assertion is checked against the tool's JWKS and jti replay is refused), the Deep Linking response, AGS line items, scores and results, NRPS memberships, and Dynamic Registration (Canvas only). |

All of them extend `Fake` (`src/fake.ts`), which records every request in `requests` and runs the
fault engine.

## Seeds

Every fake serves a caller-supplied `DistrictSeed` (`src/types.ts`). The seed is vendor-neutral:
schools, terms, courses, sections with their teacher and student rosters, people (students,
teachers, staff, administrators, guardians) and, optionally, assignments with submissions. Each fake
projects it into its own wire format. Vendor IDs are derived from seed IDs by hash (`src/ids.ts`),
so they are stable across runs and shared across fakes. A seed person has the same Clever ID in
the Clever SSO and Data API fakes, and the same Google ID in Google sign-in and Classroom. In
OneRoster, sourcedIds are the seed IDs.

A seed person may carry `vendorIds` (`clever`, `google`): vendor user IDs the person already has.
They replace the derived ones everywhere, so a seed adapted from a directory that records them
asserts that directory's subjects. The demo districts adapt this way: `fakeSeed(demo)` in
`@educateos/fixtures` turns any of the six into a `DistrictSeed`, with each fixture's Clever and
Google IDs as `vendorIds` and each IdP subject as the person's `username` (OneRoster `username`,
ClassLink `LoginId`).

`validateSeed` checks references and roles. It also requires every email address, and the
district domain, to be on a reserved `.example` domain. Seeds are synthetic: never use real
people. `SAMPLE_DISTRICT` (`src/sample.ts`) is a small worked example that the contract tests share.

The types in `src/types.ts` are the stable contract that the demo districts (SCHO-202) build on.
Change them only additively.

## Faults

`fake.inject(spec)` adds a fault and returns a function that removes it.

- `outage`: a 5xx (503 by default) with the vendor's error body.
- `rate-limit`: a 429 with `Retry-After` and the vendor's body.
- `network-error`: the fetch rejects with a `TypeError`.
- `malformed-record`: the next list response carries one record broken the way that vendor's data
  goes wrong, for example a OneRoster user in the 1.1 shape, or a Clever id_token without `district`.
- `large-removal`: a `fraction` of the students and their enrollments disappear. They become
  `tobedeleted` in OneRoster and `users.deleted` events in Clever, drop out of NRPS memberships, and
  are refused sign-in.

Each fault can be limited to a number of uses with `times`, and to some requests with
`match: { method, path }`.

```ts
import { OneRosterFake, SAMPLE_DISTRICT } from "@educateos/provider-fakes";

const sis = new OneRosterFake({ seed: SAMPLE_DISTRICT });
sis.inject({ kind: "rate-limit", retryAfterSeconds: 2, times: 1 });
const client = new oneroster.OneRosterRestClient({ fetch: sis.fetch, /* … */ });
```

`routeFetch({ [origin]: fake })` sends one `fetch` to several fakes by origin. It refuses two fakes
on one origin. Clever's SSO userinfo and its Data API both live on `api.clever.com`, so a caller
using both must route that origin by path itself.

`requests` keeps the last 10,000 requests, headers and bodies included, client secrets too. Never
expose it from a deployed fake; a deployed one passes `maxRecordedRequests: 0`.

## Serving them from one host

Every fake can be served below a path, so one host can carry several districts' fakes, and each
takes what a deployment that does not trust its callers needs. All of these are optional, and the
defaults are what the tests have always used:

- `rebasePreset(preset, baseUrl)` moves an OIDC preset under a base URL: the issuer becomes the base,
  and every endpoint keeps its path below it. `OidcFake` also takes a `signingKey`, so a restarted
  fake keeps its JWKS, and a preset may list `acceptedScopes` beyond its discovery document's (Google
  sign-in granting Classroom scopes). `accessGrant(token)` reports what a live token grants.
- `CleverDataFake` takes a `baseUrl` (its `links` and `uri`s carry the base's path and resolve
  against the origin) and a `clientKey`, which gives each caller its own rate-limit budget per token.
- `GoogleClassroomFake` takes a `baseUrl` and a `resolveToken`, which lets it accept another fake's
  tokens (Google sign-in's).
- `OneRosterFake` already took a `baseUrl`, and LTI flavours their origins, which may have paths.
- `LtiPlatformFake` takes `launchLifetimeSeconds` (default 600).

Behaviours a public deployment needed, now the fakes' own: a Dynamic Registration token registers
one tool; launch hints and deep linking `data` are random, and launches and deep linking requests
expire; a Deep Linking response is accepted only at its own course's return URL; tokens and codes of
people a `large-removal` took out stop working at userinfo and the token endpoint; an AGS score
without `scoreGiven` clears the result; LTI service URLs and Clever event cursors are looked up by
index rather than scanned.

## What the clients' runs found

The existing clients run unchanged against the fakes. Their tests are
`educateos-integrations/__tests__/provider-fakes.test.ts`,
`educateos-lti/__tests__/provider-fakes.test.ts` and
`gatekeeper-google/__tests__/classroom-provider-fake.test.ts`. The runs found two behaviours:

- **LTI Dynamic Registration and Canvas.** Canvas returns `deployment_id` at the top level of its
  registration answer, not inside `lti-tool-configuration`. The tool read only the latter until
  SCHO-177 (#132); a test now holds it to Canvas's placement.
- **A OneRoster delta that removes half the students applied in full.** The sync had no
  large-removal hold (maturity.md, IF-11). Since SCHO-203 it is held for an administrator, and the
  test that pinned the old behaviour now pins the hold.

The Clever connector (SCHO-203) was written against these fakes. Its tests are
`educateos-integrations/__tests__/clever.test.ts` and `educateos-identity/__tests__/clever-sso.test.ts`.
`districtSeed(demo)` in `@educateos/fixtures` turns a demo district into a seed for any fake.

## Not modelled, or not verified

Where the vendor's documentation was silent or could not be read, the fake makes a plausible choice.
Each file's header comment cites the documentation it follows.

- **OIDC**
  - Clever: the id_token carries `district` while Clever's discovery document lists `district_id`; userinfo carries both. `user_type: "contact"` for guardians is not documented. PKCE is honoured, though Clever does not document it.
  - ClassLink: only the discovery document was checked. The role values, the userinfo field set and the token lifetimes are guesses.
  - Google: no `picture` and no refresh tokens. Errors use generic RFC 6749 bodies, not Google's exact strings.
  - All presets: signing keys never rotate.
- **Clever Data API**
  - Error bodies are undocumented, so `{"error": "…"}` is assumed. `Retry-After` on an injected 429 comes from the fault engine; Clever documents only `X-RateLimit-*`.
  - The documented paging quirks are not reproduced. Events never expire (Clever keeps them 30 days).
  - Not served: the `school` filter on events, `/me`, `/resources` and LMS Connect.
- **OneRoster**
  - The ClassLink token path (`/token`) comes from district setup guides.
  - Error bodies use the top-level `imsx_StatusInfo` JSON of 1.1 practice.
  - Filters cannot mix `AND` and `OR`. Comparisons are lowercase, not Unicode collation.
  - Nested endpoints other than `classes/{id}/students` and `classes/{id}/teachers` are not served. Neither are demographics (served empty), gradebook or resources.
- **Google Classroom**
  - Not served: `orderBy`, `courseWork.patch` and `delete`, aliases (`d:`, `p:`), guardians, topics and quotas beyond injected faults.
  - There is a single calling Cloud project.
  - Not verified: the ErrorInfo reasons on 401, and the default page size (Google documents none; the fake uses 20).
- **LTI**
  - Schoology's AGS, NRPS and deep-linking paths under `/lti-service/tool/{client_id}/…` come from vendor reports, not Schoology's own documentation.
  - Schoology Dynamic Registration is off: a third-party guide says Schoology supports only manual registration.
  - Canvas's `lti_message_hint` and access tokens are opaque here; in Canvas they are signed JWTs.
  - Not implemented: Canvas variable substitution, NRPS `rlid` and `differences`, and the single-result GET.
  - A score without `scoreGiven` clears the result, as Canvas's scores controller reads; not verified against a live Canvas.
