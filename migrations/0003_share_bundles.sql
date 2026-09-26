-- ============================================================================
-- 0003_share_bundles.sql — 合集分享（bundle）纳入 D1
-- ============================================================================
--
-- 背景：`share-bundle.js` 把合集定义存在 KV 的 `bundle:<slug>` 键上
--       （metadata 里塞 fileIds / folderPath / 密码 / 计数），
--       再用 `bundle_slug:<slug>` 做存在性索引。
--
-- 为什么合集**不能**塞进 files 表：
--   files 表的主键是"文件 ID"，每条记录对应一个可下载的实体。
--   合集不是文件 —— 它是一个"链接"，指向若干文件（快照型）或
--   一个目录（实时型）。它的配额语义也不同：文件计数是"这个文件被下载几次"，
--   合集计数是"这个链接被打开下载几次"。同一个文件可以既在合集里、
--   又有自己的单文件分享，两条配额线各算各的。
--   强行塞进 files 表会让主键语义分裂、也让所有文件查询都得排除合集行。
--
-- 表结构映射（原 KV metadata → 列）：
--   slug            → slug（PRIMARY KEY）
--   type            → type        ('files' 快照 / 'folder' 实时)
--   fileIds         → 由 bundle_files 关联表承载（快照型）
--   folderPath      → folder_path（实时型）
--   includeSubfolders → include_subfolders
--   expiresAt       → expires_at
--   maxDownloads    → max_downloads
--   downloadCount   → download_count
--   passwordSalt    → password_salt
--   passwordHash    → password_hash
--   createdAt       → created_at
--   label           → label
--
-- 执行方式：
--   wrangler d1 execute k_vault --local  --file=./migrations/0003_share_bundles.sql
--   wrangler d1 execute k_vault --remote --file=./migrations/0003_share_bundles.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS bundles (
  -- slug 即主键：`bundle_slug:<slug>` 那层索引键随之消失
  -- （原先建立它是为了"一次 get 判断 slug 是否被占用"，
  --   而主键查询天然满足这个需求）。
  slug                TEXT    PRIMARY KEY,

  -- 'files'（文件快照，成员存在 bundle_files）/ 'folder'（实时目录分享）
  type                TEXT    NOT NULL DEFAULT 'files',

  -- 实时型（type='folder'）的目录定位
  folder_path         TEXT,
  include_subfolders  INTEGER NOT NULL DEFAULT 0,

  -- 配额
  expires_at          INTEGER NOT NULL DEFAULT 0,   -- 毫秒时间戳；0 = 永久
  max_downloads       INTEGER NOT NULL DEFAULT 0,   -- 0 = 不限次
  download_count      INTEGER NOT NULL DEFAULT 0,   -- 原子自增

  -- 访问口令
  password_salt       TEXT,
  password_hash       TEXT,

  label               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER
);

-- ============================================================================
-- 快照型合集的成员列表
-- ============================================================================
--
-- 拆成独立表而不是在 bundles 里塞 JSON 数组，理由：
--   · 成员顺序需要稳定保留（分享页按加入顺序展示），用 position 列表达
--   · 校验"这个文件是否在某个合集里"可走索引，不必反序列化整行
--   · fileIds 可能上百个，JSON 列会让每次读写都搬运整块字符串
CREATE TABLE IF NOT EXISTS bundle_files (
  bundle_slug         TEXT    NOT NULL,             -- 指向 bundles.slug
  position            INTEGER NOT NULL DEFAULT 0,   -- 加入顺序
  file_id             TEXT    NOT NULL,             -- 裸文件 ID
  PRIMARY KEY (bundle_slug, file_id)
);

-- ============================================================================
-- 索引
-- ============================================================================

-- 后台列表：按创建时间倒序（替代 `bundle_slug:` 前缀枚举）
CREATE INDEX IF NOT EXISTS idx_bundles_created_at
  ON bundles(created_at DESC);

-- 按类型筛选（快照 vs 实时）
CREATE INDEX IF NOT EXISTS idx_bundles_type
  ON bundles(type);

-- 成员按合集取回，保持加入顺序
CREATE INDEX IF NOT EXISTS idx_bundle_files_position
  ON bundle_files(bundle_slug, position);

-- 反查：某个文件被哪些合集引用（删除文件时用于提示）
CREATE INDEX IF NOT EXISTS idx_bundle_files_file_id
  ON bundle_files(file_id);
