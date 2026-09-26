-- ============================================================================
-- 0002_folder_markers.sql — 文件夹标记纳入 files 表
-- ============================================================================
--
-- 背景：0001 的 files 表只描述"文件"，但 K-Vault 里还有一类记录 ——
--       **文件夹标记**（KV 中的 `folder:<path>` 键，metadata.folderMarker=true）。
--       它的作用是让"空文件夹"也能在目录树里存在（无标记时只有含文件的目录
--       才会被推导出来）。
--
-- 为什么不做成独立的 folders 表：
--   文件夹标记与文件记录共享同一套生命周期（重命名目录时两者都要改
--   folder_path；删除目录时两者都要处理），且都需要按 folder_path 前缀查询。
--   放进同一张表，一次 `UPDATE ... WHERE folder_path = ?` 就能同时覆盖
--   "该目录下的文件"和"该目录的标记"，无需跨表事务。
--
-- 为什么用 is_folder 而不是复用 storage 列：
--   storage 列表达的是"文件存在哪个后端"（r2/s3/telegram...），
--   把 'folder' 塞进去会污染 storage 的取值域，也让所有 `storage = 'r2'`
--   这类查询必须额外排除文件夹行。用独立布尔列语义清晰，
--   配合部分索引（WHERE is_folder = 1）开销可忽略。
--
-- 执行方式：
--   wrangler d1 execute k_vault --local  --file=./migrations/0002_folder_markers.sql
--   wrangler d1 execute k_vault --remote --file=./migrations/0002_folder_markers.sql
-- ============================================================================

-- 文件夹标记行：is_folder = 1
-- 文件行：          is_folder = 0（默认）
--
-- 兼容性：列级 DEFAULT 0 保证 0001 建表时写入的存量行自动获得 is_folder = 0
-- （SQLite 的 ALTER TABLE ADD COLUMN 会为存量行填充默认值，无需回填 UPDATE）。
ALTER TABLE files ADD COLUMN is_folder INTEGER NOT NULL DEFAULT 0;

-- 文件夹树查询：只取标记行，按路径排序
CREATE INDEX IF NOT EXISTS idx_files_is_folder
  ON files(is_folder)
  WHERE is_folder = 1;

-- 目录前缀查询（重命名/删除时用 LIKE 'path/%' 或 = 'path'）
-- 已有 idx_files_folder_time (folder_path, uploaded_at DESC) 覆盖，
-- 此处不重复建索引。
