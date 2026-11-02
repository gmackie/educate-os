# LTI 1.3 broker (I01)

`@educateos/lti` (`packages/educateos-lti`) lets an LMS such as Canvas launch into EducateOS. A launch
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
                                         (district, iss, sub) → principal (@educateos/identity)
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
Canvas Cloud uses one issuer (`https://canvas.instructure.com`) for every customer. It names the
`provider` the platform is in the district's authority map (`external:canvas`) and grade
authorities (`lms:canvas`), and lists the deployment IDs launches may come through, the platform's
endpoints, the LTI contexts it maps to offerings, and the links it maps to activities (each inside
an offering the registration maps). The district must also list the platform issuer in
`trustedIssuers`, and each person must hold an identity link `(district, issuer, sub)`.

### Dynamic registration

A platform can register itself (LTI Dynamic Registration 1.0) instead of an administrator copying
five URLs, but only by invitation, and only into a waiting room:

1. A district admin asks `LtiAdminService.inviteRegistration` for a URL. It carries a single-use
   invitation that expires in an hour, bound to the district and the admin.
2. The LMS administrator pastes it into the platform, which opens it with its own
   `openid_configuration` and `registration_token`. `GET /lti/register` consumes the invitation,
   reads the platform's configuration, and registers the tool asking only for `iss` and `sub` (and
   Canvas's `anonymous` privacy level). Every URL must be https, redirects are never followed, and a
   platform's error body is never repeated.
