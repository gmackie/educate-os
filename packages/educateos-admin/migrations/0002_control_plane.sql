-- The control plane's operators, installations and slug reservations (SCHO-263). The hosted admin's
-- D1 becomes their system of record: they are imported once from educateos.io's ControlPlane
-- Durable Object (`POST /api/import/control-plane`), and the import can be run again to bring in
-- installations the guided install has made since. Still no student, staff or guardian records:
-- an installation is where a district runs and who installed it, never what is in it.

-- operators gains the operator's control-plane account ID (`acct_...`, the ID an opted-in
-- installation's registry record names) and a third role: `installer`, someone who signed in to
-- educateos.io to install a district but whom ADMINS doesn't list. ADMINS still decides who may use
-- this admin; signing in here replaces `installer` with the role ADMINS gives. SQLite can't change
-- a CHECK constraint in place, so the table is rebuilt. Nothing references it by foreign key.
CREATE TABLE operators_next (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer', 'installer')),
  account_id TEXT UNIQUE CHECK (account_id IS NULL OR account_id GLOB 'acct_?*'),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
INSERT INTO operators_next (sub, email, role, first_seen_at, last_seen_at)
  SELECT sub, email, role, first_seen_at, last_seen_at FROM operators;
DROP TABLE operators;
ALTER TABLE operators_next RENAME TO operators;

-- An installation made through educateos.io's guided install: the instance, the managed hostname it
-- serves at, the Cloudflare account it runs in and the release it was installed at. Each maps onto
-- one workspace (origin `https://<hostname>`); `workspace_id` is null only when the import found the
-- slug or origin already taken by another workspace, and says so in its report.
CREATE TABLE installations (
  instance_id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  operator_sub TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  cloudflare_account_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX installations_one_per_workspace ON installations (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX installations_by_operator ON installations (operator_sub);

-- The guided install's slug reservations, as last imported. educateos.io's Durable Object stays
-- authoritative for them, since its one writer is what makes a reservation atomic, and Clever
-- launches and the registry are still answered there. This copy is what the admin shows.
CREATE TABLE slug_reservations (
  slug TEXT PRIMARY KEY,
  operator_sub TEXT NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  instance_id TEXT NOT NULL UNIQUE,
  lease_until TEXT,
  imported_at TEXT NOT NULL
);
