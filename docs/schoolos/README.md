# SchoolOS

SchoolOS turns this Workshop into a district-owned K-12 learning environment. A district installs it
into its own Cloudflare account. Students, teachers and administrators then work inside it without
operating developer infrastructure themselves.

This directory holds the decisions and contracts SchoolOS is built on. The execution roadmap (PR IDs
such as F01 and A02) lives in the SchoolOS Kanbanger project, which uses the `SCHO-` issue prefix.

## Where things live

| Path | What it is |
| --- | --- |
| `docs/schoolos/adr/` | Architecture decision records. Read these before changing a SchoolOS boundary. |
| `docs/schoolos/threat-model.md` | Assets, trust boundaries and threats, mapped to the acceptance tests. |
| `docs/schoolos/hall-monitor/` | Hall Monitor moderation and AI cost governance: the reconciled plan, model ingress matrix and source specification. |
| `packages/schoolos-contracts` | `@schoolos/contracts`: IDs, scopes, principals, the authorization vocabulary, capability manifests, configuration revisions, policy floors, errors and directory integrity checks. |
| `packages/schoolos-fixtures` | `@schoolos/fixtures`: two isolated synthetic districts. These are the only directory data tests may use. |
| `packages/schoolos-harness` | `@schoolos/harness`: boots both districts locally as isolated instances, each with a fake IdP, roster and AI provider. |

## Running the districts locally

```sh
pnpm schoolos:harness            # Northfield on :4801, Riverbend on :4802, until Ctrl-C
pnpm schoolos:harness -- --check # boot, check every /health over HTTP, exit
```

