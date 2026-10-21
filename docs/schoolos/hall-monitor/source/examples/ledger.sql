-- Proposed SQLite-based ledger storage for a billing owner.
-- This is a FOUNDATION / ILLUSTRATIVE schema, not a production-ready migration.
-- Use a single tenant's authoritative Budget DO for atomic funded-spend changes.
-- Support longer-lived derived reporting in D1 without making it the transaction authority.

CREATE TABLE price_books (
    id TEXT PRIMARY KEY,
    effective_at_utc TEXT NOT NULL,
    reviewed_at_utc TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    frozen INTEGER NOT NULL DEFAULT 1 CHECK (frozen IN (0,1))
);

CREATE TABLE price_rates (
    id TEXT PRIMARY KEY,
    price_book_id TEXT NOT NULL REFERENCES price_books(id),
    provider_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    unit TEXT NOT NULL,
    usd_nano_numerator TEXT NOT NULL,
    denominator TEXT NOT NULL,
    effective_from_utc TEXT NOT NULL,
    effective_to_utc TEXT,
    source_url TEXT NOT NULL,
    UNIQUE (price_book_id, provider_id, sku, unit, effective_from_utc)
);

CREATE TABLE funding_pools (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    parent_pool_id TEXT REFERENCES funding_pools(id),
    purpose TEXT NOT NULL,
    funding_source TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    period_start_utc TEXT NOT NULL,
    period_end_utc TEXT NOT NULL,
    budget_usd_nano INTEGER NOT NULL CHECK (budget_usd_nano >= 0),
    reserved_usd_nano INTEGER NOT NULL DEFAULT 0 CHECK (reserved_usd_nano >= 0),
    settled_usd_nano INTEGER NOT NULL DEFAULT 0 CHECK (settled_usd_nano >= 0),
    revision INTEGER NOT NULL DEFAULT 0,
    CHECK (reserved_usd_nano + settled_usd_nano >= 0)
);
CREATE INDEX idx_funding_pools_tenant_period ON funding_pools(tenant_id, period_start_utc, purpose);

CREATE TABLE spend_reservations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    pool_id TEXT NOT NULL REFERENCES funding_pools(id),
    idempotency_key TEXT NOT NULL,
    held_usd_nano INTEGER NOT NULL CHECK (held_usd_nano >= 0),
    settled_usd_nano INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'released', 'unknown-liability')),
    created_at_utc TEXT NOT NULL,
    expires_at_utc TEXT NOT NULL,
    UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_reservations_active ON spend_reservations(tenant_id, state, expires_at_utc);

CREATE TABLE usage_events (
    event_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    billing_owner_id TEXT NOT NULL,
    source_product TEXT NOT NULL,
    service_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    parent_request_id TEXT,
    attempt_index INTEGER NOT NULL,
    principal_key TEXT,
    cost_center_id TEXT NOT NULL,
    provider_id TEXT,
    model_id TEXT,
    sku TEXT NOT NULL,
    price_book_id TEXT NOT NULL REFERENCES price_books(id),
    provider_request_id TEXT,
    ai_gateway_log_id TEXT,
    usage_json TEXT NOT NULL, -- only quantities / units, no text content
    cost_state TEXT NOT NULL CHECK (cost_state IN (
      'estimated','provider-reported','vendor-reconciled','adjusted','unknown'
    )),
    gross_usd_nano INTEGER,
    source_receipt_digest TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    measured_at_utc TEXT NOT NULL,
    ingested_at_utc TEXT NOT NULL,
    UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_usage_owner_period ON usage_events(tenant_id, measured_at_utc, cost_center_id);
CREATE INDEX idx_usage_provider_request ON usage_events(provider_id, provider_request_id);

CREATE TABLE invoice_lines (
    id TEXT PRIMARY KEY,
    billing_owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    period_start_utc TEXT NOT NULL,
    period_end_utc TEXT NOT NULL,
    sku TEXT NOT NULL,
    units_json TEXT,
    amount_usd_nano INTEGER NOT NULL,
    source_digest TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    UNIQUE (provider_id, account_id, invoice_number, id)
);

CREATE TABLE cost_allocations (
    id TEXT PRIMARY KEY,
    invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id),
    tenant_id TEXT NOT NULL,
    cost_center_id TEXT NOT NULL,
    method TEXT NOT NULL, -- gross_pro_rata | reserved_capacity | contractual_fixed
    allocated_usd_nano INTEGER NOT NULL,
    calculation_revision TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);

CREATE TABLE financial_adjustments (
    id TEXT PRIMARY KEY,
    source_event_id TEXT REFERENCES usage_events(event_id),
    source_invoice_line_id TEXT REFERENCES invoice_lines(id),
    tenant_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    adjustment_usd_nano INTEGER NOT NULL,
    created_at_utc TEXT NOT NULL,
    created_by TEXT NOT NULL
);

-- Invariants enforced at transactional service layer, not all expressible in SQLite:
-- 1) Atomic ancestor budgeting, reserve/settle/release within same authoritative DO.
-- 2) No parent pool overspend due to concurrent child reservations.
-- 3) Unused reservation returned exactly once.
-- 4) Unknown provider cost remains liable until independently reconciled.
-- 5) Actual Cloudflare account included usage/allowances applied exactly once.
-- 6) One provider retry attempt produces a distinct usage event even with same parent request.
-- 7) No historical price-book or settled event mutation; use adjustments.
