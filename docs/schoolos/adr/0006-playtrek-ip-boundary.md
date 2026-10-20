# ADR-0006: PlayTrek IP boundary

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-1. Extraction decision is due before C01 and I01.

## Context

PlayTrek (`gmackie/playtrek`, private) has CASE, OneRoster and LTI code and standards seeds that
SchoolOS could reuse. This repository is public.

## Decision

1. No PlayTrek source, seed data or test fixture is copied into this repository until its owner
   chooses one of these paths:
   - (a) open-source specific modules deliberately;
   - (b) ship private packages with documented deployment rights;
   - (c) rewrite against the public 1EdTech specifications.
2. Until then, SchoolOS contracts are written from public specifications (CASE 1.1, OneRoster 1.2,
   LTI 1.3) and from this repository's own code.
3. Standards content keeps its publisher's provenance and license. SchoolOS never generates
   standards text that looks official.

## Consequences

`@schoolos/contracts` v1 contains no PlayTrek-derived code. C01 (shared registry schemas) is blocked
on this decision.
