/**
 * D1 schema 定义与运行时自动迁移（**SQL 的唯一来源**）。
 *
 * ============================================================================
 * 为什么 SQL 放在 JS 里，而不是 migrations/*.sql
 * ============================================================================
 *
 * Cloudflare Pages Functions 运行在 Workers 环境，**没有文件系统** ——
 * 无法 `readFileSync('./migrations/0001.sql')`。想要「部署即自动建表」，
 * DDL 就必须以 JS 字符串常量的形式打进 bundle。
 *
 * 于是面临一个选择：
 *   A. SQL 在 .sql 和 .js 各写一份  → 改动时容易忘同步，两处漂移
 *   B. 只留 .sql，JS 读不到          → 自动迁移根本做不了
 *   C. **只留 .js，.sql 由脚本生成** → 单一来源，不漂移 ✅
 *
 * 本文件是 C 方案。`migrations/*.sql` 由 `scripts/gen-migrations.mjs` 从
 * 这里生成，**不要手工编辑**（会被覆盖）；它们只用于人工排查与本地
 * `wrangler d1 execute` 兜底。
 *
 * ============================================================================
 * 幂等性设计
 * ============================================================================
 *
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 天然幂等。
 * 但 **`ALTER TABLE ADD COLUMN` 不幂等** —— 重复执行会抛
 * `duplicate column name: xxx`。所以每个迁移除了 `statements`（执行的 SQL）
 * 还带一个 `guard`（前置检查）：
 *
 *   { id, guard: {type:'column', table:'files', column:'is_folder'}, statements: [...] }
 *
 * `column` 型 guard 用 `PRAGMA table_info()` 查列是否已存在，已存在则跳过。
 * 这样迁移表可以在任何状态下安全地重复执行。
 *
 * ============================================================================
 * 执行时机
 * ============================================================================
 *
 * 懒迁移：数据层首次访问 D1 时调用 `ensureSchema(env)`。
 *   · 同一次 isolate 内只真正跑一次（module-level 缓存）
 *   · isolate 被回收后重建会重新检查 —— 这正是我们想要的，
 *     因为新部署的代码可能带了新迁移
 *   · 失败不缓存，下次请求会重试
 *
 * @module schema
 */

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function now() {
  return Date.now();
}

// ============================================================================
// Migration 0001 — files 表
// ============================================================================

/**
 * 0001 的 DDL。
 *
 * 字段来源对照（原 KV metadata 字段 → 本表列）见迁移说明。
 * 这里只保留 DDL，注释精简——完整设计理由在生成的 .sql 文件里。
 */
const M0001_FILES = [
  `CREATE TABLE IF NOT EXISTS files (
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
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_sha
  ON files(content_sha)
  WHERE content_sha IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_share_slug
  ON files(share_slug)
  WHERE share_slug IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
  ON files(uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_files_folder_time
  ON files(folder_path, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_files_storage
  ON files(storage)`,
  `CREATE INDEX IF NOT EXISTS idx_files_file_name
  ON files(file_name)`,
];

// ============================================================================
// Migration 0002 — 文件夹标记（is_folder 列）
// ============================================================================

const M0002_FOLDER_MARKERS = [
  // ⚠️ 这条 ALTER 不幂等，靠 guard 保护（见文件头说明）
  `ALTER TABLE files ADD COLUMN is_folder INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_files_is_folder
  ON files(is_folder)
  WHERE is_folder = 1`,
];

// ============================================================================
// Migration 0003 — 合集分享
// ============================================================================

const M0003_SHARE_BUNDLES = [
  `CREATE TABLE IF NOT EXISTS bundles (
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
)`,
  `CREATE TABLE IF NOT EXISTS bundle_files (
  bundle_slug         TEXT    NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0,
  file_id             TEXT    NOT NULL,
  PRIMARY KEY (bundle_slug, file_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_bundles_created_at
  ON bundles(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bundles_type
  ON bundles(type)`,
  `CREATE INDEX IF NOT EXISTS idx_bundle_files_position
  ON bundle_files(bundle_slug, position)`,
  `CREATE INDEX IF NOT EXISTS idx_bundle_files_file_id
  ON bundle_files(file_id)`,
];

// ============================================================================
// 迁移清单（**顺序即执行顺序**）
// ============================================================================

