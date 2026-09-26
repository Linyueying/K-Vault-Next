-- ============================================================================
-- 0002_folder_markers.sql — 文件夹标记纳入 files 表
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
--
-- 背景：0001 的 files 表只描述"文件"，但还有一类记录——**文件夹标记**
--       （KV 中的 `folder:<path>` 键，metadata.folderMarker=true）。
--       它让"空文件夹"也能在目录树里存在。
--
-- 为什么不做成独立的 folders 表：
--   文件夹标记与文件记录共享同一套生命周期（重命名目录时两者都要改
--   folder_path；删除目录时两者都要处理），且都需要按 folder_path 前缀查询。
--   放进同一张表，一次 UPDATE 就能同时覆盖"目录下的文件"与"目录的标记"。
--
-- 为什么用 is_folder 而不是复用 storage 列：
--   storage 表达的是"文件存在哪个后端"，把 'folder' 塞进去会污染取值域，
--   让所有 `storage = 'r2'` 这类查询必须额外排除文件夹行。
--   列级 DEFAULT 0 保证存量行自动获得 is_folder = 0，无需回填。
--
-- ⚠️ 注意：ALTER TABLE ADD COLUMN **不幂等**，重复执行会报
--    "duplicate column name"。运行时自动迁移靠 schema.js 里的 guard
--    （PRAGMA table_info 查列）保护；手动执行本文件时请确认只跑一次。
-- ============================================================================

ALTER TABLE files ADD COLUMN is_folder INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_files_is_folder
  ON files(is_folder)
  WHERE is_folder = 1;
