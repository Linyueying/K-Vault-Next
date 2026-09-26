-- ============================================================================
-- 0003_share_bundles.sql — 合集分享（bundle）纳入 D1
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
-- 背景：`share-bundle.js` 把合集定义存在 KV 的 `bundle:<slug>` 键上，
--       再用 `bundle_slug:<slug>` 做存在性索引。
--
-- 为什么合集**不能**塞进 files 表：
--   files 的主键是"文件 ID"，每条记录对应一个可下载的实体。
--   合集不是文件——它是一个"链接"，指向若干文件（快照型）或一个目录
--   （实时型）。配额语义也不同：文件计数是"这个文件被下载几次"，
--   合集计数是"这个链接被打开几次"。同一文件可以既在合集里、
--   又有自己的单文件分享，两条配额线各算各的。
--
-- 表结构映射（原 KV metadata → 列）：
--   slug → slug（PRIMARY KEY）    type → type
--   fileIds → bundle_files 关联表  folderPath → folder_path
--   includeSubfolders → include_subfolders
--   expiresAt → expires_at        maxDownloads → max_downloads
--   downloadCount → download_count
--   passwordSalt → password_salt  passwordHash → password_hash
--   createdAt → created_at        label → label
--
-- 成员拆成独立表而非 JSON 数组：成员顺序需稳定保留（分享页按加入顺序
-- 展示），用 position 列表达；且需支持反查"某文件被哪些合集引用"。
-- ============================================================================

CREATE TABLE IF NOT EXISTS bundles (
  slug                TEXT    PRIMARY KEY,
  type                TEXT    NOT NULL DEFAULT 'files',
  folder_path         TEXT,
  include_subfolders  INTEGER NOT NULL DEFAULT 0,
  expires_at          INTEGER NOT NULL DEFAULT 0,
  max_downloads       INTEGER NOT NULL DEFAULT 0,
  download_count      INTEGER NOT NULL DEFAULT 0,
  password_salt       TEXT,
  password_hash       TEXT,
  label               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER
);

CREATE TABLE IF NOT EXISTS bundle_files (
  bundle_slug         TEXT    NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0,
  file_id             TEXT    NOT NULL,
  PRIMARY KEY (bundle_slug, file_id)
);

CREATE INDEX IF NOT EXISTS idx_bundles_created_at
  ON bundles(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bundles_type
  ON bundles(type);

CREATE INDEX IF NOT EXISTS idx_bundle_files_position
  ON bundle_files(bundle_slug, position);

CREATE INDEX IF NOT EXISTS idx_bundle_files_file_id
  ON bundle_files(file_id);
