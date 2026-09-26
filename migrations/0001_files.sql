-- ============================================================================
-- 0001_files.sql — K-Vault 文件元数据表（D1）
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
-- 目标：把原本压在 KV 里的「文件记录 + 分享设置 + 下载计数 + 去重索引」
--       收敛到一张表，顺带消灭三个历史包袱：
--
--   1. `idxt:<裸ID>` 索引层      → D1 主键（id）天然是索引，直接删除
--   2. `dlc:<kvKey>` 独立计数键  → 表内字段 + 原子自增（不再 read-modify-write）
--   3. `sha_dup:<sha>` 去重索引  → content_sha 唯一索引（INSERT 冲突即命中）
--
-- 字段来源对照（原 KV metadata 字段 → 本表列）：
--   TimeStamp            → uploaded_at
--   fileName             → file_name
--   fileSize             → file_size
--   storageType/storage  → storage
--   r2Key / s3Key / ...  → storage_key
--   folderPath           → folder_path
--   ListType             → list_type
--   Label                → label
--   liked                → liked
--   shareSlug            → share_slug
--   sharePasswordSalt    → share_password_salt
--   sharePasswordHash    → share_password_hash
--   shareExpiresAt       → share_expires_at
--   shareMaxDownloads    → share_max_downloads
--   shareDownloadCount   → share_download_count
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
  id                    TEXT    PRIMARY KEY,
  kv_key                TEXT,

  storage               TEXT    NOT NULL,
  storage_key           TEXT,
  storage_extra         TEXT,

  file_name             TEXT    NOT NULL,
  file_size             INTEGER NOT NULL DEFAULT 0,
  mime                  TEXT,
  folder_path           TEXT,
  uploaded_at           INTEGER NOT NULL,

  content_sha           TEXT,

  list_type             TEXT    NOT NULL DEFAULT 'None',
  label                 TEXT    NOT NULL DEFAULT 'None',
  liked                 INTEGER NOT NULL DEFAULT 0,

  share_slug            TEXT,
  share_password_salt   TEXT,
  share_password_hash   TEXT,
  share_expires_at      INTEGER,
  share_max_downloads   INTEGER NOT NULL DEFAULT 0,
  share_download_count  INTEGER NOT NULL DEFAULT 0,

  created_at            INTEGER,
  updated_at            INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_sha
  ON files(content_sha)
  WHERE content_sha IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_share_slug
  ON files(share_slug)
  WHERE share_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
  ON files(uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_files_folder_time
  ON files(folder_path, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_files_storage
  ON files(storage);

CREATE INDEX IF NOT EXISTS idx_files_file_name
  ON files(file_name);
