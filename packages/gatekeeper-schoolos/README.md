# SchoolOS gatekeeper

`gatekeeper-schoolos` (package `@schoolos/gatekeeper`, roadmap A02b, SCHO-57) gives a Workshop
agent the district's school tools. A person connects their school account once. Their agents then
get a `SCHOOL` binding (`SchoolToolsSession` in `src/types.d.ts`) with two methods: `listTools()`
and `callTool(name, args)`. Every call acts as the district principal the account was verified
as, and is decided by the same `@schoolos/policy` engine and `SchoolToolRunner` as the district's
HTTP routes.

## The rules it keeps

- **The subject comes from the account, never from tool input.** When the account is connected,
  the district verifies who followed the connect link and stores that principal on the account. A
  session reads it from there on every call. Tool arguments only select records. The runner
  rejects unknown fields, so a `principalId`, role or district in the arguments fails validation.
- **`readOnlyHint` is ignored.** The runner authorizes each tool by its declared `action` alone.
  The agent's tool listing omits annotations altogether, so the hint cannot mislead the agent
  either.
- **Reads are observations.** A call that returns data is recorded with `authorizeObservation`
  before the data reaches the agent. If the Workshop refuses the record, the agent gets nothing.
- **Writes wait for a person, and the agent cannot approve them.** The district runs agent calls
  with `confirmWrites`, so every call whose action is not a read is queued in the district's
  approval queue (SCHO-55, `@schoolos/policy`). It is not run. The gatekeeper submits the queued
  change to the Workshop's approval queue (`delivery: "await-decision"`), and no action kind is
  auto-approvable. Only a person's approval in the Workshop reaches `applyAction`. That forwards
  the decision to the district as the account principal's own decision on the `http` channel. No
  tool or agent channel can approve anything. For an official grade the policy still requires a
  teacher of the offering (`grade.official.teacher-direct`). A co-teacher's approval therefore
  fails, and the change keeps waiting in SchoolOS for the teacher. Rejecting a change in the
  Workshop declines it in the district with a reason.
- **Cross-district calls are denied.** The district service refuses any subject or decider from
  another district before anything is decided. A connect link followed by another district's
  principal is refused. Records in another district are denied by the engine's cross-district
  precheck and answered as `not-found`.
- **Workspaces that read school records are not shared.** `addObserver` always throws (observer
  strategy A). A read reveals what the account's principal may see. The gatekeeper has no way to
  show that a collaborator is entitled to the same student records.

## Why accounts are connected, not auto-provisioned

`autoProvisionsAccount` is not set. `createAccount()` takes no user identity by design: an
auto-provisioned account cannot know which person it is for. A school account must act as one
district principal, and the only trustworthy source of that principal is the district's own
sign-in. The Workshop's user identity is not enough, because it is keyed by email address, and
ADR-0003 rules email out as an identity. So the account is connected:

1. `connectAccount` creates a `SchoolOsAccountObject` with a single-use nonce. It returns
   `<BASE_URL>/connect/<account>/<nonce>`.
2. Opening the link shows a confirmation page and changes nothing. Submitting it sends the
   browser's own request to the district's `authenticate`, which reads the district sign-in (its
   Access token or session). If that browser is not signed in to this district, the link is
   refused and stays usable.
3. The account stores the verified principal and hands itself to the Workshop's callback. The
   Workshop activates it only once the connect handoff returns over the initiating user's own
   session (`docs/connect-handoff.md`). A link sent to someone else therefore cannot bind their
   principal to the sender's Workshop account.

Revoking the account deletes the principal. From then on, every session of that account fails
before it calls the district.

## The district binding

The gatekeeper reaches the district through `SCHOOLOS_DISTRICT`, a service binding whose target
implements `SchoolToolService` (`src/district.ts`). The district deployment injects it. It is not
in `cloudflare.config.ts`, so a release that has no district still installs the gatekeeper, and
the gatekeeper then refuses every call. `createSchoolToolService` builds the service in process
over a `SchoolToolRunner`. That is what a district Worker exposes, and what the tests and the
pilot gate compose. Only the gatekeeper holds the binding, and it passes only subjects read from a
connected account. That is the trust the binding carries.

## Release

The gatekeeper takes no OAuth credentials, so `scripts/release/manifest-lib.ts` lists it in
`NO_DEFAULT_CRED_INPUTS`. Without that entry, the deploy wizard would ask for a `CLIENT_ID` and
`CLIENT_SECRET`. It needs no `deploy-inputs.json`. It is also in `SINGLETON`, because a second
install would be byte-identical. It is installable, but it is not preinstalled: it does nothing
until a district deployment binds `SCHOOLOS_DISTRICT`.

## Layout and tests

- `src/session.ts` and `src/district.ts` import nothing Workers-only, so they run in Node and the
  pilot gate compiles them (ADR-0009). `src/worker.ts` contains the entrypoints, the connect flow
  and the workspace facet. `src/describe.ts` builds the text people see.
- `__tests__/session.test.ts` (Node) covers the session and the district service over Northfield:
  the subject cannot change, `readOnlyHint` is ignored, writes queue for a person, and
  cross-district calls are denied.
- `__tests__/workerd/` runs the Worker itself: the connect flow, and the facet installed through
  `ctx.facets` as the overseer installs it. The district sits behind a real `SCHOOLOS_DISTRICT`
  service binding.
- The pilot gate's `s14.tool-identity/mcp-surface` check drives the session over the district
  app's engine.
