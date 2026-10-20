# ADR-0006: Reusing PlayTrek code

- Status: Accepted
- Date: 2026-10-20 (revised the same day when the owner approved reuse)
- Issue: SCHO-1

## Context

PlayTrek (`gmackie/playtrek`, private) has CASE, OneRoster and LTI code, an evaluator registry and
standards seeds that SchoolOS needs. This repository is public, so anything copied into it is
published.

## Decision

The owner of both repositories has approved reusing PlayTrek code in SchoolOS (option (a) of the
roadmap: deliberately open-source the extracted modules).

1. Reuse happens by **extraction**. A module is copied into a `@schoolos/*` package, adapted to the
   SchoolOS contracts (`@schoolos/contracts` IDs, principals and scopes) and to Workers runtimes. It
   is not imported from PlayTrek, and it carries no dependency on PlayTrek's database.
2. Each extracted file starts with a provenance comment naming its PlayTrek source path and commit.
   Later fixes can then be carried in either direction on purpose.
3. Before any copy, check for secrets, credentials, internal hostnames and customer or student data.
   None of these may come across.
4. Standards **content** keeps its publisher's license and attribution, wherever it came from. Text
   whose license does not allow redistribution stays out of the repository. Instead it ships as a
   pointer the district imports through CASE. SchoolOS never generates standards text that looks
   official.

## Consequences

- C01 (registry schemas), A03/A04 (OneRoster), I01/I02 (LTI) and E02 (evaluators) may start from the
  PlayTrek implementations.
- Extracted code is reviewed like any other SchoolOS code. The fact that it worked in PlayTrek is
  not evidence that it is correct here.
