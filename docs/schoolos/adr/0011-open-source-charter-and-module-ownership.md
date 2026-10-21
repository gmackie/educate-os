# ADR-0011: Open-source charter and module ownership

- Status: Accepted
- Date: 2026-10-21
- Issues: SCHO-168 (Integration Fabric RFC, [IF-00](../rfc/0002-integration-fabric.md))

## Context

ADR-0001 assumed a commercial root control plane at `schoolos.dev` that would hold entitlement
state, sign entitlements and receive fleet reports. `@schoolos/commerce` (R04) and
`@schoolos/fleet` (R01) were built for it. SchoolOS is not going to be sold as a hosted service.
It is open source, and each organization that installs it (a district, a school or a homeschool
co-op) runs it itself.

The code mostly already behaves this way. No deployed package (the Workshop backend, the router,
the gatekeepers, the AI call guard) imports `@schoolos/commerce` or `@schoolos/fleet`, no feature
is gated on an entitlement at runtime, and no runtime code calls `schoolos.dev`. The remaining
`schoolos.dev` strings are a vendor display URL in `gatekeeper-schoolos` and the
`schoolos.dev/v1alpha1` API version of the config document, which is a namespace, not an
endpoint. The installer verifies releases offline ([release-signing.md](../release-signing.md)) and
registers with a fleet registry only when its config has a `fleet` section and the CLI is given
`--registry-url`. The commercial assumptions live in the documents, and this ADR replaces them.

## Decision

1. **SchoolOS is open source under Apache-2.0** ([licensing.md](../licensing.md)). It is not a
   commercial SaaS. Nothing in the core is paid-gated.
2. **Each organization runs every core system in its own Cloudflare account.** That covers the
   Workshop, the district application and its stores, identity, policy, Hall Monitor and the AI
   call guard, integrations, and backups. A provider the organization explicitly approves may hold
   records for it (ADR-0001, rule 1).
3. **`schoolos.dev` is optional and outside the runtime.** It may host documentation, an optional
   guided bootstrap and public release artifacts. It never mediates runtime access, holds
   organization data, issues runtime tokens or gates features. An organization can install and
   operate SchoolOS from the CLI or its own CI without ever contacting it.
4. **The default runtime has none of the following:** entitlement checks, student-data fleet
   reporting, central subscription callbacks, or remote administrative access for anyone outside
   the organization.
5. **Release signatures are verified offline.** The installer checks `manifest.signed.json`
   against release keys the organization pins, with the grace period and the `insecure-pin`
   development mode described in [release-signing.md](../release-signing.md). The signature says
   which bytes the release key holder published; it grants no runtime authority. An organization
   may mirror releases, or build from source and pin its own release keys.
6. **`@schoolos/commerce` and `@schoolos/fleet` are optional, non-default reference code.** They
   are outside the mandatory runtime, nothing in the default install depends on them, and no new
   runtime dependency on them may be added. Whether to keep them in this repository, extract them
   or delete them is an open owner decision. Until then they stay buildable and tested.
7. **Instance registration and heartbeat are opt-in, content-free and off by default.** If an
   organization enables them, only the allow-listed fields of the R01 protocol are sent (never
   prompts, chat text, student work or rosters), and turning them off changes no classroom
   behaviour.

### Module ownership

"Required" means a default install needs the package. "Optional runtime" packages ship in the
release and an organization turns them on. Tooling never runs in an organization's account.

| Group | Packages |
| --- | --- |
| Kernel and core runtime (required) | `schoolos-contracts`, `schoolos-identity`, `schoolos-identity-links`, `schoolos-policy`, `schoolos-config`, `schoolos-academics`, `schoolos-workspaces`, `schoolos-learning-artifacts`, `schoolos-assessment`, `schoolos-curriculum`, `schoolos-content-studio`, `schoolos-registry`, `schoolos-catalog`, `schoolos-ai-governance`, `schoolos-zip`, `schoolos-district-app`, `schoolos-api-client`, `schoolos-student-ui`, `schoolos-teacher-ui`, `schoolos-admin-ui` |
| Optional runtime | `schoolos-ai-guard` (required whenever student-facing AI is on, ADR-0007), `gatekeeper-schoolos`, `schoolos-lti`, `schoolos-integrations`, `schoolos-cartridge`, `schoolos-ocs`, `schoolos-portability`, `schoolos-artifacts-git`, `schoolos-assessment-ci`, `schoolos-assessment-ai` |
| Optional, non-default reference code | `schoolos-commerce`, `schoolos-fleet` |
| Tooling, release and test | `schoolos-installer`, `schoolos-releases`, `schoolos-fixtures`, `schoolos-harness`, `schoolos-pilot-gate` |

`schoolos-releases` also holds the district-side verification the installer runs; that part is
required at install time, and its staged-rollout half is reference code for whoever publishes
releases. `schoolos-district-app` is listed as core although it has no Worker configuration yet
([maturity.md](../maturity.md)).

## Consequences

- ADR-0001 keeps district data ownership and root independence and loses the commercial root,
  entitlement state and the mandatory fleet protocol (its 2026-10-21 amendment). ADR-0007 and
  ADR-0008 carry short notes to match.
- The release key belongs to whoever publishes a release. For upstream releases that is the
  SchoolOS maintainers; it is not a service an installed organization talks to.
- A pilot-gate root-outage test still matters: it proves that nothing in the classroom path waits
  on `schoolos.dev`. Its wording still names the entitlement cache (below).
- Claims about standards support follow [maturity.md](../maturity.md). No 1EdTech certification
  is claimed.

### Follow-up code work (IF-00b)

These are out of scope for IF-00 and are tracked as one follow-up:

1. Reword the pilot-gate root-outage criteria in `packages/schoolos-pilot-gate/src/criteria.ts`
   so they no longer depend on the entitlement cache, and regenerate `pilot-gate.md`.
2. Add `license` fields to every `package.json` and a root `NOTICE` file.
3. Rename the installer's `commercialAccountId` and make fleet registration explicitly
   "optional instance registration" in `packages/schoolos-installer` (`config.ts`, `installer.ts`).
4. Move `SigningIdentity`, the signed envelopes and `toBase64Url` out of `@schoolos/fleet` into
   `@schoolos/releases` or `@schoolos/contracts`, so release signing does not depend on the
   optional fleet package.
5. Ship a pinned, auditable Hall Monitor Worker build in the release; only the client and contracts
   tarballs are vendored today (ADR-0007 note, RFC §12).
6. The root `README.md` still describes the upstream Cloudflare OS Workshop. It should say what
   this repository is.
