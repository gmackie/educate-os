-- The EducateOS admin's D1 (SCHO-263), the same schema in both editions.
--
-- What is here: the operators who sign in to this admin, the workspaces (districts) it manages, the
-- Ed25519 keys it signs ops requests with, cached analytics aggregates and an audit log of what
-- operators asked for. What is never here: student, staff or guardian records. Directory and device
-- data pass through from the district to the operator's browser and are not written down. The only
-- personal data is the operators' own email, in `operators`; __tests__/schema.test.ts fails if a
-- column named like personal data appears in any other table.

-- People who may use this admin, keyed by their Cloudflare Access subject. Who is allowed in is the
-- ADMINS var; this table records who has signed in and with which role.
CREATE TABLE operators (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- The districts this admin manages. `origin` is the district's one origin (ADR-0014): its ops API
-- is `<origin>/api/ops/*`. `edition` is how the district is run: hosted by EducateOS, or self-hosted.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  origin TEXT NOT NULL UNIQUE,
  edition TEXT NOT NULL CHECK (edition IN ('hosted', 'oss')),
  enrolled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'removed'))
);

-- The admin's signing key for each workspace. The private key is AES-GCM encrypted with the
-- ADMIN_KEY_ENCRYPTION_KEY secret, bound to its workspace and key ID. A retired key stays for the
-- record but is never used to sign.
CREATE TABLE ops_keys (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (workspace_id, key_id)
);
CREATE UNIQUE INDEX ops_keys_one_active ON ops_keys (workspace_id) WHERE retired_at IS NULL;

-- The last analytics report per workspace and window: aggregates only, as /api/ops/analytics
-- returns them (validated against OpsAnalyticsResponse before they are stored).
CREATE TABLE analytics_snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  time_range TEXT NOT NULL CHECK (time_range IN ('24h', '7d', '30d')),
  aggregates_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, time_range)
);

-- Who asked for what. `target` is an opaque identifier (a principal ID such as prn_..., a device
-- ID, a version), never a name. The district records the same command in its own audit log.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_sub TEXT NOT NULL,
  workspace_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX audit_log_by_time ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_by_workspace ON audit_log (workspace_id, at DESC, id DESC);