/**
 * 每个迁移：
 *   id         - 版本标识，写入 schema_migrations 表
 *   guard      - 可选前置检查；不满足则跳过（用于不幂等的语句）
 *   statements - 要执行的 SQL 数组
 *
 * guard 目前支持：
 *   { type: 'column', table, column }  —— 列不存在才执行
 */
export const MIGRATIONS = [
  { id: '0001_files', statements: M0001_FILES },
  {
    id: '0002_folder_markers',
    guard: { type: 'column', table: 'files', column: 'is_folder' },
    statements: M0002_FOLDER_MARKERS,
  },
  { id: '0003_share_bundles', statements: M0003_SHARE_BUNDLES },
];

// ============================================================================
// 运行时自动迁移
// ============================================================================

/**
 * module-level 缓存：同一次 isolate 内只真正跑一次。
 *
 * 注意缓存的是**这个 isolate 实例**的判断结果。isolate 被回收后重建时
 * 变量复位，会重新检查一遍 —— 这是期望行为，因为新部署可能带来新迁移。
 *
 * 失败时**不**缓存（置回 null），让下次请求重试。
 */
let schemaReady = null;

/** 并发去重：多个请求同时进来时只让一个真正执行。 */
let schemaInFlight = null;

/**
 * 确保 schema 已就绪。D1 未绑定时立即返回（调用方本就会回落 KV）。
 *
 * 这是**懒迁移**入口：应在数据层任何真实查询之前调用。
 *
 * @param {any} env
 * @returns {Promise<{ok: boolean, disabled?: boolean, applied?: string[], skipped?: boolean}>}
 */
export async function ensureSchema(env) {
  if (!isD1Enabled(env)) return { ok: false, disabled: true };
  if (schemaReady) return { ok: true, skipped: true };

  // 并发去重：同 isolate 内多个请求同时触发时复用同一个 Promise
  if (schemaInFlight) return schemaInFlight;

  schemaInFlight = runMigrations(env)
    .then((result) => {
      if (result.ok) schemaReady = true;
      return result;
    })
    .finally(() => {
      schemaInFlight = null;
    });

  return schemaInFlight;
}

/**
 * 实际执行迁移。
 *
 * 用独立的 `schema_migrations` 表记录已执行版本，这样：
 *   · 已执行的跳过（省掉重复 DDL 的开销）
 *   · 新部署带来的新迁移会被自动应用
 *   · 即使 meta 表丢失（极罕见）也有 guard / IF NOT EXISTS 兜底
 *
 * @param {any} env
 * @returns {Promise<{ok: boolean, applied?: string[], error?: string}>}
 */
async function runMigrations(env) {
  const applied = [];

  try {
    // meta 表本身也要幂等创建（必须先于版本查询建好）
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
        version     TEXT    PRIMARY KEY,
        applied_at  INTEGER
      )`
    ).run();

    const done = await env.DB.prepare(`SELECT version FROM ${META_TABLE}`).all();
    const doneSet = new Set((done?.results || []).map((r) => String(r.version)));

    for (const migration of MIGRATIONS) {
      if (doneSet.has(migration.id)) continue;

      // guard：不幂等的语句需先确认前置条件
      if (migration.guard && !(await guardAllows(env, migration.guard))) {
        // 条件已满足 → 说明这条迁移实际已生效，只记版本不执行
        await markApplied(env, migration.id);
        continue;
      }

      for (const sql of migration.statements) {
        await env.DB.prepare(sql).run();
      }
      await markApplied(env, migration.id);
      applied.push(migration.id);
    }

    return { ok: true, applied };
  } catch (error) {
    // 迁移失败必须让调用方知道 —— 但数据层的调用方都会捕获并回落 KV，
    // 不会让整个请求 500。
    console.error('[schema] migration failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error), applied };
  }
}

/**
 * 判断 guard 是否允许执行（true = 需要执行）。
 *
 * `column` 型：列**不存在**才返回 true（因为要执行的正是 ADD COLUMN）。
 */
async function guardAllows(env, guard) {
  if (!guard || guard.type !== 'column') return true;

  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(${guard.table})`).all();
    const names = (rows?.results || []).map((r) => String(r.name));
    return !names.includes(guard.column);
  } catch (error) {
    console.warn('[schema] guard check failed:', error?.message || error);
    // 查不到就保守跳过 —— 宁可漏加列也不要让迁移整体失败
    return false;
  }
}

