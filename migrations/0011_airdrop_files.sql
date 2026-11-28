-- ============================================================================
-- 0011_airdrop_files.sql — 0011_airdrop_files
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

ALTER TABLE airdrop_sessions ADD COLUMN files_json   TEXT;

ALTER TABLE airdrop_sessions ADD COLUMN file_count    INTEGER NOT NULL DEFAULT 0;

ALTER TABLE airdrop_sessions ADD COLUMN total_size    INTEGER NOT NULL DEFAULT 0;
