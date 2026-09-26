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

import {
  MIGRATIONS,
  TABLES,
  ensureSchema,
  resetSchemaCache,
  schemaStatus,
} from '../functions/utils/schema.js';

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

  console.log('[10] schemaStatus 只读体检');
  {
    // 10a 空库：表都不存在、迁移全缺、healthy=false
    const blank = emptyEnv();
    const s0 = await schemaStatus(blank);
    check('[10a] 空库 enabled=true', s0.enabled === true);
    check('[10a] 空库 healthy=false', s0.healthy === false);
    check('[10a] 空库 missing 列出全部迁移',
      s0.missing.length === MIGRATIONS.length, `missing=${s0.missing}`);
    check('[10a] 空库所有表都标记为不存在',
      TABLES.every((t) => s0.tables[t] === false), JSON.stringify(s0.tables));
    check('[10a] 空库不写任何东西（仍是空库）',
      blank._db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"
      ).get().n === 0);

    // 10b 迁移后：健康
    resetSchemaCache();
    const ready = emptyEnv();
    await ensureSchema(ready);
    // 造一点数据，确认 counts 有值
    ready._db.prepare(
      `INSERT INTO files (id, storage, file_name, file_size, uploaded_at)
       VALUES ('f1','r2','a.png',10,1)`
    ).run();
    const s1 = await schemaStatus(ready);
    check('[10b] 迁移后 healthy=true', s1.healthy === true, JSON.stringify(s1));
    check('[10b] missing 为空', s1.missing.length === 0);
    check('[10b] applied 记录齐全', s1.applied.length === MIGRATIONS.length);
    check('[10b] files 行数 = 1', s1.counts?.files === 1, JSON.stringify(s1.counts));
    check('[10b] schema_migrations 也被统计', s1.counts?.schema_migrations === 3);
    check('[10b] is_folder 列存在', s1.columns['files.is_folder'] === true);

    // 10c counts=0 时跳过统计
    const s2 = await schemaStatus(ready, { counts: false });
    check('[10c] counts=0 时不统计行数', s2.counts === null);
    check('[10c] counts=0 仍判定健康', s2.healthy === true);

    // 10d D1 未绑定
    const s3 = await schemaStatus({});
    check('[10d] 未绑定 → enabled=false', s3.enabled === false);
    check('[10d] 未绑定 → healthy=false', s3.healthy === false);
    check('[10d] 未绑定给出人类可读原因', typeof s3.reason === 'string' && s3.reason.length > 0);

    // 10e 缺列能被检出（healthy=false 而不是静默降级）
    const broken = new DatabaseSync(':memory:');
    broken.exec('CREATE TABLE files (id TEXT PRIMARY KEY, file_name TEXT)');
    const s4 = await schemaStatus({ DB: wrapAsD1(broken) });
    check('[10e] 缺 is_folder 列 → 该列标记 false', s4.columns['files.is_folder'] === false);
    check('[10e] 缺列导致 healthy=false', s4.healthy === false);

    // 10f TABLES 从 DDL 自动提取，不手工维护
    check('[10f] TABLES 含 files/bundles/bundle_files',
      ['files', 'bundles', 'bundle_files'].every((t) => TABLES.includes(t)),
      TABLES.join(','));
  }

  console.log('[11] /api/admin/db-status 端点冒烟');
  {
    const { onRequest } = await import('../functions/api/admin/db-status.js');

    const call = async (env, search = '', method = 'GET') => {
      const res = await onRequest({
        request: new Request(`https://example.test/api/admin/db-status${search}`, { method }),
        env,
      });
      return { status: res.status, body: await res.json() };
    };

    // 11a 未绑定 D1
    const a = await call({});
    check('[11a] 200', a.status === 200);
    check('[11a] d1.enabled=false', a.body.d1?.enabled === false);
    check('[11a] verdict 提示未绑定',
      typeof a.body.verdict === 'string' && a.body.verdict.includes('未绑定'),
      a.body.verdict);

    // 11b 空库：给出"迁移未跑完"的结论
    const blank = emptyEnv();
    const b = await call(blank);
    check('[11b] verdict 指明缺哪些迁移',
      b.body.verdict.includes('迁移未跑完'), b.body.verdict);
    check('[11b] 未带 apply 不建表（只读）',
      blank._db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"
      ).get().n === 0);

    // 11c ?apply=1 立即建表
    resetSchemaCache();
    const fresh = emptyEnv();
    const c = await call(fresh, '?apply=1');
    check('[11c] apply 后 healthy=true', c.body.d1?.healthy === true, JSON.stringify(c.body.d1));
    check('[11c] appliedNow 列出本次执行的迁移',
      Array.isArray(c.body.migrations?.appliedNow) && c.body.migrations.appliedNow.length === 3,
      JSON.stringify(c.body.migrations));
    check('[11c] verdict 为已就绪', c.body.verdict.includes('已就绪'), c.body.verdict);

    // 11d 方法限制
    const d = await call({}, '', 'POST');
    check('[11d] 非 GET 返回 405', d.status === 405);

    // 11e 不泄露业务数据：响应里不含文件名/路径
    resetSchemaCache();
    const withData = emptyEnv();
    await ensureSchema(withData);
    withData._db.prepare(
      `INSERT INTO files (id, storage, file_name, file_size, uploaded_at, folder_path)
       VALUES ('f1','r2','secret.png',10,1,'/private')`
    ).run();
    const e = await call(withData);
    const dump = JSON.stringify(e.body);
    check('[11e] 不泄露文件名', !dump.includes('secret.png'), dump.slice(0, 200));
    check('[11e] 不泄露目录路径', !dump.includes('/private'));
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
