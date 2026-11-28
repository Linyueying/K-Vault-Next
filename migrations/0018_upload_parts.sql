-- ============================================================================
-- 0018_upload_parts.sql — 0018_upload_parts
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

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id   TEXT    NOT NULL,
  chunk_index INTEGER NOT NULL,
  part_number INTEGER NOT NULL,
  etag        TEXT    NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_upload_parts_expires
  ON upload_parts(expires_at);
