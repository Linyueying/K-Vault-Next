-- ============================================================================
-- 0022_telegram_upload_guards.sql — Telegram 虚拟分片任务租约与终态
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

CREATE TABLE IF NOT EXISTS telegram_upload_guards (
  guard_key TEXT PRIMARY KEY,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  retain_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_upload_guards_retention
  ON telegram_upload_guards(retain_until);