3. The result is a `PendingPlatformRegistration`, kept apart from registrations; the broker never
   reads it, so it cannot start a login. The platform must return a non-empty client ID, or nothing
   is recorded. A deployment ID is taken from the tool configuration (the specification's place)
   or the top level of the answer (Canvas's). Canvas returns none unless its in-development
   `lti_registrations_next` flag is on: it creates the deployment when the tool is installed.
4. A district admin approves it with `approveRegistration(id, { provider, offerings, activityLinks,
   deploymentIds })`, or rejects it. `deploymentIds` adds the deployments the platform shows once
   the tool is installed; an approval that leaves the registration with no deployment is refused. Only then is it saved as a `PlatformRegistration`, after the directory checks:
   the issuer must be trusted and every mapped offering and linked activity must exist.

PlayTrek's version of this endpoint was first open to anyone and later guarded by one
operator-wide secret, stored the platform immediately with a `pending` flag the launch route had to
remember to check, and accepted a missing deployment ID as `""`.

An activity is selected only by an explicit link in the registration, matched inside the launch's
offering:

- an administrator maps a platform `resource_link.id`, or
- Deep Linking records one: the content item carries an opaque `educateos_link` custom parameter,
  never an activity ID. A link copied into another course resolves to no activity there.

## Canvas setup

The Tool has passed a live run against current Canvas (2026-10-26): Dynamic Registration, teacher
and student launches, Deep Linking, NRPS, an AGS line item, teacher-approved passback into the
Canvas gradebook, refused replays and forged launches, and tool key rotation. The results, request
IDs and deviations are in [integrations/canvas-lti.md](integrations/canvas-lti.md). Dynamic
Registration is the preferred setup; the developer key JSON below is the manual alternative, which
that run did not exercise.

1. In Canvas, **Admin → Developer Keys → + Developer Key → LTI Key**, choose **Paste JSON** and
   paste the output of `canvasDeveloperKey(ltiToolEndpoints("https://<district host>"))`. The
   exact JSON for `https://educateos.example` is
   [`packages/educateos-lti/__tests__/fixtures/canvas-developer-key.json`](../../packages/educateos-lti/__tests__/fixtures/canvas-developer-key.json).
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
`packages/educateos-lti/__tests__/fixtures/canvas-placements.ts`, and every placement is launched
through the broker in `canvas.test.ts`.

Dynamic Registration names each message's placements. Canvas gives a message without placements
`link_selection` and keeps the first message per placement, so a resource link message with none
would take `link_selection` from Deep Linking (SCHO-240).

## Moodle setup

The Tool has also passed a live run against Moodle 4.5 (2026-10-26), recorded in
[integrations/moodle-lti.md](integrations/moodle-lti.md). Moodle's own Dynamic Registration is the
setup:

1. A district administrator creates an invitation (`POST /api/lti/invitations`).
2. In Moodle, **Site administration → Plugins → Activity modules → External tool → Manage tools**,
   paste the invitation URL into **Tool URL** and choose **Add LTI Advantage**. Moodle registers
   and lists the tool as Pending; choose **Activate**.
3. The district administrator trusts the issuer (Moodle's `wwwroot`) and approves the pending
   registration with provider `moodle` and the course mappings. Moodle's context ID is the course
   ID, and Moodle returns the deployment ID at registration, so the approval does not need one.
4. Teachers add the tool from the activity chooser; **Select content** opens the EducateOS picker
   (Deep Linking).

## Keys

- **Platform keys** are fetched with an injected `fetch`, cached for 10 minutes, and refetched at
  most every 30 seconds when a token names an unknown `kid`, so a platform's rotation takes effect
  at once and a withdrawn key stops verifying within the cache lifetime. Keys under 2048 bits are
  ignored.
- **Tool keys** are RS256 key pairs stored as private JWKs (`generateToolKey`, `importToolKey`).
  `rotateToolKeys` switches signing to a new key and keeps the previous public key published, so
  platforms can still verify a response signed just before the rotation. In a district Worker they
  are kept by `TableToolKeyStore` (`@educateos/lti-district`) in the district's Durable Object: the
  private JWKs never leave that storage, and `rotate()` retires the signing key and keeps one
  retired key published by default.

## Deployment requirements

- The state, nonce and deep linking session stores must take values atomically
  (`SingleUseStore.take`): a Durable Object or a `DELETE … RETURNING` row, not eventually consistent
  KV. The in-memory stores are for tests and a single isolate.
- `/lti/launch` requires proof that it is posted by the browser that started the login, which
  stops an attacker from signing a victim's browser into the attacker's account (login CSRF). The
  proof is the `__Host-lti-state-<state>` cookie set by `/lti/login` (`SameSite=None;
  Partitioned`, so it works in the Canvas iframe where cookies are partitioned) or, where cookies
  are blocked outright, the platform storage fallback below.

## Blocked cookies: the platform storage fallback

When login initiation carries `lti_storage_target` (Canvas sends `post_message_forwarding`), the
platform offers client-side storage over `postMessage` (1EdTech "LTI Client Side postMessages").
The broker then binds the launch to the browser through it:

```text
/lti/login    state + nonce + a fresh secret; the login state keeps only SHA-256(secret)
   ◀── page: lti.put_data {key: educateos_lti_<state>, value: secret} to the platform frame,
             then follow the OIDC redirect (also sets the state cookie, in case it works)
/lti/launch   platform's form post, no cookie, lti_storage_target present: nothing is consumed
   ◀── page: lti.get_data {key} from the platform frame, then re-post the launch with the value
/lti/launch   re-post with lti_storage_value, Origin = the tool: the state is consumed and the
              value's digest must match the login's
```

- The platform keeps that storage per tool origin, in that browser. A secret put during an
  attacker's login is in the attacker's browser, not the victim's.
- The attacker does know their own secret, so a value counts only on a post whose `Origin` is the
  tool's own (and `Sec-Fetch-Site`, when sent, is `same-origin`): only the tool's page can make
  that post, and a browser cannot forge `Origin`. The page therefore uses
  `Referrer-Policy: same-origin`, because `no-referrer` would make the browser send `Origin: null`.
- Messages go only to, and replies are read only from, the origin of the registration's OIDC
  endpoint (`authLoginUrl`), from the target frame, for the request's message ID and key.
- The page script is a fixed string admitted by its CSP hash (`PLATFORM_STORAGE_SCRIPT_HASH`;
  a test recomputes it). Each page passes its settings in a JSON `<script type="application/json">`
  element, escaped so nothing in it can close the element.
- If the platform does not answer within five seconds, the login page follows the redirect anyway
  (the cookie may still work) and the launch page asks the person to open the tool in a new window.
- A wrong secret burns the state, as any failed launch does.
- Passed live (SCHO-240): in WebKit, which blocks the third-party state cookie, a Canvas launch
  completed through Canvas's `post_message_forwarding` storage, with the re-post from the tool's
  own origin ([evidence](integrations/canvas-lti.md#follow-up-checks-scho-240)). Chromium keeps the
  `Partitioned` cookie even with third-party cookies blocked, so it takes the cookie path.

# LTI Advantage services and grade passback (I02)

`@educateos/lti` also speaks to a platform's Assignment and Grade Services (AGS 2.0) and Names and
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
a sync adapter, never a directory write. The adapter (through `@educateos/academics`' `AcademicSync`,
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
| `local` | none | Refused (`conflict`). EducateOS keeps the gradebook; nothing is sent anywhere. |
| `lms:<platform>` | `via: "lti-ags"`, the context's services | Publishes approved grades through AGS. |
| `lms:<platform>` | `via: "google-classroom"`, a course ID | Publishes approved grades through `ClassroomProvider`. |
| `lms:<platform>` | `via: "clever-lms-connect"`, a Clever district and section ID, optional column-to-assignment map | Publishes approved grades through Clever LMS Connect (built to the spec, not tested against Clever). |

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
timestamp. The in-memory ledger, approval store and route store are for tests and one isolate;
`@educateos/lti-district` provides the durable ones (below).

## Google Classroom adapter shell

`ClassroomProvider` is the seam for Google Classroom (rosters, coursework, `assignedGrade`).
`ClassroomAdapter` reads an offering's course roster as a `RosterProjection` (identities under
`https://accounts.google.com`, Classroom's teacher/student list as untrusted roles) and its
coursework, and only for an offering whose grade route is a Classroom route. `ClassroomGradeSink`
publishes through the same `GradePassback` gate; a grade approved out of a different maximum than
the coursework's is refused rather than rescaled.

There is no real Google client and nothing in EducateOS calls Google. The real integration is gated
on verified Google API access (OAuth verification of the Classroom scopes) and Google's partner
terms. Classroom only lets a project grade coursework the same project created, so a real client
will also create the coursework it grades. Tests use an in-memory fake provider.

## Clever LMS Connect (SCHO-278)

**Built to Clever's published API v3.1 spec only; not tested against Clever.** LMS Connect needs a
Clever Complete agreement, which EducateOS does not have. The sources are the OpenAPI file
(github.com/Clever/swagger-api, `full-v3.yml`, version 3.1.0) and the
[LMS Connect quickstart](https://dev.clever.com/docs/clever-lms-connect). The tests run against
`CleverDataFake` in `@educateos/provider-fakes`, which follows the same spec.

LMS Connect writes into the district LMS (Classroom, Canvas, Schoology) behind a Clever section.
`CleverLmsConnectClient` calls `GET /sections/{id}`, `POST /sections/{id}/assignments`,
`GET /sections/{id}/assignments/{assignment_id}` and
`PATCH /sections/{id}/assignments/{assignment_id}/submissions/{user_id}` with the district-app
token of the route's Clever district. `CleverLmsConnectAdapter` creates points assignments for an
offering whose route is a Clever route. `CleverLmsConnectGradeSink` publishes through
`GradePassback`:

- A column is the Clever assignment the route's `assignments` maps it to, or the assignment with the
  column as its ID. It must be in the route's section, out of `points`, with `points_possible` equal
  to the approved maximum. Anything else is refused, not rescaled.
- The student is found by their identity link under `https://clever.com` (the issuer Clever SSO and
  the Clever roster import share, the subject being the Clever user ID), and must be a student on
  the section's Clever roster. The section must belong to the route's district.
- The grade is `grade_points`, the comment is `grade_comment`. The submission `state` is not
  changed: returning work stays the teacher's action, as with Classroom. Re-sending the same points
  leaves the same grade.
- Clever errors become `EducateOsError`s: 400 `validation-failed`, 401 and 403 `forbidden`, 404
  `not-found` (or `forbidden` for an assignment outside the section), anything else `unavailable`.

# Platform tools and deployments (SCHO-179, IF-10)

When EducateOS is the LTI **Platform**, hosting third-party tools (RFC 0002 §5 and §7), a district
administrator registers each tool and deploys it to specific offerings. The schemas are in
`@educateos/lti` (`platform-tools.ts`); the store and the administrator's service are in
`@educateos/lti-district` (`platform-tools.ts`). Harness-tested only; no real tool has used them.
The district Worker serves them to administrators under `/api/lti/` when the platform is on (see
[Platform tools in the district Worker](#platform-tools-in-the-district-worker)).

- **A tool** (`PlatformTool`) is registered with its name, OIDC login initiation URL, redirect URIs,
  default target link URI and JWKS URL. Every URL is https on the login initiation URL's origin,
  the tool's trusted host, and redirect URIs are matched exactly (`redirectUriAllowed`). EducateOS
  assigns the tool's ID (`ltt_…`), which is its `client_id`; a tool never chooses it.
- **A deployment** (`PlatformDeployment`, `ltd_…`, the launch's `deployment_id`) names the only
  offerings the tool may launch in, and turns on each LTI Advantage service on its own: NRPS,
  AGS line items, AGS scores and Deep Linking. All are off unless asked, and so are the person's
  name and email (`privacy`): by default a tool learns an opaque subject and a role, nothing more.
- `deploymentAllows(tool, deployment, offering, service?)` is the check every later launch and
  service call starts with: both active, same district, an offering the deployment names, and the
  service, if one is named, turned on.

`TablePlatformToolStore` keeps them in the district's record table (`lti.platform-tool`,
`lti.platform-deployment`). A deployment is stored only while its tool is active and cannot move
to another tool; a revoked deployment stays revoked; revoking a tool revokes every deployment of it
in the same atomic step. Nothing is deleted, so a revoked record remains the record of what the tool
was allowed.

`LtiPlatformToolService` decides every call with the policy engine: registering, deploying,
changing and revoking need `update` on the district, and listing needs `read`, which by the default
rules only a district admin has. A refusal is `forbidden` and is in the policy audit trail; each
record also keeps who changed it last, and when. A deployment naming an offering that is not the
district's is refused as `validation-failed`.

## Platform launches

A deployed tool is launched from EducateOS in two halves (`platform-launch.ts` in both packages),
following the OIDC third-party-initiated login of LTI Core 1.3 §5.1.1 and the LTI Security
Framework 1.0 §5.1.1. Harness-tested only, against the tool fake (`FakeLtiTool` in
`@educateos/provider-fakes`); the district Worker serves it when the platform is on (see
[Platform launches in the district Worker](#platform-launches-in-the-district-worker)).

1. **Start.** `LtiPlatformLaunchService.start` takes a signed-in caller, a deployment and an
   offering. The policy engine must allow the caller to `read` the offering, the caller must hold an
   active enrollment there, and the deployment and its tool must be active and name the offering
   (`deploymentAllows`); every refusal is `forbidden`, alike. It stores a single-use launch ticket
   (`lti.platform-launch-ticket`, five minutes) under a random key that becomes the
   `lti_message_hint`, holding the SHA-256 of a second random value, the browser binding, which the
   Worker will keep in a cookie. It returns the tool's login initiation URL with `iss` (the
   district's origin, `LTI_TOOL_ORIGIN`), `login_hint`, `lti_message_hint`, `target_link_uri`,
   `client_id` and `lti_deployment_id`.
2. **Authorize.** `LtiPlatformLaunchService.authorize` answers the tool's authentication request.
   `scope`, `response_type`, `response_mode` and `prompt` must be `openid`, `id_token`, `form_post`
   and `none`, and `nonce` is required (`PlatformAuthRequest`), or it is `validation-failed`. The
   ticket is taken first, so it is used up by the first attempt, valid or not. Then the browser
   binding must match, `client_id` must be the ticket's tool, `login_hint` the ticket's subject,
   `redirect_uri` exactly a registered one, and the tool and deployment must still allow the
   offering; otherwise it is `forbidden` and nothing is posted to the tool. The answer is a form
   for the browser to post to `redirect_uri`: the id_token and the tool's `state`.

The id_token is RS256-signed with the platform key (its `kid` in the header), with `iss` the
district's origin, `aud` and `azp` the tool's client ID, a five-minute `exp`, and the tool's
`nonce`. Its `sub` is the person's subject for that tool (`TablePlatformSubjectStore`,
`lti.platform-subject`): a random value made on their first launch of the tool and kept, so two
tools cannot match people by it, and a later service call naming a `sub` can be traced back. It
carries `LtiResourceLinkRequest`, version `1.3.0`, the `deployment_id`, the `target_link_uri`, a
resource link per deployment and offering, the LIS role (`Instructor` for a teacher or co-teacher,
`Learner` for a student) and the offering as the only context (its ID, the course title as label,
and course and section as title). `name`, `given_name` and `family_name` are added only when the
deployment allows the name, and `email` only when it allows the email.

Tests: a student's and a teacher's launch verified by the tool fake; a stable per-tool subject that
differs between tools; name and email only as allowed; refusals for a teacher of another offering,
an administrator who is not enrolled, an offering without the deployment, an inactive enrollment,
an unknown or revoked deployment; a ticket redeemed once and only with its browser binding; an
unregistered redirect URI, another tool's client ID, another subject and malformed requests
refused; an expired ticket and a tool revoked mid-launch refused; and, in workerd, a ticket redeemed
by exactly one of 50 concurrent requests, tickets kept across restarts until they expire, and one
subject per person and tool under concurrent launches, kept across restarts.

# District wiring (SCHO-60, SCHO-76)

`@educateos/lti-district` (`packages/educateos-lti-district`) is what a district Worker hosts around
the broker. The district Worker mounts it (SCHO-177; see [The district Worker's Tool](#the-district-workers-tool)).

## Durable stores

Every store is written once over a `RecordTable`: synchronous keyed JSON records in named
collections, with `atomically(step)` for read-decide-write steps that have no `await` inside. In the
district Worker the table is `DurableObjectRecordTable` (`@educateos/lti-district/durable-object`),
one SQLite table in the district's Durable Object; `InMemoryRecordTable` is for tests.

| Store | What makes it safe |
| --- | --- |
| `TableSingleUseStore` (login states, deep linking sessions, registration invitations) | `take` is one `DELETE … RETURNING`; of 50 concurrent takes one gets the value. Expired rows are purged on `put`. |
| `TableRegistrationStore` | `save` and `addActivityLink` check the directory first (`directoryRegistrationTargets`): trusted issuer, existing offerings, activities installed in the link's offering. Links are appended in one atomic step, so concurrent deep links never overwrite each other. |
| `TablePendingRegistrationStore` | Separate from registrations; the broker never reads it. |
| `TablePassbackLedger` | `claim` runs the shared `decidePassbackClaim` rule and records it atomically. |
| `TableContextServicesStore` | Keeps the newest services per (offering, platform context); an older launch cannot bring back replaced URLs. |
| `TableGradeRouteStore`, `TableGradeColumnStore` | A column bound to one assignment cannot be moved to another. |
| `TableRosterSourceStore` | A projection no newer than the last applied is refused. |
| `TableToolKeyStore` (SCHO-177) | One record holds the whole key set, so a rotation is one write. The first read generates the key; of racing first reads, the key stored first wins, so every isolate signs with the same key. |
| `TablePlatformServiceTokenStore` (SCHO-179) | A client assertion's `jti` is checked and recorded in one atomic step, after purging expired ones, so of 50 concurrent redemptions one wins; access tokens are kept by digest only, and an expired one never verifies. |

A stored record that does not match its schema is an error (`LtiStoredRecordError`), never a
default. The workerd suite (`__tests__/workerd/`) runs the stores against real Durable Object
SQLite, concurrent requests to one object and restarts.

## Rosters

`LtiRosterSync.apply(projection)` applies an NRPS `RosterProjection` through `AcademicSync`, only
where the authority map names the registration's `provider` for enrollments. Members are found by
identity link; roles come from the district (`districtRosterRoles`: an existing enrollment, a
roster role assignment at the offering, or `student` for a student principal), so a staff member the
district has not placed in the offering is held back. An enrollment is active only while the
platform lists the member as active and the principal's own `status` is `active`. Every enrollment
the roster writes gets a contracts `SourceLink` (system = provider, `sourcedId` = the platform
subject); one the roster later drops, or lists as inactive or deleted, becomes inactive. Nothing is
deleted, and a principal's own status is never changed by one course's roster. An enrollment that
existed before the first sync is adopted by the source once the roster lists it.

## Approvals and grade routes

`OfficialGradeApprovals` is the passback gate's approval store: a column is bound to an E01
assignment (`bindGradeColumn`), and the approval is that assignment's `OfficialGradeVersion` for the
student and version, read from the assessment records at passback time.

`recordLaunchServices` (called from the launch callbacks) records `LtiContextServices` per
offering. `LtiAdminService.routeGradesToPlatform` builds an `LtiGradeRoute`
(`authority: lms:<provider>`) from them, for a context the registration maps to the offering and
that offers AGS; `keepGradesLocal` sets a local route.

## Authorization

`LtiAdminService` decides every call with the policy engine: registrations (invite, list, approve,
reject) need `update` (or `read`) on the district, which the default rules give a district admin;
grade routes, columns and the services list need `update` on the offering (a district admin, or a
school admin in their school). `policySelectActivities` is the handler's `selectActivities`: each
chosen activity must be installed in the launch's offering, and the principal must be allowed to
`assign` it there. `districtPrincipalResolver` resolves launches against the directory as it is at
each launch.

## The district Worker's Tool (SCHO-177)

`@educateos/district-worker` serves the Tool when its `LTI_TOOL_ORIGIN` var names the district's
public https origin. Production sets it from the district hostname; the installer sets it on a
one-origin install from the public origin, or from the install config's `ltiToolOrigin` when LMS
platforms already registered the Tool at another origin (SCHO-243; the installer neither attaches
nor protects that hostname). Its LTI records share the
district's Durable Object with the application's, in the `educateos_lti_records` table.

| Path | Who calls it | Sign-in |
| --- | --- | --- |
| `GET/POST /lti/login`, `POST /lti/launch`, `GET /lti/jwks`, `POST /lti/deep-link`, `GET /lti/register` | the platform and its users' browsers | none: **exempt from Access**, exactly these paths. Each is protected by what it carries (a platform-signed id_token bound to single-use state and the browser's state cookie, a single-use deep linking session, a single-use registration invitation). |
| `/api/lti/*` | district administrators and teachers | Cloudflare Access, as the rest of `/api`: verified and resolved through the directory, then decided by policy. |

A platform's users never pass through Access: Canvas posts the launch from the learner's own
browser, inside the Canvas iframe, with no Access session. So the bypass must cover the five Tool
paths and nothing else; the administrators' surface stays behind the district's Access
application.

The resource link launch answers with a page built from the directory (who the principal is, the
offering, the linked activity). The deep linking picker lists the activities assigned in the
launch's offering; the choice is authorized by `policySelectActivities`.

`/api/lti/*` (JSON in and out). Every POST, bodiless ones included, must be sent as
`application/json`, which a cross-site form cannot do, so another site cannot use an
administrator's Access session:

| Route | Decided as | Does |
| --- | --- | --- |
| `POST invitations` | `update` district | Issues a single-use Dynamic Registration URL. |
| `GET registrations` | `read` district | Approved and pending registrations. |
| `POST pending/:id/approve`, `POST pending/:id/reject` | `update` district | Approves with `{ provider, offerings, activityLinks?, deploymentIds? }`, or discards. |
| `POST trusted-issuers` | `update` district | Trusts the issuer `{ issuer }` of a pending or approved registration, which approval and identity links need. |
| `POST identity-links` | `update` district | Records a pending link `{ issuer, subject, principalId }`; approve it at `/api/admin/identity-requests/:id/approve`. An unlinked launch's error body names its `issuer` and `subject`. |
| `GET offerings/:offeringId/services` | `update` offering | The AGS and NRPS services launches reported. |
| `POST grade-routes`, `POST grade-columns` | `update` offering | As `LtiAdminService.routeGradesToPlatform` and `bindGradeColumn`. |
| `POST line-items` | `update` offering | Creates an AGS line item in a connected context. |
| `POST roster` | `update` offering | Reads the context's NRPS roster, matched to identity links. Nothing is written. |
| `POST passback` | `approve` on the student's official grade, and the approving teacher only | Publishes `{ offeringId, studentId, column, gradeVersion }`: only the teacher who approved that official grade version may, and the score sent is the approved one. Policy decides before the approval is read, so a refused caller learns nothing about the grade. `GradePassback` then checks everything again. |
| `GET tool-keys`, `POST tool-keys/rotate` | `read` / `update` district | The published key IDs; rotation keeps the previous key published. |

Platform calls (JWKS, tokens, AGS, NRPS, registration) use `redirect: "manual"` and refuse any
redirect: the Workers runtime rejects `redirect: "error"` outright.

# EducateOS as an LTI Platform (SCHO-179, IF-10)

EducateOS can also be the **Platform**, hosting vetted third-party tools for a district or co-op
with no LMS (RFC 0002 §5). This is being built in slices; what exists so far is harness-tested only,
against no real tool, and claims no 1EdTech conformance.

The district Worker serves the platform only when `LTI_PLATFORM` is exactly `on` (it also needs
`LTI_TOOL_ORIGIN`, whose origin is the platform's issuer). Unset, or any other value, every
`/lti/platform/` path is 404 and the platform's `/api/lti/` routes do not exist. No configuration
in `scripts/production/` sets it, so it is off on every production and demo district.

## Platform keys

The platform signs its launches with its own RS256 key set, kept by a `TableToolKeyStore` in the
`lti.platform-keys` collection (`PLATFORM_KEYS_COLLECTION`) of the district's Durable Object,
beside the tool keys but never shared with them: a key that signs EducateOS's messages as a Tool
never signs a launch as a Platform, and rotating one set leaves the other alone. Like the tool keys,
the first read generates the key (the first stored wins a race), and a rotation keeps one retired
public key published. `LtiPlatformKeyService` (`@educateos/lti-district`) decides the
administrators' calls with the policy engine.

| Path | Who calls it | Decided as | Does |
| --- | --- | --- | --- |
| `GET /lti/platform/jwks` | tools, from their servers | public, exempt from Access as all of `/lti/*` | The platform JWKS: public halves only, `cache-control: public, max-age=300`. |
| `GET /api/lti/platform-keys` | district administrators | `read` district | The published key IDs, signing key first. |
| `POST /api/lti/platform-keys/rotate` | district administrators | `update` district | Rotates the platform key; the previous one stays published. |

## Platform tools in the district Worker

`createLtiDistrictStores` includes the tool and deployment store (`platformTools`), and the district
Worker serves `LtiPlatformToolService` to administrators beside the key routes, behind Access, and
only when the platform is on. Like every `/api/lti/` POST, each must be `application/json`, so a
cross-site form cannot use an administrator's session. Workerd tests cover a teacher's refusal,
an off-origin tool URL and an offering outside the district refused, durability across restarts,
and revoking a tool revoking its deployments.

| Path | Decided as | Does |
| --- | --- | --- |
| `GET /api/lti/platform-tools` | `read` district | Every tool and deployment, active and revoked: `{ tools, deployments }`. |
| `POST /api/lti/platform-tools` | `update` district | Registers `{ name, loginInitiationUrl, redirectUris, targetLinkUri, jwksUrl }`; returns the tool with its assigned `ltt_…` ID. |
| `POST /api/lti/platform-tools/:id/revoke` | `update` district | Revokes the tool and every deployment of it. |
| `POST /api/lti/platform-deployments` | `update` district | Deploys `{ toolId, offerings, services?, privacy? }`; every service and personal field is off unless given. |
| `POST /api/lti/platform-deployments/:id` | `update` district | Changes any of `{ offerings, services, privacy }`; a revoked deployment cannot change (409). |
| `POST /api/lti/platform-deployments/:id/revoke` | `update` district | Revokes one deployment. |

## Platform launches in the district Worker

`createLtiDistrictStores` includes the launch tickets (`platformLaunchTickets`) and the per-tool
subjects (`platformSubjects`), in the district's Durable Object, and the district Worker serves
both halves of a launch (`src/lti-platform.ts`), only when the platform is on:

| Path | Sign-in | Does |
| --- | --- | --- |
| `POST /api/lti/platform-launches` | Access; `read` on the offering, decided by `LtiPlatformLaunchService.start` | Starts a launch of `{ deploymentId, offeringId }` for the caller. Must be `application/json`. Returns `{ loginUrl, expiresAt }` (`no-store`) and sets the browser-binding cookie; the page sends the browser to `loginUrl`, the tool's login initiation URL. |
| `GET` or `POST /lti/platform/auth` | None (under the Access-exempt `/lti/`); the cookie and the ticket | The OIDC authorization endpoint. Takes the tool's authentication request as a query or an urlencoded form (a repeated parameter is malformed), calls `authorize` with the cookie, and answers with a page that posts `id_token` and `state` to the matched `redirect_uri`. |

- **The cookie**, `__Secure-educateos-lti-launch`, holds the browser binding: `Path=/lti/platform/;
  Secure; HttpOnly; SameSite=None`, `Max-Age` five minutes like the ticket. `SameSite=None` because
  the tool's authentication request arrives cross-site, as a redirect or a form post. A request
  with no launch cookie, or with two, has no binding. Every answer of `/lti/platform/auth` clears it.
- **The form page** escapes every value, sends `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer` and a CSP of `default-src 'none'`, `form-action` the redirect URI's origin only,
  `base-uri 'none'`, `frame-ancestors 'self'` and a script allowed by a per-response nonce, which
  submits the form; without scripts the person presses a button.
- **A refused request** is answered on EducateOS with a page (400 for a malformed request, 403
  otherwise) and the same headers; nothing is redirected or posted to the tool. The ticket is spent
  by the first attempt, so a refusal cannot be retried.
- **Logs** (`educateos.lti.platform`) record starts, answers and refusals with the error code, never
  a token, ticket, cookie or body.

Workerd tests drive `FakeLtiTool` through the Worker: a student's launch (by redirect) and a
teacher's (by form post) verified by the tool, with `Learner` and `Instructor`, the offering as
context, no name or email by default, and the same subject on a later launch; refusals to start for
a teacher not enrolled in the offering, an offering outside the deployment, an unknown deployment,
no sign-in and a form-encoded body; and at `/lti/platform/auth`, a missing, wrong or doubled
cookie, a replayed ticket (by redirect and by form post), a wrong `client_id`, an unregistered
`redirect_uri` (not echoed in the refusal), a missing nonce, a repeated parameter and a JSON body,
each refused with the cookie cleared and nothing posted. With `LTI_PLATFORM` unset both paths are
404.

## Service tokens

Tools reach the platform's LTI Advantage services (NRPS and AGS, in later slices) with OAuth 2
access tokens from `POST /lti/platform/token`: the client credentials grant, with the tool
authenticated by a `private_key_jwt` client assertion (RFC 7523, LTI Security Framework §4.1).
`PlatformTokenEndpoint` (`@educateos/lti`, `platform-service-tokens.ts`) implements it, over
`TablePlatformServiceTokenStore` (`@educateos/lti-district`) in the district's Durable Object. The
endpoint is public, exempt from Access as all of `/lti/*` is, and served only when the platform is
on. Harness-tested only; no service accepts its tokens yet, and no real tool has called it.

An assertion is accepted only if:

- it is RS256 (never a symmetric or unsigned algorithm), names its `kid`, and verifies against that
  key in the JWKS the tool registered (`jwksUrl`, fetched through `PlatformJwksCache`, so RSA keys
  of 2048 bits or more, refetched for an unknown `kid` at most every 30 seconds);
- its `iss` and `sub` are an active tool's client ID (`ltt_…`), and a `client_id` parameter, if
  sent, is the same;
- its `aud` is exactly the endpoint's URL, `<LTI_TOOL_ORIGIN>/lti/platform/token`, alone;
- it carries `iat`, `exp` and `jti`, lives at most five minutes from `iat` to `exp`, and is neither
  expired nor issued in the future, with 30 seconds of clock skew allowed either way;
- its `jti` has not been used by that tool. Each accepted `jti` is recorded in the
  `lti.platform-assertion` collection until the assertion could no longer be accepted, in one
  atomic check-and-write, so of any number of concurrent requests with one assertion exactly one
  succeeds, and a replay after a restart still fails. The `jti` is used up once the signature
  verifies, even if the scope is then refused.

The requested `scope` must name only LTI Advantage scopes, each allowed by a service some active
deployment of the tool has turned on (`PLATFORM_SCOPE_SERVICES`):

| Scope | Deployment service |
| --- | --- |
| `https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly` | `nrps` |
| `https://purl.imsglobal.org/spec/lti-ags/scope/lineitem`, `…/lineitem.readonly`, `…/result.readonly` | `agsLineItems` |
| `https://purl.imsglobal.org/spec/lti-ags/scope/score` | `agsScores` |

The answer is `{ access_token, token_type: "Bearer", expires_in: 900, scope }`. The token is
opaque (`lst_…`, 256 random bits) and kept only as its SHA-256 digest in the
`lti.platform-access-token` collection, with the tool and its granted scopes, for 15 minutes.
`PlatformTokenEndpoint.verify` (and `verifyRequest`, for an `Authorization: Bearer` header; the
district Worker's `DistrictLtiPlatform.verifyServiceRequest`) re-reads the tool and its deployments
on every call: it refuses an unknown or expired token and one whose tool is revoked, and returns
only the granted scopes some active deployment still allows, with the tool's active deployments, so
the service can then check the offering with `deploymentAllows`. Revoking a tool, a deployment or a
service therefore ends a token's use at its next call.

Refusals are RFC 6749 §5.2 errors with `cache-control: no-store`: `invalid_request` (not a form
post, a repeated parameter, an `Authorization` header, a body over 16 KiB), `unsupported_grant_type`,
`invalid_client` with status 401 for every assertion failure (RFC 7523 §3.2, replay included) and for
a revoked or unknown tool, `unauthorized_client` for a tool with no deployment allowing any
service, and `invalid_scope`. The Worker logs only the outcome (`lti.platform.token.issued` or
`.refused`, with the tool ID, error code and number of scopes); never the assertion, the token or
the body.

Tests: unit tests in `packages/educateos-lti` cover a wrong audience, issuer, subject or
`client_id`, HS256 and `alg: none`, an unpublished key and a forged signature under a published
`kid`, expired, future-dated and over-long assertions, replay, a revoked tool, unknown and excess
scopes, malformed requests, and EducateOS's own `LtiServiceClient` obtaining a token as a tool
would. Workerd tests in `packages/educateos-lti-district` cover 50 concurrent redemptions of one
`jti`, its record across a restart, and a token verifying across a restart until its tool is
revoked or it expires; the district Worker's test covers the endpoint without an Access session,
replay refusal, and verification across a restart until the tool is revoked.
