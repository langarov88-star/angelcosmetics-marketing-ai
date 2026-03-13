-- Angel Cosmetics Marketing AI — Initial D1 Schema
-- Migration: 0001_initial_schema

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'marketing_manager', 'marketing_analyst')),
  password_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login  INTEGER
);

CREATE INDEX idx_users_email ON users(email);

-- ─── Workflows ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,  -- 'weekly_email', 'product_launch', 'monthly_report', etc.
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled'))
                DEFAULT 'in_progress',
  triggered_by TEXT NOT NULL,  -- 'cron', 'dashboard', 'api'
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  metadata     TEXT NOT NULL DEFAULT '{}'  -- JSON blob
);

CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_created_at ON workflows(created_at DESC);

-- ─── Campaigns ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  agent       TEXT NOT NULL CHECK (agent IN ('email', 'google-ads', 'meta', 'content', 'creative', 'analytics')),
  type        TEXT NOT NULL CHECK (type IN ('email', 'google_ads', 'meta', 'content', 'creative')),
  status      TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'active', 'paused', 'archived'))
               DEFAULT 'draft',
  external_id TEXT,  -- mailchimp id, google ads campaign resource name, meta campaign id, etc.
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT NOT NULL DEFAULT '{}'  -- JSON blob: ad copy, keywords, assets, etc.
);

CREATE INDEX idx_campaigns_workflow_id ON campaigns(workflow_id);
CREATE INDEX idx_campaigns_agent ON campaigns(agent);
CREATE INDEX idx_campaigns_status ON campaigns(status);

-- ─── Approvals ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  campaign_id  TEXT REFERENCES campaigns(id),
  agent        TEXT NOT NULL,
  action_type  TEXT NOT NULL CHECK (action_type IN (
                 'send_email', 'enable_google_campaign', 'activate_meta_campaign',
                 'publish_content', 'increase_budget', 'create_audience'
               )),
  payload      TEXT NOT NULL,  -- JSON: exact API call params to execute on approval
  status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
                DEFAULT 'pending',
  requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at   INTEGER,
  decided_by   TEXT REFERENCES users(id),
  expires_at   INTEGER NOT NULL,  -- requested_at + 172800 (48h)
  audit_note   TEXT
);

CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_approvals_workflow_id ON approvals(workflow_id);
CREATE INDEX idx_approvals_expires_at ON approvals(expires_at);

-- ─── Audit Log (immutable) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'expired')),
  timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address  TEXT,
  user_agent  TEXT,
  note        TEXT
);

-- No UPDATE or DELETE allowed on audit_log — enforced at application level

CREATE INDEX idx_audit_log_approval_id ON audit_log(approval_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);

-- ─── Agent Configs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_configs (
  agent        TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by   TEXT REFERENCES users(id),
  PRIMARY KEY (agent, config_key)
);

-- ─── Asset Manifest ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  campaign_id TEXT REFERENCES campaigns(id),
  r2_key      TEXT NOT NULL UNIQUE,  -- R2 object key
  asset_type  TEXT NOT NULL CHECK (asset_type IN ('image', 'email_html', 'content_md', 'report_pdf', 'report_csv')),
  alt_text    TEXT,
  dimensions  TEXT,  -- e.g. '1024x1024'
  format      TEXT,  -- '1:1', '9:16', etc.
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_assets_workflow_id ON assets(workflow_id);
CREATE INDEX idx_assets_campaign_id ON assets(campaign_id);