Each district serves `GET /health`, `GET /me` and `POST /ai/complete`, and the full district
application under `/api/` (see `@schoolos/district-app` below), seeded with demo content: an approved
resource and an installed activity in every active class, a student's essay in a personal and a
course workspace, one submission, an applied configuration revision and one AI request. The harness
prints a ready-made `curl` command with a token for one student, one teacher and one district
administrator per district. A token from one district's IdP is rejected by the other.
`SCHOOLOS_HARNESS_PORT` moves the first port.
| `packages/schoolos-identity` | `@schoolos/identity`: resolves verified `(issuer, subject)` claims to principals, the Cloudflare Access adapter, admin-confirmed identity linking and the email-keyed migration plan (F04). |
| `packages/schoolos-registry` | `@schoolos/registry`: Learning Registry records (frameworks, competencies, associations, resources, curriculum packs, evidence contracts), lossless CASE 1.1 codecs and a fetch-injected CASE client. `src/case/codec.ts` lists what CASE cannot express. |
| `packages/schoolos-config` | `@schoolos/config`: the configuration compiler. Capability registry and shipped pack manifests, the `schoolos.dev/v1alpha1` district document, revisions with diff and rollback, dry-run plans and form descriptors. |
| `packages/schoolos-integrations` | `@schoolos/integrations`: interoperability adapters, one namespace per standard. `oneroster` reads a OneRoster 1.2 bulk CSV export, previews it against the current directory, links IdP identities, quarantines mismatches, and applies only results that pass `checkDirectoryIntegrity`. |
| `packages/schoolos-lti` | `@schoolos/lti`: the LTI 1.3 broker. Platform registrations, launch validation, launch-to-principal and offering mapping, and Canvas Deep Linking (I01). See [lti.md](lti.md). |
| `packages/schoolos-catalog` | `@schoolos/catalog`: the reviewed framework catalog (CCSS, NGSS, C3, CASEL, ELOF, TEKS, Michigan) with licensing decisions and grade-band coverage, PlayTrek-derived seed releases, and the district-local catalog mirror (pinned releases, approvals, overlays, upgrade diffs, coverage report). |
| `packages/schoolos-content-studio` | `@schoolos/content-studio`: the Content Studio ingest pipeline (C03). SSRF-guarded URL import and magic-byte-checked uploads into quarantine, rights modes a teacher can only narrow, deterministic checks and an optional AI review that receives imported text only as delimited data (threat T7), a reviewer queue, and approvals that create immutable `ResourceDescriptor` releases. |
| `packages/schoolos-cartridge` | `@schoolos/cartridge`: the Thin Common Cartridge importer (C04). A bounded `.imscc` reader (entry, size and ratio caps, no unsafe paths, symbolic links ignored) and a DTD-free manifest parser for CC and Thin CC 1.1-1.3. Web links wait in quarantine until a teacher submits one to the Content Studio; LTI links become external-tool references that are never launchable without an approved registration; the organization becomes a proposed curriculum outline. Other resource types are skipped and counted. |
| `packages/schoolos-curriculum` | `@schoolos/curriculum`: learning activities (C05). Four subject-neutral templates (writing task, science investigation, primary-source analysis, problem set) generate one runtime model; definitions are versioned and immutable once published, reference only Content Studio releases, and may only narrow the AI-help policy. Installations pin one version into one offering and term and publish the student-visible class Codex, which never holds teacher-only notes or answer keys and reaches the AI helper only as data (threat T7). |
| `packages/schoolos-ocs` | `@schoolos/ocs`: the Open Course Specification (C06). Course packages of units, activity and resource references, Codex notes and standards that include other packages as modules; a deterministic resolver that writes a byte-stable lockfile and verifies every package's digest; a composer that flattens a locked course into one outline with hide, reorder and rename overrides, per-item provenance and rights that only narrow; teacher composition with no Git vocabulary; and the export to curriculum installations. |
| `docs/schoolos/rfc/` | Format RFCs. [0001](rfc/0001-open-course-specification.md) specifies OCS 1.0, which is its own contract, not Thin CC. |
| `docs/schoolos/standards-licensing.md` | What standards text may ship in this public repository, and why, framework by framework. |
| `packages/schoolos-installer` | `@schoolos/installer`: installs a root-signed release, verified against the release keys the district pins, into a district's Cloudflare account, through OAuth or a district-run token. It runs preflight, then reconciles desired against actual state with ownership checks, resumes after interruption, and supports rollback. Permissions are in [installer-permissions.md](installer-permissions.md); how releases are signed is in [release-signing.md](release-signing.md). |
| `packages/schoolos-releases` | `@schoolos/releases`: root-signed release manifests and rotating release keys, the `canary`/`stable`/`lts` channels, district-side verification of signed offers with approve, decline and defer, migration gates over the installer's dry-run drift report, and the root's staged rollout that halts on failing fleet health and offers a rollback. |
| `packages/schoolos-district-app` | `@schoolos/district-app`: the district application. `createDistrictApp` composes the domain services over their storage interfaces (in-memory for now), around one `PolicyEngine` and one audit sink, behind a fetch-standard handler whose `/api/me`, `/api/student`, `/api/teacher` and `/api/admin` routes are declared once, with their Zod schemas, in `src/routes.ts`. Every request gets a correlation ID that its policy decisions are audited under. `src/adapters.ts` holds the glue between services. |
| `packages/schoolos-api-client` | `@schoolos/api-client`: the typed fetch client the UIs use, written against the district app's route table, so a call names a route and its input and response types come from the same schemas the server validates with. |

## Decisions

1. [District data ownership and root independence](adr/0001-district-data-ownership.md)
2. [Package boundaries and kernel seams](adr/0002-package-boundaries.md)
3. [Issuer-qualified principal identity](adr/0003-principal-identity.md)
4. [Capability packs and policy floors](adr/0004-capability-packs-and-policy-floors.md)
5. [Default-deny authorization vocabulary](adr/0005-authorization-vocabulary.md)
6. [Reusing PlayTrek code](adr/0006-playtrek-ip-boundary.md)
7. [Hall Monitor and the kernel AI call guard](adr/0007-hall-monitor-and-ai-call-guard.md)
8. [AI spend in integer nanodollars](adr/0008-usd-nano-money.md)
9. [SchoolOS libraries type-check against the web-standard surface](adr/0009-typings.md)

## Rules every SchoolOS change follows

- No student or teacher content leaves the district's account. `schoolos.dev` is never in the data path.
- Identity is `(district, issuer, subject)`. Email is display metadata.
- Every HTTP route, MCP tool and agent action authorizes through the same vocabulary and denies by default.
- Narrower scopes may tighten district policy, never loosen it.
- Closing a term, dropping an enrollment or losing a roster row never deletes work.
- Tests use `@schoolos/fixtures` and reserved `.example` domains. Never use real people.
