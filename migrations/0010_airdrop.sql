-- ============================================================================
-- 0010_airdrop.sql — 0010_airdrop
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

CREATE TABLE IF NOT EXISTS airdrop_sessions (
  code              TEXT    PRIMARY KEY,
  status            TEXT    NOT NULL DEFAULT 'waiting',
  sender_token      TEXT    NOT NULL,
  receiver_token    TEXT,
  file_name         TEXT,
  file_size         INTEGER NOT NULL DEFAULT 0,
  file_type         TEXT,
  storage_backend   TEXT,
  storage_key       TEXT,
  storage_meta      TEXT,
  progress          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  linked_at         INTEGER,
  uploaded_at       INTEGER,
  completed_at      INTEGER,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_airdrop_sessions_expires
  ON airdrop_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_airdrop_sessions_created
  ON airdrop_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS airdrop_stats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL,
  role              TEXT    NOT NULL,
  is_guest          INTEGER NOT NULL DEFAULT 0,
  file_name         TEXT,
  file_size         INTEGER NOT NULL DEFAULT 0,
  outcome           TEXT    NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_airdrop_stats_created
  ON airdrop_stats(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_airdrop_stats_code
  ON airdrop_stats(code);
