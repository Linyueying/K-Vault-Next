/**
 * 运行时自动迁移（schema.js）测试。
 *
 * 覆盖：
 *   [1] 全新空库：首次访问自动建出全部三张表
 *   [2] 幂等：重复调用不报错、不重复执行（applied 为空）
 *   [3] 增量迁移：只建了 0001 的库，自动补上 0002/0003
 *   [4] ALTER 幂等：已存在 is_folder 列时不重复 ADD COLUMN（关键 —— 否则报错）
 *   [5] 并发去重：20 个并发调用只真正执行一次
 *   [6] D1 未绑定 → disabled，不报错
 *   [7] 迁移后的库能正常读写（端到端）
 *   [8] schema_migrations 记录了全部版本
 *   [9] 每个数据层导出函数都接入了 ensureSchema（防漏改）
 *
 * 运行：node scripts/test-schema.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MIGRATIONS, ensureSchema, resetSchemaCache } from '../functions/utils/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** D1 兼容壳（同 test-utils，但这里要能造"空库/部分迁移"场景，故自建）。 */
function wrapAsD1(db) {
  const wrap = (sql, params = []) => ({
    bind(...args) { return wrap(sql, args); },
    async first() { const r = db.prepare(sql).get(...params); return r === undefined ? null : r; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, meta: { changes: info.changes } };
    },
  });
  return { prepare: (sql) => wrap(sql) };
}

/** 全新空库。 */
function emptyEnv() {
  const db = new DatabaseSync(':memory:');
  return { _db: db, DB: wrapAsD1(db) };
}

