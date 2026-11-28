-- ============================================================================
-- 0020_trash_indexes.sql — 回收站列表与在库文件去重索引
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

CREATE INDEX IF NOT EXISTS idx_files_trashed_at ON files(trashed_at DESC)
    WHERE trashed_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_active_content_sha ON files(content_sha)
    WHERE content_sha IS NOT NULL AND trashed_at IS NULL;

DROP INDEX IF EXISTS idx_files_content_sha;
