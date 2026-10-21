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
   It requests privacy level `anonymous` (Canvas sends `sub` but no name or email) and the LTI
   Advantage scopes for AGS (line items, results, scores) and NRPS (context membership).
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

# LTI Advantage services and grade passback (I02)

`@schoolos/lti` also speaks to a platform's Assignment and Grade Services (AGS 2.0) and Names and
Role Provisioning Services (NRPS 2.0), and routes official grades to whichever system the district
made their source of record. A Google Classroom adapter shell sits behind the same routing.

## Where the service URLs come from

A launch from a course whose platform offers AGS or NRPS carries their claims. The broker reports
them on `ResolvedLaunch.services` as `LtiContextServices { registration, contextId, ags?, nrps? }`
and the host records them for the offering. A malformed service claim is dropped (the launch still
works; the service is just not offered). Nothing is called during a launch.

## Service tokens

`LtiServiceClient` gets OAuth 2 client credentials tokens from the registration's `authTokenUrl`
with a JWT client assertion (`iss` = `sub` = client ID, `aud` = token URL, a `jti`, five minutes'
life) signed by the tool's current signing key, the key the tool JWKS publishes. Each service asks
only for its own scopes (NRPS: `contextmembership.readonly`; AGS: the AGS scopes the context's
claim grants), and tokens are cached per (registration, token URL, scope set) until a minute before
they expire, at most an hour. A token that grants fewer scopes than requested is refused. A 401 from
a service drops the cached token and retries once.

A bearer token is only sent to an https URL with the origin of the service URL the launch reported.
A `Link: rel="next"` or a line item ID pointing anywhere else is refused before any request.

## NRPS: roster projection

`NrpsClient.rosterProjection(services)` follows `Link` `rel="next"` through every page, up to 200
pages and 10,000 members (a roster over either limit, a paging loop, a page for another context, a
duplicated or malformed member are all refused; a partial roster is never returned). It produces a
`RosterProjection`:

```text
{ districtId, offeringId, source: { kind: "lti-nrps", issuer, clientId, contextId }, observedAt,
  members: [{ identity: { districtId, issuer, subject }, status: active|inactive|deleted,
              untrustedPlatformRoles: [...] }] }
```

Names, emails and SIS IDs are dropped unread. Roles are carried only as `untrustedPlatformRoles`:
an LMS calling someone an instructor or administrator grants nothing. The projection is input for
a sync adapter, never a directory write. The adapter (through `@schoolos/academics`' `AcademicSync`,
and only where the district's authority map names this provider for enrollments) finds each
principal by the identity link `(district, issuer, sub)`, skips members with no link, decides
enrollment roles from its own roster source, and marks departed or `deleted` members inactive; it
never deletes a record.

## AGS

`AgsClient` lists, gets and creates line items in a context and reads results. A line item must be
in the context's container (same origin, path under the container's) or be the launching link's own
line item. The `scores` and `results` URLs insert the segment into the path before any query string,
which PlayTrek's `${lineitemUrl}/scores` did not.

Scores are not exported as a call. They are published only by `GradePassback`.

## Grade passback: source of record and teacher approval

Each offering has a `GradeRoute`, set by an administrator; there is no default:

| `authority` | Route | What passback does |
| --- | --- | --- |
| `local` | none | Refused (`conflict`). SchoolOS keeps the gradebook; nothing is sent anywhere. |
| `lms:<platform>` | `via: "lti-ags"`, the context's services | Publishes approved grades through AGS. |
| `lms:<platform>` | `via: "google-classroom"`, a course ID | Publishes approved grades through `ClassroomProvider`. |

`GradePassback.publish({ offeringId, studentId, column, gradeVersion, scoreGiven, scoreMaximum })`
publishes only if all of these hold (threat T10, "no surprise gradebook writes"):

1. The offering's route names an LMS. No route, or `local`, is refused.
2. A `TeacherGradeApproval` exists in the trusted approval store for exactly that offering, student,
   column and version, with exactly that score and maximum. An AI-suggested score with no approval
   is a `policy-violation`; so is a score that differs from the approved one. Callers cannot pass an
   approval in; the core classroom service records them from a teacher's own action.
3. The approver is a staff principal actively teaching or co-teaching the offering, and the student
   is actively enrolled, in the directory as it is read at passback time.
4. The column belongs to the route's course, and the student has an identity link on the platform.
5. The passback ledger has not recorded this version or a newer one for (column, student). A retry
   returns `already-posted` and sends nothing; an older version, or a newer version whose approval
   is not later than the recorded one, is `conflict`. A failed send releases its claim so a retry
   can send it.

The AGS score is `activityProgress: "Completed"`, `gradingProgress: "FullyGraded"`, with the
approval time as `timestamp`, so a retry carries the same timestamp and a platform discards an older
score even if two sends race. Progress-only updates are never sent.

**Deployment requirement.** `PassbackLedger.claim` must be atomic per key (a Durable Object or a
single transaction). A claim is a two-minute lease: if the process dies after the platform accepted
a score but before the ledger recorded it, a retry after the lease sends it again with the same
timestamp. The in-memory ledger, approval store and route store are for tests and one isolate.

## Google Classroom adapter shell

`ClassroomProvider` is the seam for Google Classroom (rosters, coursework, `assignedGrade`).
`ClassroomAdapter` reads an offering's course roster as a `RosterProjection` (identities under
`https://accounts.google.com`, Classroom's teacher/student list as untrusted roles) and its
coursework, and only for an offering whose grade route is a Classroom route. `ClassroomGradeSink`
publishes through the same `GradePassback` gate; a grade approved out of a different maximum than
the coursework's is refused rather than rescaled.

There is no real Google client and nothing in SchoolOS calls Google. The real integration is gated
on verified Google API access (OAuth verification of the Classroom scopes) and Google's partner
terms. Classroom only lets a project grade coursework the same project created, so a real client
will also create the coursework it grades. Tests use an in-memory fake provider.