/** 只应用了指定迁移的库（模拟旧版本部署）。 */
function partialEnv(uptoId) {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  for (const file of files) {
    // 迁移 id 形如 '0001_files'，文件名形如 '0001_files.sql'
    const id = file.replace(/\.sql$/, '');
    if (id > uptoId) break;
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return { _db: db, DB: wrapAsD1(db) };
}

function tables(env) {
  return env._db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((r) => r.name);
}

function columns(env, table) {
  try {
    return env._db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } catch { return []; }
}

async function main() {
  // ==========================================================================
  console.log('[1] 全新空库：首次访问自动建表');
  {
    resetSchemaCache();
    const env = emptyEnv();
    check('初始无任何表', tables(env).length === 0, tables(env).join(','));

    const res = await ensureSchema(env);
    check('ensureSchema 返回 ok', res.ok === true, JSON.stringify(res));
    check('三张表全部建出',
      ['bundle_files', 'bundles', 'files'].every((t) => tables(env).includes(t)),
      tables(env).join(','));
    check('files 表有 23 列', columns(env, 'files').length === 23, String(columns(env, 'files').length));
    check('files 表含 is_folder', columns(env, 'files').includes('is_folder'));
    check('applied 含三个迁移', res.applied?.length === 3, JSON.stringify(res.applied));
  }

  // ==========================================================================
  console.log('[2] 幂等：重复调用不报错、不重复执行');
  {
    resetSchemaCache();
    const env = emptyEnv();
    const first = await ensureSchema(env);

    // 第二次：应命中 module 缓存
    const second = await ensureSchema(env);
    check('第二次 skipped=true', second.skipped === true, JSON.stringify(second));

    // 重置缓存后重新跑（模拟 isolate 重建）
    resetSchemaCache();
    const third = await ensureSchema(env);
    check('重置缓存后仍 ok', third.ok === true, JSON.stringify(third));
    check('重置缓存后 applied 为空（已执行过的不重复）',
      third.applied?.length === 0, JSON.stringify(third.applied));
    check('表数量未变（无重复建表）',
      tables(env).filter((t) => t === 'files').length === 1);
  }

  // ==========================================================================
  console.log('[3] 增量迁移：旧库自动补齐');
  {
    resetSchemaCache();
    // 只应用了 0001 —— 此时没有 is_folder 列，也没有 bundles 表
    const env = partialEnv('0001_files');
    check('初始无 bundles 表', !tables(env).includes('bundles'));
    check('初始无 is_folder 列', !columns(env, 'files').includes('is_folder'));

    const res = await ensureSchema(env);
    check('补齐成功', res.ok === true, JSON.stringify(res));
    check('bundles 表已建', tables(env).includes('bundles'));
    check('bundle_files 表已建', tables(env).includes('bundle_files'));
    check('is_folder 列已加', columns(env, 'files').includes('is_folder'));
    check('0002 与 0003 被应用',
      res.applied?.includes('0002_folder_markers') && res.applied?.includes('0003_share_bundles'),
      JSON.stringify(res.applied));
    // 0001 也会出现在 applied 里，这是**正确行为**：
    // .sql 建的库没有 schema_migrations 表，无法判断哪些跑过，于是全跑一遍。
    // 安全的前提是所有 DDL 都幂等（IF NOT EXISTS + guard），
    // 因此"多跑一次"只增加一次性开销，不产生副作用。
    check('0001 被重跑但无副作用（表结构仍正确）',
      columns(env, 'files').length === 23 && columns(env, 'files').includes('is_folder'));
  }

  // ==========================================================================
  console.log('[4] ALTER 幂等：已存在 is_folder 时不重复 ADD COLUMN');
  {
    resetSchemaCache();
    // 造一个「已有 is_folder 列，但 schema_migrations 没记录」的状态
    // —— 这是最容易踩坑的场景：guard 必须拦住重复的 ALTER
    const env = partialEnv('0002_folder_markers');
    check('前置：is_folder 已存在', columns(env, 'files').includes('is_folder'));

    // 不报错即通过（若 guard 失效，这里会抛 duplicate column name）
    const res = await ensureSchema(env);
    check('未因重复 ALTER 报错', res.ok === true, JSON.stringify(res));
    check('is_folder 仍只有一列',
      columns(env, 'files').filter((c) => c === 'is_folder').length === 1);
    check('0002 被记为已应用（applied 不含它）',
      !res.applied?.includes('0002_folder_markers'), JSON.stringify(res.applied));
  }

  // ==========================================================================
  console.log('[5] 并发去重：20 个并发只真正执行一次');
  {
    resetSchemaCache();
    const env = emptyEnv();
    const results = await Promise.all(Array.from({ length: 20 }, () => ensureSchema(env)));
    check('全部成功', results.every((r) => r.ok === true));
    // 并发时它们共享同一个 in-flight Promise，因此返回的是**同一对象引用**
    // —— 这是"只真正执行一次"的直接证据
    check('20 个并发返回同一结果对象（只执行一次）',
      results.every((r) => r === results[0]),
      `不同引用数 = ${new Set(results).size}`);
    check('表只建了一次', tables(env).filter((t) => t === 'files').length === 1);
  }

  // ==========================================================================
  console.log('[6] D1 未绑定 → disabled，不报错');
  {
    resetSchemaCache();
    const bare = { img_url: {} };
    const res = await ensureSchema(bare);
    check('返回 disabled=true', res.disabled === true, JSON.stringify(res));
    check('ok=false', res.ok === false);
  }

  // ==========================================================================
  console.log('[7] 迁移后的库能正常读写（端到端）');
  {
    resetSchemaCache();
    const env = emptyEnv();
    await ensureSchema(env);

    const { registerFileRecord, getRecordWithKey, listAllRecords } =
      await import('../functions/utils/file-record.js');
    // file-record 内部也走 metadata-d1 → 会触发 ensureSchema（已缓存）

    const ok = await registerFileRecord(env, 'r2:auto.png', {
      fileName: 'auto.png', fileSize: 123, TimeStamp: Date.now(), storageType: 'r2', r2Key: 'auto.png',
    });
    check('写入成功', ok.ok === true, JSON.stringify(ok));

    const hit = await getRecordWithKey(env, 'r2:auto.png');
    check('能读回', Boolean(hit?.record?.metadata), JSON.stringify(hit));
    check('fileName 正确', hit.record.metadata.fileName === 'auto.png');

    const all = await listAllRecords(env);
    check('列表有 1 条', all.files.length === 1, String(all.files.length));
  }

  // ==========================================================================
  console.log('[8] schema_migrations 记录完整');
  {
    resetSchemaCache();
    const env = emptyEnv();
    await ensureSchema(env);
    const rows = env._db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    const versions = rows.map((r) => r.version);
    check('三个版本全部记录', versions.length === 3, versions.join(','));
    check('与 MIGRATIONS 清单一致',
      MIGRATIONS.every((m) => versions.includes(m.id)),
      `清单=${MIGRATIONS.map((m) => m.id).join(',')} 实际=${versions.join(',')}`);
  }

  // ==========================================================================
  console.log('[9] 数据层每个 async 导出都接入了 ensureSchema（防漏改）');
  {
    const fs = await import('node:fs');
    for (const file of ['metadata-d1.js', 'bundle-store.js']) {
      const src = fs.readFileSync(join(ROOT, 'functions/utils', file), 'utf8');
      // 找出所有 export async function 声明
      const decls = [...src.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]);
      // 逐个检查：函数声明行的下一行是否是 ensureSchema 调用
      const lines = src.split('\n');
      const missing = [];
      for (let i = 0; i < lines.length; i += 1) {
        const m = lines[i].match(/^export async function (\w+)\(/);
        if (!m) continue;
        const next = (lines[i + 1] || '').trim();
        if (!next.includes('ensureSchema')) missing.push(m[1]);
      }
      check(`${file}: ${decls.length} 个 async 导出全部接入`,
        missing.length === 0,
        missing.length ? `漏了: ${missing.join(', ')}` : '');
    }
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
