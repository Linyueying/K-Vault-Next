-- ============================================================================
-- 0001_files.sql — K-Vault 文件元数据表（D1）
-- ============================================================================
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
--
-- 执行方式：
--   wrangler d1 execute k_vault --local  --file=./migrations/0001_files.sql
--   wrangler d1 execute k_vault --remote --file=./migrations/0001_files.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
  -- 主键 = 裸 ID（即原 idxt: 索引指向的 indexId）。
  -- 带前缀的 kvKey 无法作为主键语义（同一文件可能有两种查法），
  -- 故用裸 ID；kv_key 列保留原始 key 供兼容回查。
  id                    TEXT    PRIMARY KEY,
  kv_key                TEXT,                      -- 原 KV key（如 r2:xxx.png），兼容保留

  -- 存储定位
  storage               TEXT    NOT NULL,          -- r2 / s3 / telegram / discord / huggingface / webdav / github
  storage_key           TEXT,                      -- r2Key / s3Key / hfPath / webdavPath / githubStorageKey ...
  -- 存储特有的附加定位信息（discordChannelId 等）统一塞 JSON，避免为每家加列
  storage_extra         TEXT,                      -- JSON 字符串，可空

  -- 文件属性
  file_name             TEXT    NOT NULL,
  file_size             INTEGER NOT NULL DEFAULT 0,
  mime                  TEXT,
  folder_path           TEXT,                      -- 归一化后的 '/' 分隔路径，可空
  uploaded_at           INTEGER NOT NULL,          -- 原 TimeStamp（毫秒）

  -- 去重索引：内容 SHA256（原 sha_dup:<sha> 的键）。
  -- 用【部分唯一索引】而非列级 UNIQUE —— 因为绝大多数文件不带 hash，
  -- 列级 UNIQUE 会让多条 NULL 记录互相冲突（SQLite 中 NULL 不参与唯一，
  -- 但显式部分索引语义更清晰、也更省索引体积）。
  content_sha           TEXT,

  -- 管理标记
  list_type             TEXT    NOT NULL DEFAULT 'None',   -- None / block / white
  label                 TEXT    NOT NULL DEFAULT 'None',   -- None / adult / ...
  liked                 INTEGER NOT NULL DEFAULT 0,

  -- 分享设置
  share_slug            TEXT,                      -- 自定义短链标识
  share_password_salt   TEXT,
  share_password_hash   TEXT,
  share_expires_at      INTEGER,                   -- 毫秒时间戳；0/NULL = 不过期
  share_max_downloads   INTEGER NOT NULL DEFAULT 0,-- 0 = 不限次
  share_download_count  INTEGER NOT NULL DEFAULT 0,-- 原子自增，绝不 read-modify-write

  -- 审计
  created_at            INTEGER,                   -- 首次入库时间（与 uploaded_at 可能不同）
  updated_at            INTEGER                    -- 最后一次写入时间
);

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------

-- 去重：content_sha 唯一（仅对有 hash 的行生效）
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_sha
  ON files(content_sha)
  WHERE content_sha IS NOT NULL;

-- 短链标识唯一（仅对有 slug 的行生效）
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_share_slug
  ON files(share_slug)
  WHERE share_slug IS NOT NULL;

-- 列表主查询：按时间倒序分页（替代 KV 扫前缀 + cursor）
CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
  ON files(uploaded_at DESC);

-- 列表 + 文件夹过滤：后台按目录翻页
CREATE INDEX IF NOT EXISTS idx_files_folder_time
  ON files(folder_path, uploaded_at DESC);

-- 按存储类型统计 / 筛选
CREATE INDEX IF NOT EXISTS idx_files_storage
  ON files(storage);

-- 按文件名搜索（LIKE 'xxx%' 前缀匹配可用索引；全模糊不受益，但不会更差）
CREATE INDEX IF NOT EXISTS idx_files_file_name
  ON files(file_name);
