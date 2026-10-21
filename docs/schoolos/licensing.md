# SchoolOS licensing

- Status: Living document
- Date: 2026-10-21
- Issue: SCHO-168 ([ADR-0011](adr/0011-open-source-charter-and-module-ownership.md))

This repository is public, and everything in it is published. This page says what license covers
what, and what has to be true before code from elsewhere comes in. It is an engineering record,
not legal advice. Standards text has its own page, [standards-licensing.md](standards-licensing.md).

## The repository

| What | License | Notes |
| --- | --- | --- |
| The upstream Workshop (Cloudflare OS) | Apache-2.0, the root [`LICENSE`](../../LICENSE) | Inherited from upstream. |
| SchoolOS additions (`packages/schoolos-*`, `packages/gatekeeper-schoolos`, `docs/schoolos`, and SchoolOS changes elsewhere) | Apache-2.0, the same `LICENSE` | Contributed under the repository's license. No SchoolOS package carries a different one. |
| Code extracted from PlayTrek | Apache-2.0, once extracted | The owner of both repositories approved the extraction (ADR-0006). Each extracted file starts with a provenance comment naming its PlayTrek source path and commit. |
| Standards content | The publisher's terms | Only where the terms permit redistribution, with the attribution they require. See [standards-licensing.md](standards-licensing.md). |
| Vendored Hall Monitor client and contracts | Not yet recorded | See [Third-party and vendored code](#third-party-and-vendored-code). |

Not done yet, and tracked as IF-00b in ADR-0011:

- No `package.json` has a `license` field. Every SchoolOS package should declare `Apache-2.0`.
- There is no root `NOTICE` file. Apache-2.0 section 4(d) requires one to be carried forward only if
  upstream ships one; SchoolOS should still add its own, listing the upstream project and the
  extracted and vendored sources.

## ClassBack

ClassBack (`gmackie/classback`) is a reference implementation of educational domain behaviour
(RFC 0002 §1). Its README shows an MIT badge, but its repository has no `LICENSE` file. A README
badge is not a license.

- **No ClassBack source may be copied into this repository** until ClassBack has an explicit
  `LICENSE` file and its dependencies and assets have been audited for compatible terms.
- Allowed meanwhile: reading ClassBack to learn domain concepts, operations and edge cases, and
  writing fixtures and adapters that are independently derived from those concepts in SchoolOS's
  own terms. Do not copy its tests, fixtures, schemas or OpenAPI text verbatim.
- Once the license exists, extraction follows the same rules as PlayTrek's (ADR-0006): a provenance
  comment on each file, and a check for secrets, internal hostnames and real people's data before
  any copy.

## Third-party and vendored code

- npm dependencies come from `pnpm-lock.yaml`. Adding one means checking that its license is
  compatible with Apache-2.0 distribution.
- `vendor/hall-monitor` holds the Hall Monitor client and contracts tarballs, pinned by SHA-256 and
  lockfile integrity ([its README](../../vendor/hall-monitor/README.md)). Neither tarball has a
  `license` field or a license file today. Before a release ships them, `gmackie/hall-monitor`
  needs an explicit license and the tarballs need to carry it. The same applies to a pinned Hall
  Monitor Worker build once releases include one (ADR-0007 note).
- Anything else vendored gets the same treatment: a pinned digest, the source it came from, and an
  explicit license.

## Release requirement (future)

Each release should ship a software bill of materials and a generated notices file covering every
dependency and vendored artifact in it. The release pipeline does not produce either yet; adding
them belongs with the NOTICE work above.
