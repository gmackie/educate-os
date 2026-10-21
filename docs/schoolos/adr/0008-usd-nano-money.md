# ADR-0008: AI spend is counted in integer nanodollars

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-111

## Context

`@schoolos/ai-governance` counted AI spend in whole cents (`Cents`), and the kernel's per-chat cost
total is a floating-point number of dollars. One Hall Monitor moderation check on Clef-flash costs
about $0.000038 (38,000 nanodollars per 1,000 input tokens at the 2026-10-20 list rate), so
rounding to cents makes moderation spend disappear from budgets and reports.

## Decision

1. AI spend is `UsdNano`: an integer count of 10⁻⁹ US dollars. On the wire and in storage it is a
   decimal integer string; arithmetic uses `bigint`. Floating-point numbers are never used to debit
   or report money. This is the same representation as `@gmacko/hall-monitor-contracts`, so
   receipts flow into the ledger unchanged.
2. Price rates are rational (nanodollars per unit count) and pinned to an immutable price book. When
   a cost is not a whole number of nanodollars, it is rounded **up**.
3. Rounding to cents happens only for display and invoices, and it rounds up.
4. Admin-entered caps (for example the policy floor's `aiMonthlyCapCentsPerPrincipal`) stay in cents
   and are converted at the ledger boundary.
5. Stored ledger entries carry a schema version. Version 1 entries with `*Cents` fields are upgraded
   when they are read.

## Consequences

- Sub-cent moderation spend accumulates exactly: 1,000 checks at 38,000 nanodollars total 3.8¢.
- Usage with no reported cost is recorded as an unknown liability, never as $0.
- Commerce money (`@schoolos/commerce`) stays in cents, because invoices are cents. It rounds the
  fleet heartbeat's AI spend up to the cent where it prices an overage line.

## Amendment (SCHO-119)

- `UsdNano` and its helpers live in `@schoolos/contracts` (`src/money.ts`) and are re-exported by
  `@schoolos/ai-governance`. Assessment reports and the fleet heartbeat carry AI cost too, and
  `@schoolos/fleet` (a wire format the root also reads) should not depend on the district's ledger
  package; the contracts are the shared, zod-only vocabulary ADR-0002 provides for exactly this.
- `assessment-ai`, `assessment-ci` and `fleet` hold AI cost as `*UsdNano` fields. The assessment
  model port is typed by the governor's own request and outcome types.
- The fleet heartbeat sends `aggregateAiSpendUsdNano`. The root still accepts a heartbeat carrying
  the earlier `aggregateAiSpendCents` and reads it as nanodollars, so instances can upgrade in any
  order; a heartbeat carrying both is refused.

## Note (2026-10-21, ADR-0011)

`@schoolos/commerce` and `@schoolos/fleet` are optional, non-default reference code
([ADR-0011](0011-open-source-charter-and-module-ownership.md)). The consequence about commerce
overage pricing and the amendment's fleet heartbeat bullets apply only where an organization uses
those packages. The default runtime prices no overage and sends no heartbeat. The rest of this ADR,
`UsdNano` in the ledger, assessment reports and the AI call guard, is unchanged.
