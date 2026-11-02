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
resource link per deployment and offering (or, when the launch names one, a resource link a
teacher added by [Deep Linking](#deep-linking)), the LIS role (`Instructor` for a teacher or co-teacher,
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
| `TablePlatformAgsStore` (SCHO-179) | A score's timestamp is compared and recorded in one atomic step; a result is recorded only while its line item exists and no later score is official, and a line item with an official result cannot be removed. |
| `TablePlatformScoreApprovalStore` (SCHO-179) | The IF-06 `ToolApprovalStore` contract: an open action per idempotency key, and every transition a compare-and-set, so two approvals of one score cannot both apply it. |

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
| `POST /api/lti/platform-launches` | Access; `read` on the offering, decided by `LtiPlatformLaunchService.start` | Starts a launch of `{ deploymentId, offeringId, resourceLinkId? }` for the caller (`resourceLinkId`: see [Deep Linking](#deep-linking)). Must be `application/json`. Returns `{ loginUrl, expiresAt }` (`no-store`) and sets the browser-binding cookie; the page sends the browser to `loginUrl`, the tool's login initiation URL. |
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

Tools reach the platform's LTI Advantage services ([NRPS](#names-and-role-provisioning-nrps) and [AGS](#assignment-and-grade-services); Deep Linking needs no token) with OAuth 2
access tokens from `POST /lti/platform/token`: the client credentials grant, with the tool
authenticated by a `private_key_jwt` client assertion (RFC 7523, LTI Security Framework §4.1).
`PlatformTokenEndpoint` (`@educateos/lti`, `platform-service-tokens.ts`) implements it, over
`TablePlatformServiceTokenStore` (`@educateos/lti-district`) in the district's Durable Object. The
endpoint is public, exempt from Access as all of `/lti/*` is, and served only when the platform is
on. Harness-tested only; the NRPS and AGS endpoints accept its tokens (see [Names and Role
Provisioning](#names-and-role-provisioning-nrps) and [Assignment and Grade
Services](#assignment-and-grade-services)), and no real tool has called it.

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
| `https://purl.imsglobal.org/spec/lti-ags/scope/lineitem`, `…/lineitem.readonly` | `agsLineItems` |
| `https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly` | `agsResults` |
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

## Names and Role Provisioning (NRPS)

A deployed tool reads the roster of an offering it is deployed to through the platform's Names and
Role Provisioning Service (NRPS 2.0). The wire parts are in `@educateos/lti` (`platform-nrps.ts`),
the decision and the roster in `@educateos/lti-district` (`LtiPlatformNrpsService`,
`platform-nrps.ts`), and the route in the district Worker (`src/lti-platform-nrps.ts`), served only
when the platform is on. Harness-tested only, with `FakeLtiTool`; no real tool has called it, and
no conformance is claimed.

**Advertised by the launch.** A launch through a deployment that allows `nrps` carries the
`https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice` claim, with `service_versions:
["2.0"]` and `context_memberships_url`
`<LTI_TOOL_ORIGIN>/lti/platform/nrps/<deploymentId>/<offeringId>/memberships`: one URL per
deployment and offering, and nothing else reaches the same roster. A deployment without `nrps`
advertises nothing, and its tool cannot get the scope (`invalid_scope` at the token endpoint).

**Who may read it.** `GET` on that URL, with `Authorization: Bearer` and a service token:

1. The token must verify (`verifyServiceRequest`): unknown, expired, a revoked tool, or no scope its
   deployments still allow is `401` with `WWW-Authenticate: Bearer error="invalid_token"`.
2. It must carry `contextmembership.readonly`, or it is `403` with `Bearer
   error="insufficient_scope", scope="…"`.
3. The URL's deployment must be one of the token's tool's active deployments, include the URL's
   offering, and allow `nrps` (`deploymentAllows`). Then the policy engine decides, on the
   `lti-service` channel, with the tool as the subject: `list` on the offering's `enrollment`
   resources (`course`). Anything else, such as another offering, another tool's deployment, a
   deployment without `nrps` or a revoked one, is a plain `403 { "error": "forbidden" }`.

**The tool as a policy subject.** A tool is never a person. It is decided as the principal
`platformToolPrincipalId(toolId)` (`prn_lti-tool-<hex of the client ID>`), which no directory
principal can have. The district passes `platformToolPolicySources(store)` to the application's
`policySources`, so the engine reads, beside the directory:

- a **subject source** (`SubjectSource`, `@educateos/policy`), asked only for IDs the directory does
  not hold: the tool as a `service` subject, active while the tool is, and never with a role
  (`directoryPolicyInformation` drops any role a source returns);
- a **relationship source**: `lti-deployment`, held by an active deployment of the tool to the
  resource's offering that allows the service the resource and action need, recorded as the
  decision's `grantId`. The engine tells relationship sources the action, so one deployment can
  allow reading a resource and not writing it. An offering's enrollments (`list`) need `nrps`; its
  AGS line items (`gradebook`) need `agsLineItems`; their results (`list` official grades), which
  are students' grades, need their own `agsResults`; a
  score (`grade` an official grade) needs `agsScores` (see [Assignment and Grade
  Services](#assignment-and-grade-services)).

Rules use them after the guardian rules: `lti.tool.roster` allows a `service` subject on the
`lti-service` channel to `list` `enrollment` (`course`) through `lti-deployment`, the AGS rules
follow, and `guard.lti-service.tool-rules-only` denies everything else on that channel, so no other
rule (a reference read, a person's own grants) can be reached through it. Each read is audited with
the deployment's ID; the store is re-read on every decision, so a revocation applies to the next
call.

**What it returns.** `200`, `Content-Type: application/vnd.ims.lti-nrps.v2.membershipcontainer+json`,
`Cache-Control: no-store`, and `{ id, context: { id, label, title }, members }`: `id` is the URL read
(with its query), the context is the offering as in the launch, and the members are the offering's
active enrollments of active people, each with:

- `user_id`, the person's subject for that tool, the same value as the `sub` of their launches,
  made on first use if they have not launched yet;
- `roles`, `Instructor` for a teacher or co-teacher, `Learner` for a student, as in the launch;
- `status: "Active"`;
- `name`, `given_name` and `family_name` only if the deployment allows the name, and `email` only if
  it allows the email and one is on record.

Nothing else: no principal or enrollment ID, no inactive or dropped member, no grade, no other
offering.

**Query.** `role` filters by an LIS membership role, its full URI or short name (`Learner`,
`Instructor`); any other role matches nobody. `limit` (1 to 1,000) pages the roster in a stable
order (by enrollment), with `page` counting from 1, and a `Link: <…>; rel="next"` header while more
remain. A malformed `limit` or `page`, or a `page` without `limit`, is `400 invalid_request`.
`since` (membership differences) and the resource link `rlid` query are not implemented.

**Logs** (`educateos.lti.platform`): `lti.platform.nrps.read` with the tool, the deployment and the
number of members, and `lti.platform.nrps.refused` with the refusal; never a token, a subject, a
member or a body.

Tests: unit tests for the path, the role filter, the refusals and the launch claim
(`packages/educateos-lti`); the engine's tool subject and rules (`packages/educateos-policy`); the
policy sources and the service against the real engine, including another tool's subjects,
revocation and paging (`packages/educateos-lti-district`); and workerd tests in the district Worker
driving `FakeLtiTool` through launch, token and memberships, showing the class under the launch's
`sub` values, with another offering, another tool's deployment, a deployment without `nrps`, a token
without the scope, missing or unknown tokens and revoked deployments refused, names and emails only
as allowed, and the route 404 with `LTI_PLATFORM` unset.

## Assignment and Grade Services

A deployed tool reads and writes the offering's gradebook columns with AGS 2.0 (`platform-ags.ts`
in `@educateos/lti` for the schemas and the launch claim, in `@educateos/lti-district` for the
stores and `LtiPlatformAgsService`, and `src/lti-platform-ags.ts` in the district Worker for the
HTTP surface). Harness-tested only, against `FakeLtiTool`; no real tool has used it, and it claims
no AGS conformance.

**The launch claim.** When the deployment allows `agsLineItems`, `agsResults` or `agsScores`, the id_token carries
`https://purl.imsglobal.org/spec/lti-ags/claim/endpoint` with only the scopes those services grant,
`lineitems` (only with `agsLineItems`) set to the container of exactly that deployment and
offering, and `lineitem` when exactly one line item of that container was created for the launch's
resource link.

**Endpoints**, under the Access-exempt `/lti/platform/ags/`, each needing a current access token
from `/lti/platform/token` (`Authorization: Bearer`), answered with `Cache-Control: no-store`:

| Path | Scope | Service | Decided (the tool, `lti-service`) | Does |
| --- | --- | --- | --- | --- |
| `GET <deployment>/<offering>/lineitems` | `lineitem` or `lineitem.readonly` | `agsLineItems` | `list` gradebook: `lti.tool.line-items` | The container's line items, filtered by `resource_link_id`, `resource_id` or `tag` (no paging). |
| `POST <deployment>/<offering>/lineitems` | `lineitem` | `agsLineItems` | `create` gradebook: `lti.tool.line-items.write` | Creates a line item (`201`). The platform assigns its ID; other members, extensions included, are dropped. |
| `GET`, `PUT`, `DELETE …/lineitems/<id>` | `lineitem` (or `lineitem.readonly` to read) | `agsLineItems` | `read` / `update` / `delete` gradebook: `lti.tool.line-items`, `…write` | Reads, replaces (the next revision) or removes it. One with an official result is kept (`409`). |
| `POST …/lineitems/<id>/scores` | `score` | `agsScores` | `grade` the learner's official grade: `lti.tool.score`, `require-approval` | Takes a score (`204`); see below. |
| `GET …/lineitems/<id>/results` | `result.readonly` | `agsResults` | `list` official grades: `lti.tool.results` | Approved results only, by `user_id` if given. |

Bodies are JSON of at most 16 KiB, sent as the AGS media type or `application/json`. A deployment
or offering the token's tool cannot reach (another tool's, another offering, a revoked deployment's
offering) and a line item of another container are `404`, alike; no current token is `401` with
`WWW-Authenticate: Bearer error="invalid_token"`; a missing scope, a deployment without the service,
or a policy refusal is `403` with `error="insufficient_scope"`.

**Who a call is decided as.** The tool itself, never a person: the policy engine decides each call
on the `lti-service` channel with the tool's principal (`platformToolPrincipalId`, a `service`
subject with no role), as for NRPS above. Its only authority is the `lti-deployment` relationship
(`platformToolPolicySources`, given the AGS store as well as the tool store). For a line item, or
the official grades in it, only the deployment that created the line item counts (and reading
those grades needs that deployment's `agsResults`); for an
offering's gradebook columns as a whole, any active deployment of the tool there with
`agsLineItems`. Four rules, placed before `guard.lti-service.tool-rules-only`, use it:

- `lti.tool.line-items`: `list` and `read` the offering's gradebook columns (`teacher-only`);
- `lti.tool.line-items.write`: `create`, `update` and `delete` them, unless the term is completed;
- `lti.tool.results`: `list` a line item's official grades (`course`), which are approved scores only;
- `lti.tool.score`: `grade` a learner's official grade, unless the term is completed, with the effect
  `require-approval`: a score only ever waits for a teacher.

So no person's authority is lent to a tool: it keeps working when the administrator who deployed it
leaves or loses the role, and stops when the tool, the deployment or the service is revoked (the
route also refuses a deployment without the service, but the policy refuses it on its own). Every
decision is audited with the tool's principal and the deployment's ID as the `grantId`.

**Scores wait for a teacher.** `postScore` requires the `userId` to be the per-tool subject of an
active learner (an active student enrollment of an active person) in the offering, a valid score
(`scoreGiven` at least 0 with a `scoreMaximum`; AGS activity and grading progress; an ISO
timestamp), and a timestamp later than every score already received for that learner and line item
(`409` otherwise, AGS 2.0 §3.4.6). A `FullyGraded` score with a `scoreGiven` is then queued through
IF-06: it is a call of the school tool `lti_ags_score` (approval policy `approver`) on a
`SchoolToolRunner`, with the tool's principal as its requester (only the tool that owns the line
item can queue one), so it becomes a `PendingToolAction` pinned to the learner's official grade for
the line item at the line item's revision, with its digest. Any other score only records its
timestamp. Nothing a tool sends is ever official by itself.

The queue is `TablePlatformScoreApprovalStore` (`lti.platform-score-approval`), the
`ToolApprovalStore` contract over the LTI record table, kept apart from the district's school-tool
queue so a runner without this tool can never see or decline a score. A teacher decides it behind
Access:

| Path | Who | Does |
| --- | --- | --- |
| `GET /api/lti/platform-scores` | anyone signed in | The scores waiting for the caller's decision (each re-authorized), with the line item, learner, score, `digest` and expiry. The administrator who deployed the tool has no special access to them. |
| `POST /api/lti/platform-scores/:id/approve` | a teacher of the offering, directly (`approve` official grade, `grade.official.teacher-direct`) | `{ digest? }`: applies the reviewed score as the learner's official result (`applied`, then `already-applied`). Anyone else gets `404`. |
| `POST /api/lti/platform-scores/:id/decline` | the same teacher | `{ reason }`: the score never becomes official. (The requester is the tool, which has no signed-in route to withdraw it.) |

At approval the runner re-decides the tool's call as the tool, so a score whose tool or deployment
was revoked, or whose deployment lost `agsScores`, is declined by the policy; it resolves the target
again and declines it if the line item has changed since (another revision) or is gone; the score tool's recheck declines
it if the deployment no longer allows `agsScores`, the learner left the offering, or a later score
is already official. An approved score is the learner's official result for the line item
(`PlatformAgsResult` in `lti.platform-ags-result`, versioned, with the queued call's correlation
ID). These results are the platform's own record of the tool's column: they do not yet appear in
the EducateOS gradebook, whose official grades (`OfficialGradeVersion`) belong to a submission,
and `TableGradeColumnStore` binds a column to an EducateOS assignment for passback the other way.
Bringing approved results into the EducateOS gradebook is follow-up SCHO-315.

**Logs** (`educateos.lti.platform`) record line items listed, created, replaced and removed, scores
queued or recorded as progress, results read (with a count), decisions, and refusals with their
error code; never a token, a score, a grade or a body.

Tests: unit tests in `packages/educateos-lti-district` (over the real policy engine) cover a score
queued as a pinned approval that only a teacher of the offering applies (not the student, a
teacher of another offering, the deploying administrator or an agent channel), results showing
approved scores only, an older score never applied over a later official one, a queued score
declined after its line item changed or its deployment lost the service, another offering, a
non-learner, a missing scope, an earlier timestamp, a kept line item, the launch claim, the
queue's compare-and-set, every call audited as the tool with its deployment, the tool still working
after its deploying administrator is deactivated, and the engine itself refusing each AGS action
without its service and anything else on the channel. `packages/educateos-policy` tests the AGS
rules with a stand-in relationship source, completed terms included. Workerd tests in the district Worker drive `FakeLtiTool` (token by client
assertion, then AGS calls) through the Worker: the launch claim and the resource link's
`lineitem`, line item create, list, replace and remove, a score pending (not in results) until the
offering's teacher approves it with the reviewed digest across a restart, a declined score leaving
nothing, scores for a teacher's or an unknown subject, stale and malformed scores refused, another
offering and another tool's deployment refused, `401` without a current token, `403` without the
scope or the service, a revoked deployment's token dead, the tool's calls working and a score
approved while its deploying administrator is inactive, the district's policy audit naming the
tool and the deployment for every call, and no AGS routes with `LTI_PLATFORM` unset.

## Deep Linking

A teacher adds a deployed tool's content to their offering with Deep Linking 2.0
(`platform-deep-linking.ts` in `@educateos/lti` for the settings claim, the flow and resource link
records and the response's verification, in `@educateos/lti-district` for the store and
`LtiPlatformDeepLinkingService`, and `src/lti-platform.ts` in the district Worker for the HTTP
surface). Harness-tested only, against `FakeLtiTool`; no real tool has used it, and it claims no
Deep Linking conformance.

| Path | Sign-in | Does |
| --- | --- | --- |
| `POST /api/lti/platform-deep-links` | Access; decided by `LtiPlatformLaunchService.startDeepLinking` | Starts a deep linking request of `{ deploymentId, offeringId }`. Must be `application/json`. Returns `{ loginUrl, expiresAt }` (`no-store`) and sets two cookies: the launch cookie, and the deep linking cookie. |
| `GET` or `POST /lti/platform/auth` | as for a launch | Answers the tool's authentication request with an `LtiDeepLinkingRequest` id_token. |
| `POST /lti/platform/deep-links/<flow>` | None (under the Access-exempt `/lti/`); the deep linking cookie and the single-use flow | The flow's `deep_link_return_url`: takes the tool's `LtiDeepLinkingResponse` as the urlencoded `JWT` field, and answers with a page on EducateOS. |
| `GET /api/lti/platform-resource-links?offeringId=…[&deploymentId=…]` | Access; `read` on the offering, then on each link | The added links the caller may read: every draft for a teacher, none for a student. |

**Starting.** The deployment must be an active deployment of an active tool to the offering with
`deepLinking` on (an administrator's switch, off by default, set like every other service through
`/api/lti/platform-deployments`); the caller must be actively enrolled in the offering, not as a
student, and the policy engine must allow them `read` on the offering and `create` on its
`teacher-only` activities (`curriculum.activity.teacher-author`: a teacher of the offering). Every
refusal is `forbidden`, alike, with no cookie set. It mints a launch ticket as for a launch, carrying
the deep linking settings, and a single-use flow (`lti.platform-deep-link-flow`, thirty minutes, so
the teacher has time to choose) under a random ID that is the last segment of its return URL. The
flow holds the tool, deployment, offering, teacher, a random `data` value and the SHA-256 of the
same browser binding as the ticket.

**The request.** The id_token is a launch's (subject, context, privacy, signature) with
`LtiDeepLinkingRequest`, the `Instructor` role, no resource link and no AGS claim, and
`deep_linking_settings` (`platformDeepLinkingSettings`): the flow's `deep_link_return_url`,
`accept_types: ["ltiResourceLink"]`, `accept_presentation_document_targets: ["iframe", "window"]`,
`accept_multiple: true`, `accept_lineitem: false`, `auto_create: false` and the flow's `data`. The
authorization endpoint also refuses a deep linking ticket whose deployment has lost `deepLinking`.

**The cookie**, `__Secure-educateos-lti-deep-link`, holds the binding for the return: `Path=/lti/platform/deep-links/;
Secure; HttpOnly; SameSite=None` (the response arrives as a cross-site form post), `Max-Age` thirty
minutes like the flow. It is separate from the launch cookie, which `/lti/platform/auth` clears.
Every answer of a return URL clears it.

**Receiving.** `LtiPlatformDeepLinkingService.receive` takes the flow first, so the first post uses
it up, valid or not. Then the browser binding must match, the tool and deployment must still allow
`deepLinking` in the offering, and the response must verify (`verifyPlatformDeepLinkingResponse`):

- a JWT of at most 64 KiB, RS256 only (never `none` or a symmetric algorithm), with a `kid` the tool
  publishes at its registered JWKS URL (`PlatformJwksCache`, shared with the token endpoint);
- `iss` the tool's client ID, `aud` exactly the platform's issuer (one audience), `exp` not passed
  and `iat` not in the future, each with 30 seconds of skew, and a `nonce`;
- version `1.3.0`, `LtiDeepLinkingResponse`, the flow's `deployment_id`, and the flow's `data`, exactly;
- `content_items`, if present, an array of at most 50. Items of any type but `ltiResourceLink` are
  dropped and counted. Each resource link keeps its `title` (at most 200 characters; the tool's name
  if empty), `text` (at most 1000) and `url` (https, on the tool's registered origin) and nothing
  else: custom parameters, `lineItem`, icons, thumbnails, windows and iframes are dropped. A link
  that does not parse, a URL on another origin, or more than 10 links refuses the whole response.

The `nonce` is recorded per tool (`lti.platform-deep-link-nonce`) until the response could no
longer be accepted, atomically, so a nonce is accepted once. Last, the teacher must still be an
active person whom the policy engine allows to `create` a `teacher-only` activity in the offering,
decided as the teacher on the `http` channel: it is their action, approved by their browser. The
tool's authority plays no part, and nothing is decided on the `lti-service` channel. Only then is
every link stored, in one step, as a `PlatformResourceLink` (`lti.platform-resource-link`, an
`lrl_…` ID): the tool, deployment, offering, title, text, URL, `status: "draft"`, the teacher and
the time. Any refusal is `forbidden` and creates nothing.

**The page.** An accepted response is answered with a page on EducateOS saying how many drafts were
added (or that nothing was); a refusal with a page saying nothing was added (400 for a malformed
post, 403 otherwise), never a redirect. Both send `Cache-Control: no-store`, `Referrer-Policy:
no-referrer` and a CSP of `default-src 'none'; form-action 'none'; base-uri 'none';
frame-ancestors 'self'`.

**Drafts.** A resource link is decided as a `teacher-only` activity of the offering
(`draftActivityResource`): teachers read it (`course.instructor.read`), students are refused it
(`curriculum.activity.definition-staff-only`). It is not placed in the offering's course content
modules and cannot yet be published to students.

**Launching a link.** `POST /api/lti/platform-launches` takes an optional `resourceLinkId`: it must
be a link of the same deployment and offering, and the policy engine must allow the caller to `read`
it, so a student cannot launch a draft. The launch's `resource_link.id` is then the link's ID
(otherwise the deployment's own resource link in the offering, as before), and the AGS claim's
`lineitem` follows it.

**Not implemented.** Line items in content items (`accept_lineitem` is `false`, and a `lineItem` is
dropped); other content item types; custom parameters; publishing a draft or placing it in a module;
`lti_msg`/`lti_log` messages on the result page.

**Logs** (`educateos.lti.platform`) record starts, refusals at the start with their error code,
responses received with the tool, the number of drafts created and of items dropped, and refused
responses with their error code and reason (`PlatformDeepLinkingError.reason`, such as `data`,
`audience` or `nonce-replayed`); never a token, JWT, cookie or body.

Tests: unit tests in `packages/educateos-lti` cover the settings claim, item stripping and the title
default, and refusals for each wrong audience, issuer, data, deployment, message type, missing
nonce, future `iat`, expiry past the skew (and acceptance within it), foreign and non-https URLs,
too many links or items, a non-JWT, `none`, `HS256`, a missing `kid` and an oversized JWT. Workerd
tests in the district Worker (`lti-platform-deep-linking.test.ts`) drive `FakeLtiTool` through the
Worker: a teacher starts, the tool verifies the `LtiDeepLinkingRequest` and returns two links (and
an HTML item, dropped), two drafts are created without their custom parameters or line item,
invisible to a student, who cannot launch one; the teacher's launch of a draft carries its ID, and
another deployment's or an unknown link is refused; a student, a teacher of another offering and a
deployment without `deepLinking` cannot start, nor can a form-encoded body; tampered `data`, a wrong
`aud` or deployment, an unsigned, `HS256`, foreign-key or expired response, a foreign-origin URL,
eleven links, a missing or another flow's cookie, a replayed response, a replayed nonce on a new
flow, an unknown flow and a JSON post are each refused on EducateOS with the cookie cleared and
nothing created; a deployment that loses `deepLinking` mid-flow is refused; and with `LTI_PLATFORM`
unset the routes are 404.
