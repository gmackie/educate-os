# EducateOS capability maturity

- Status: Living document. Update a row in the PR that changes its evidence.
- Date: 2026-10-21
- Issue: SCHO-168 ([ADR-0011](adr/0011-open-source-charter-and-module-ownership.md), [RFC 0002](rfc/0002-integration-fabric.md) §1)

Having specification-shaped code is not the same as interoperating with a real platform. This page
records, per capability, how far the code has actually got, so that docs, READMEs and release
notes claim only what the evidence supports. The pilot gate's MET/NOT MET table
([pilot-gate.md](pilot-gate.md)) is generated from its own criteria and is not repeated here.

**No 1EdTech certification is claimed for any part of EducateOS.** Where this repository says it
supports "LTI 1.3" or "LTI Advantage", it means implemented and unit-tested Tool-side client code,
not conformance-tested or certified behaviour.

## Levels

Each level includes the ones before it.

| Level | Meaning |
| --- | --- |
| Designed | An ADR, RFC or spec describes it. No code. |
| Implemented | Code exists and type-checks. |
| Unit-tested | Package tests cover the behaviour, including failure paths. |
| Harness-tested | Exercised end to end in process, against in-process fakes, the synthetic districts or a `workerd` test pool. |
| Deployed | Runs from a release in a real Cloudflare account. |
| External-conformance-tested | Passed runs against a real external party: an LMS sandbox, a real MCP client, a OneRoster provider, or an official test suite. |
| Certified | Formally certified by the standard's body (for example 1EdTech). |

## Capabilities

| Capability | Level | Evidence | Gaps | Next step |
| --- | --- | --- | --- | --- |
| LTI 1.3 Tool: OIDC login, launch validation, launch-to-principal and offering mapping | Unit-tested | `packages/educateos-lti` (`broker.ts`, `handlers.ts`), tests against an in-process `FakePlatform` | Registration, nonce and state stores are in memory only. No Canvas or Moodle sandbox run. | Durable stores and a Canvas sandbox run (IF-08) |
| LTI Advantage Tool: Deep Linking 2.0, AGS, NRPS, teacher-approved grade passback | Unit-tested | `packages/educateos-lti` (`deep-linking.ts`, `ags.ts`, `nrps.ts`, `passback.ts`, `service-client.ts`) | Same fixtures only. Service paging links are checked by origin, not origin and path. No conformance run. | Origin-and-path paging guard, then sandbox and conformance fixtures (IF-08) |
| LTI Platform (EducateOS hosting third-party tools) | Designed | RFC 0002 §5 | No code. | IF-10 |
| Google Classroom | Implemented (adapter shell) | `packages/educateos-lti/src/classroom.ts` | Not an LTI platform; uses Google's own APIs and scopes. | Not scheduled |
| MCP client (Workshop calls external MCP servers) | Unit-tested | `packages/mcp-shared`, `packages/gatekeeper-mcp`; `@modelcontextprotocol/client` 2.2.0, protocol `2025-06-18` | Upstream Workshop feature, not EducateOS-specific. | Track the SDK when IF-05 pins a version |
| MCP server (an organization's own `/mcp` for external clients) | Designed | RFC 0002 §5 | No server, no server SDK installed, no OAuth resource server or protected-resource metadata. | IF-05 |
| School tools for Workshop agents | Harness-tested | `packages/gatekeeper-educateos` (`SchoolToolRunner` with `confirmWrites`), `packages/educateos-policy` (`tools.ts`, `approvals.ts`), pilot-gate security matrix; the district Worker's `DistrictSchoolTools` entrypoint, with a Durable Object approval store (workerd-tested, SCHO-171) | Not deployed against a real district. The district serves only the academic directory's operations as tools. No installer binds `EDUCATEOS_DISTRICT` to it yet. | Bind it in the installer; deploy with the district Worker |
| Policy engine and approvals | Harness-tested | `packages/educateos-policy` (default deny, one rule table per ADR-0010), pilot-gate security matrix | Approval store in memory. Approvals do not pin target version or recheck provider authority. | Durable store and pinned approvals (IF-06) |
| District application (typed `/api` surface) | Harness-tested; Worker workerd-tested | `packages/educateos-district-app/src/routes.ts` (57 routes with Zod schemas), `packages/educateos-harness`, `packages/educateos-pilot-gate`; durable stores in `packages/educateos-district-app/src/durable-stores.ts`; `packages/educateos-district-worker` (one SQLite Durable Object per district, Access sign-in, `EDUCATEOS_DISTRICT` entrypoints), whose workerd suite writes the roster, an assignment and a submission and reads them back after a restart (SCHO-171) | Not deployed to a real account. Nothing routes browsers to its `/api`, and no installer binds its entrypoints to the guard or the gatekeeper yet. Artifact content is chunked SQLite rather than R2, and there is no D1, until the deploy service accepts a service's placeholders (SCHO-138). One object serves the whole district. | Route `/api` to it, bind its entrypoints in the installer, then a sandbox deploy (IF-02) |
| OneRoster 1.2 roster sync | Unit-tested | `packages/educateos-integrations/src/oneroster`: quarantine, preview with all-or-nothing apply, deactivate rather than delete, per-file delta cursors, Durable Object sync store | No hold for a large removal. No run against a real OneRoster provider. | Large-removal hold and provider health (IF-11) |
| Identity links | Unit-tested | `packages/educateos-identity`, `packages/educateos-identity-links` (Durable Object SQLite store) | Not deployed. | Deploy with the district Worker |
| Installer | Unit-tested | `packages/educateos-installer` against a fake Cloudflare API | Permissions not yet verified in a sandbox account ([installer-permissions.md](installer-permissions.md), SCHO-66). | G2 sandbox install |
| Signed releases | Unit-tested | `packages/educateos-releases`, `scripts/release/release-signing.ts` ([release-signing.md](release-signing.md)) | Verification is offline against pinned keys. | Move signing primitives out of `@educateos/fleet` (IF-00b) |
| AI call guard and Hall Monitor | Unit-tested (guard); client vendored | `packages/educateos-ai-guard`, `vendor/hall-monitor` (client and contracts only) | The Hall Monitor Worker is built outside the release, from `gmackie/hall-monitor`. | Pinned Worker build in the release (IF-00b, RFC 0002 §12) |
| Commerce and fleet | Unit-tested, optional and non-default | `packages/educateos-commerce`, `packages/educateos-fleet` | Not part of the default runtime (ADR-0011). | Owner decision on keeping or extracting them |

## Rules for claims

- A README or release note names the level from this table, not a stronger one.
- "Supports X" with no qualifier means at least External-conformance-tested. Below that, say
  "implements X (unit-tested)" or similar.
- A level goes up only in the PR that adds the evidence, and that PR updates this table.