/** 记录某个迁移版本已应用。 */
async function markApplied(env, version) {
  await env.DB.prepare(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
     ON CONFLICT(version) DO NOTHING`
  ).bind(version, now()).run();
}

// ============================================================================
// 运行状态自检
// ============================================================================

/** 版本记录表（第 0 号，由 runMigrations 无条件先建，故不进 MIGRATIONS）。 */
const META_TABLE = 'schema_migrations';

/**
 * 需要体检的表名：**从 DDL 自动提取** + 版本记录表。
 *
 * 表名来自本文件常量，不含外部输入，拼进 SQL 无注入风险。
 */
export const TABLES = (() => {
  const names = new Set([META_TABLE]);
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i;
  for (const migration of MIGRATIONS) {
    for (const sql of migration.statements) {
      const match = re.exec(sql);
      if (match) names.add(match[1]);
    }
  }
  return [...names];
})();

/** 关键列检查项（缺了会静默降级，所以显式暴露出来）。 */
const REQUIRED_COLUMNS = [{ table: 'files', column: 'is_folder' }];

async function columnExists(env, table, column) {
  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return (rows?.results || []).some((r) => String(r.name) === column);
  } catch (error) {
    return null; // null = 查不了，区别于 false = 确实没有
  }
}

/**
 * 只读地体检一次 D1，供运维端点 / 部署后验证使用。
 *
 * **不触发迁移**（不写任何东西）——想强制建表请用 `?apply=1` 走
 * `resetSchemaCache()` + `ensureSchema()`。
 *
 * @param {any} env
 * @param {{counts?: boolean}} [options] counts=false 时跳过行数统计（大表更快）
 */
export async function schemaStatus(env, options = {}) {
  const withCounts = options.counts !== false;

  if (!isD1Enabled(env)) {
    return {
      enabled: false,
      healthy: false,
      reason: 'D1 未绑定（env.DB 不存在）——数据层会整体回落 KV',
    };
  }

  const result = {
    enabled: true,
    healthy: false,
    applied: [],
    missing: [],
    tables: {},
    columns: {},
    counts: null,
    error: null,
  };

  // 1) 已应用的迁移版本
  try {
    const res = await env.DB.prepare(
      `SELECT version, applied_at FROM ${META_TABLE} ORDER BY version`
    ).all();
    result.applied = (res?.results || []).map((r) => ({
      version: String(r.version),
      applied_at: r.applied_at ?? null,
    }));
  } catch (error) {
    // meta 表不存在 = 还没跑过迁移，不是错误
    const message = error?.message || String(error);
    if (!/no such table/i.test(message)) {
      result.error = `无法读取 schema_migrations: ${message}`;
    }
  }

  const appliedSet = new Set(result.applied.map((a) => a.version));
  result.missing = MIGRATIONS.filter((m) => !appliedSet.has(m.id)).map((m) => m.id);

  // 2) 表是否存在（存在则记 true，不存在记 false）
  for (const table of TABLES) {
    try {
      await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all();
      result.tables[table] = true;
    } catch (error) {
      result.tables[table] = false;
    }
  }

  // 3) 关键列
  for (const { table, column } of REQUIRED_COLUMNS) {
    result.columns[`${table}.${column}`] = await columnExists(env, table, column);
  }

  // 4) 行数（可选）
  if (withCounts) {
    result.counts = {};
    for (const table of TABLES) {
      if (!result.tables[table]) {
        result.counts[table] = null;
        continue;
      }
      try {
        const res = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
        result.counts[table] = res?.results?.[0]?.n ?? null;
      } catch (error) {
        result.counts[table] = null;
      }
    }
  }

  const allTablesExist = TABLES.every((t) => result.tables[t]);
  const columnsOk = REQUIRED_COLUMNS.every(
    ({ table, column }) => result.columns[`${table}.${column}`] !== false
  );

  result.healthy =
    !result.error && result.missing.length === 0 && allTablesExist && columnsOk;

  return result;
}

/**
 * 仅供测试 / 手动运维：重置 module-level 缓存，强制下次重新检查。
 * 正常运行时不需要调用。
 */
export function resetSchemaCache() {
  schemaReady = null;
  schemaInFlight = null;
}
