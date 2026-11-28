-- ============================================================================
-- 0023_webdav_mount.sql — 0023_webdav_mount
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

CREATE TABLE IF NOT EXISTS webdav_mount (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  root_path TEXT NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS webdav_mount_on_folder_delete
  AFTER DELETE ON files
  WHEN OLD.is_folder = 1
  BEGIN
    UPDATE webdav_mount SET invalidated = 1
      WHERE id = 1 AND root_path = OLD.folder_path AND invalidated = 0;
  END;

CREATE TRIGGER IF NOT EXISTS webdav_mount_on_folder_change
  AFTER UPDATE OF folder_path, is_folder, trashed_at ON files
  WHEN OLD.is_folder = 1 AND (OLD.folder_path IS NOT NEW.folder_path OR NEW.is_folder != 1 OR NEW.trashed_at IS NOT NULL)
  BEGIN
    UPDATE webdav_mount SET invalidated = 1
      WHERE id = 1 AND root_path = OLD.folder_path AND invalidated = 0;
  END;
