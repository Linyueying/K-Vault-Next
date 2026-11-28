-- ============================================================================
-- 0005_tokens_pastes_audit.sql — 0005_tokens_pastes_audit
-- ============================================================================
--
-- ⚠️ 本文件由 scripts/gen-migrations.py 从 functions/utils/schema.js
--    **自动生成**，请勿手工编辑（改动会被覆盖）。
--
--    运行时并不需要本文件 —— Cloudflare Pages Functions 没有文件系统，
--    读不到 .sql；实际建表由 schema.js 的 ensureSchema() 在首次访问 D1 时
--    自动完成（懒迁移）。本文件仅用于人工排查与本地兜底。
--
--    唯一来源：functions/utils/schema.js
--    重新生成：python3 scripts/gen-migrations.py
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_tokens (
  token_id            TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL DEFAULT '',
  scopes              TEXT,
  policies            TEXT,
  secret_hash         TEXT    NOT NULL DEFAULT '',
  secret_salt         TEXT    NOT NULL DEFAULT '',
  secret_suffix       TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  expires_at          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT 0,
  rotated_at          INTEGER,
  updated_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_created_at
  ON api_tokens(created_at DESC);

CREATE TABLE IF NOT EXISTS token_stats (
  token_id            TEXT    PRIMARY KEY,
  request_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at        INTEGER NOT NULL DEFAULT 0,
  last_success_at     INTEGER NOT NULL DEFAULT 0,
  last_failure_at     INTEGER NOT NULL DEFAULT 0,
  last_operation      TEXT,
  last_client         TEXT,
  last_touch_at       INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER
);

CREATE TABLE IF NOT EXISTS pastes (
  paste_id            TEXT    PRIMARY KEY,
  content             TEXT    NOT NULL DEFAULT '',
  language            TEXT    NOT NULL DEFAULT 'text',
  size                INTEGER NOT NULL DEFAULT 0,
  password_hash       TEXT,
  password_salt       TEXT,
  expires_at          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pastes_created_at
  ON pastes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pastes_expires_at
  ON pastes(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event               TEXT    NOT NULL,
  token_id            TEXT,
  operation           TEXT,
  success             INTEGER NOT NULL DEFAULT 1,
  client              TEXT,
  detail              TEXT,
  timestamp           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp
  ON audit_logs(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_token
  ON audit_logs(token_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event
  ON audit_logs(event, timestamp DESC);
