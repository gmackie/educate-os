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
| `packages/schoolos-contracts` | `@schoolos/contracts`: IDs, scopes, principals, the authorization vocabulary, capability manifests, configuration revisions, policy floors, errors and directory integrity checks. |
| `packages/schoolos-fixtures` | `@schoolos/fixtures`: two isolated synthetic districts. These are the only directory data tests may use. |
| `packages/schoolos-harness` | `@schoolos/harness`: boots both districts locally as isolated instances, each with a fake IdP, roster and AI provider. |

## Running the districts locally

```sh
pnpm schoolos:harness            # Northfield on :4801, Riverbend on :4802, until Ctrl-C
pnpm schoolos:harness -- --check # boot, check every /health over HTTP, exit
```

Each district serves `GET /health`, `GET /me` and `POST /ai/complete`. The harness prints a
ready-made `curl` command with a student token for each district. A token from one district's IdP is
rejected by the other. `SCHOOLOS_HARNESS_PORT` moves the first port.
| `packages/schoolos-identity` | `@schoolos/identity`: resolves verified `(issuer, subject)` claims to principals, the Cloudflare Access adapter, admin-confirmed identity linking and the email-keyed migration plan (F04). |
| `packages/schoolos-registry` | `@schoolos/registry`: Learning Registry records (frameworks, competencies, associations, resources, curriculum packs, evidence contracts), lossless CASE 1.1 codecs and a fetch-injected CASE client. `src/case/codec.ts` lists what CASE cannot express. |
| `packages/schoolos-config` | `@schoolos/config`: the configuration compiler. Capability registry and shipped pack manifests, the `schoolos.dev/v1alpha1` district document, revisions with diff and rollback, dry-run plans and form descriptors. |
| `packages/schoolos-integrations` | `@schoolos/integrations`: interoperability adapters, one namespace per standard. `oneroster` reads a OneRoster 1.2 bulk CSV export, previews it against the current directory, links IdP identities, quarantines mismatches, and applies only results that pass `checkDirectoryIntegrity`. |
| `packages/schoolos-lti` | `@schoolos/lti`: the LTI 1.3 broker. Platform registrations, launch validation, launch-to-principal and offering mapping, and Canvas Deep Linking (I01). See [lti.md](lti.md). |
| `packages/schoolos-catalog` | `@schoolos/catalog`: the reviewed framework catalog (CCSS, NGSS, C3, CASEL, ELOF, TEKS, Michigan) with licensing decisions and grade-band coverage, PlayTrek-derived seed releases, and the district-local catalog mirror (pinned releases, approvals, overlays, upgrade diffs, coverage report). |
| `packages/schoolos-content-studio` | `@schoolos/content-studio`: the Content Studio ingest pipeline (C03). SSRF-guarded URL import and magic-byte-checked uploads into quarantine, rights modes a teacher can only narrow, deterministic checks and an optional AI review that receives imported text only as delimited data (threat T7), a reviewer queue, and approvals that create immutable `ResourceDescriptor` releases. |
| `docs/schoolos/standards-licensing.md` | What standards text may ship in this public repository, and why, framework by framework. |
| `packages/schoolos-installer` | `@schoolos/installer`: installs a pinned release into a district's Cloudflare account, through OAuth or a district-run token. It runs preflight, then reconciles desired against actual state with ownership checks, resumes after interruption, and supports rollback. Permissions are in [installer-permissions.md](installer-permissions.md). |

## Decisions

1. [District data ownership and root independence](adr/0001-district-data-ownership.md)
2. [Package boundaries and kernel seams](adr/0002-package-boundaries.md)
3. [Issuer-qualified principal identity](adr/0003-principal-identity.md)
4. [Capability packs and policy floors](adr/0004-capability-packs-and-policy-floors.md)
5. [Default-deny authorization vocabulary](adr/0005-authorization-vocabulary.md)
6. [Reusing PlayTrek code](adr/0006-playtrek-ip-boundary.md)

## Rules every SchoolOS change follows

- No student or teacher content leaves the district's account. `schoolos.dev` is never in the data path.
- Identity is `(district, issuer, subject)`. Email is display metadata.
- Every HTTP route, MCP tool and agent action authorizes through the same vocabulary and denies by default.
- Narrower scopes may tighten district policy, never loosen it.
- Closing a term, dropping an enrollment or losing a roster row never deletes work.
- Tests use `@schoolos/fixtures` and reserved `.example` domains. Never use real people.
