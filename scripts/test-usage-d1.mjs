/**
 * D1 用量监控（functions/api/manage/usage.js）测试。
 *
 * 覆盖：
 *   [1]  D1 未绑定 → d1 为 null，不影响 KV/R2
 *   [2]  D1 绑定 + 无 API 凭据 → 仍返回 200，存储/行数照常，读写行数为空并给出提示
 *   [3]  D1 + API 但缺 D1_DATABASE_ID → 存储有、读写空
 *   [4]  D1 + API + D1_DATABASE_ID → 读写行数与查询次数都有
 *   [5]  存储占比按 5 GB 免费额度计算
 *   [6]  免费/付费的读写额度不同（500 万/日 vs 250 亿/月）
 *   [7]  表行数与表数来自本地 schemaStatus
 *   [8]  GraphQL 失败不影响存储部分
 *   [9]  三者都没绑 → 503
 *   [10] 无 D1 且无 API → 维持原有 503 行为（不能因为加了 D1 就改变老行为）
 *   [11] 计划缓存走 img_url 绑定（原来写死 env.KV 导致缓存永远失效）
 *   [12] resetAt 文案带上 D1
 *
 * 运行：node scripts/test-usage-d1.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrationFiles } from './test-utils.mjs';
import { ensureSchema, resetSchemaCache } from '../functions/utils/schema.js';
import { onRequestGet } from '../functions/api/manage/usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 建一个带全量迁移的内存库。 */
function migratedDb() {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) db.exec(readFileSync(file, 'utf8'));
  return db;
}

/**
 * D1 替身：比 test-utils 的 wrapAsD1 多一个 meta.size_after
 * （usage.js 靠它拿数据库大小，这是本文件的核心数据源）。
 */
function d1Mock(db, sizeAfter) {
  const wrap = (sql, params = []) => ({
    bind(...args) { return wrap(sql, args); },
    async first() { const r = db.prepare(sql).get(...params); return r === undefined ? null : r; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() {
      const info = db.prepare(sql).run(...params);
      return {
        success: true,
        changes: info.changes,
        meta: { changes: info.changes, size_after: sizeAfter, rows_read: 1, rows_written: 0 },
      };
    },
  });
  return { prepare: (sql) => wrap(sql) };
}

/** KV 替身（绑定名 img_url）。 */
function kvMock() {
  const store = new Map();
  return {
    _store: store,
    async get(key, options) {
      const raw = store.get(String(key));
      if (raw == null) return null;
      if (options?.type === 'json') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },
    async put(key, value) { store.set(String(key), String(value)); },
    async list() { return { keys: [] }; },
  };
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * fetch 替身。按 GraphQL query 内容路由，返回不同的模拟数据。
 * @returns {string[]} 每次请求的 URL（用于断言缓存是否生效）
 */
function installFetch({ d1Sum = null, failOn = null, subs = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/subscriptions')) return jsonResp({ success: true, result: subs });
    if (u.includes('/graphql')) {
      const body = JSON.parse(init?.body || '{}');
      const q = body.query || '';
      if (failOn && q.includes(failOn)) return jsonResp({ errors: [{ message: 'mock: GraphQL 失败' }] });
      const account = {};
      if (q.includes('d1AnalyticsAdaptiveGroups')) {
        account.d1AnalyticsAdaptiveGroups = d1Sum ? [{ sum: d1Sum, dimensions: { date: '2026-09-26' } }] : [];
      }
      if (q.includes('kvStorageAdaptiveGroups')) {
        account.kvStorageAdaptiveGroups = [{ max: { keyCount: 3, byteCount: 1024 } }];
      }
      if (q.includes('kvOperationsAdaptiveGroups')) account.kvOperationsAdaptiveGroups = [];
      return jsonResp({ data: { viewer: { accounts: [account] } } });
    }
    return jsonResp({});
  };
  return calls;
}

const D1_SUM = { rowsRead: 12345, rowsWritten: 678, readQueries: 90, writeQueries: 12 };

async function call(env) {
  const res = await onRequestGet({ env });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('[1] D1 未绑定');
  {
    installFetch({});
    const env = { img_url: kvMock(), CF_ACCOUNT_ID: 'acc', CF_API_TOKEN: 'tok', CF_PLAN_TYPE: 'free', KV_NAMESPACE_ID: 'ns' };
    const { status, body } = await call(env);
    check('[1] 200', status === 200, `status=${status}`);
    check('[1] d1Available=false', body?.d1Available === false);
    check('[1] d1 为 null', body?.d1 === null);
    check('[1] KV 不受影响', body?.kv?.storage?.usedBytes === 1024, JSON.stringify(body?.kv));
  }

  console.log('[2] D1 已绑定但无 API 凭据（关键：不能 503）');
  {
    installFetch({});
    const env = { img_url: kvMock(), DB: d1Mock(migratedDb(), 45_000_000), CF_PLAN_TYPE: 'free' };
    const { status, body } = await call(env);
    check('[2] 仍然 200（不是 503）', status === 200, `status=${status}`);
    check('[2] d1Available=true', body?.d1Available === true);
    check('[2] 存储来自 size_after', body?.d1?.storage?.usedBytes === 45_000_000, JSON.stringify(body?.d1?.storage));
    check('[2] 读写行数为 null', body?.d1?.operations === null);
    check('[2] 给出原因提示', String(body?.d1?.analyticsError || '').includes('CF_ACCOUNT_ID'), body?.d1?.analyticsError);
  }

  console.log('[3] 有 API 但缺 D1_DATABASE_ID');
  {
    installFetch({});
    const env = { img_url: kvMock(), DB: d1Mock(migratedDb(), 1000), CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', CF_PLAN_TYPE: 'free', KV_NAMESPACE_ID: 'ns' };
    const { body } = await call(env);
    check('[3] 存储仍可用', body?.d1?.storage?.usedBytes === 1000);
    check('[3] 提示缺 D1_DATABASE_ID', String(body?.d1?.analyticsError || '').includes('D1_DATABASE_ID'), body?.d1?.analyticsError);
    check('[3] 读写行数为 null', body?.d1?.operations === null);
  }

  console.log('[4] 全配置：读写行数与查询次数');
  {
    installFetch({ d1Sum: D1_SUM });
    const env = {
      img_url: kvMock(), DB: d1Mock(migratedDb(), 2_000_000),
      CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', CF_PLAN_TYPE: 'free',
      KV_NAMESPACE_ID: 'ns', D1_DATABASE_ID: 'db-uuid',
    };
    const { body } = await call(env);
    check('[4] rowsSource=graphql', body?.d1?.rowsSource === 'graphql');
    check('[4] rowsRead 正确', body?.d1?.operations?.rowsRead?.used === 12345, JSON.stringify(body?.d1?.operations));
    check('[4] rowsWritten 正确', body?.d1?.operations?.rowsWritten?.used === 678);
    check('[4] 剩余额度算对', body?.d1?.operations?.rowsRead?.remaining === 5_000_000 - 12345);
    check('[4] 查询次数', body?.d1?.queries?.read === 90 && body?.d1?.queries?.write === 12);
    check('[4] 无错误提示', !body?.d1?.analyticsError);
  }

  console.log('[5] 存储占比（免费 5 GB）');
  {
    installFetch({});
    const half = 512 * 1024 * 1024; // 512 MB = 5 GB 的 10%
    const env = { img_url: kvMock(), DB: d1Mock(migratedDb(), half), CF_PLAN_TYPE: 'free' };
    const { body } = await call(env);
    check('[5] 总额度 5 GB', body?.d1?.storage?.totalBytes === 5 * 1024 * 1024 * 1024);
    check('[5] 占比约 10%', Math.abs((body?.d1?.storage?.usagePercent || 0) - 10) < 0.01, String(body?.d1?.storage?.usagePercent));
  }

  console.log('[6] 免费 / 付费额度不同');
  {
    installFetch({ d1Sum: D1_SUM });
    const base = { img_url: kvMock(), DB: d1Mock(migratedDb(), 1000), CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', KV_NAMESPACE_ID: 'ns', D1_DATABASE_ID: 'd' };
    const free = await call({ ...base, CF_PLAN_TYPE: 'free' });
    const paid = await call({ ...base, CF_PLAN_TYPE: 'paid' });
    check('[6] 免费读额度 500 万', free.body?.d1?.operations?.rowsRead?.limit === 5_000_000);
    check('[6] 免费写额度 10 万', free.body?.d1?.operations?.rowsWritten?.limit === 100_000);
    check('[6] 付费读额度 250 亿', paid.body?.d1?.operations?.rowsRead?.limit === 25_000_000_000);
    check('[6] 付费写额度 5000 万', paid.body?.d1?.operations?.rowsWritten?.limit === 50_000_000);
  }

  console.log('[7] 表行数与表数');
  {
    installFetch({});
    const db = migratedDb();
    db.prepare(
      `INSERT INTO files (id, storage, file_name, file_size, uploaded_at)
       VALUES ('f1','r2','a.png',10,1)`
    ).run();
    const env = { img_url: kvMock(), DB: d1Mock(db, 1000), CF_PLAN_TYPE: 'free' };
    // 真实环境下数据层早已跑过懒迁移，schema_migrations 有记录；
    // 这里补上这一步，让测试反映真实时序
    resetSchemaCache();
    await ensureSchema(env);
    const { body } = await call(env);
    check('[7] files 行数 = 1', body?.d1?.storage?.rowsByTable?.files === 1, JSON.stringify(body?.d1?.storage?.rowsByTable));
    check('[7] bundles 行数 = 0', body?.d1?.storage?.rowsByTable?.bundles === 0);
    check('[7] 表数 3/3', body?.d1?.storage?.tableCount === 3 && body?.d1?.storage?.expectedTableCount === 3);
    check('[7] schema 健康', body?.d1?.schema?.healthy === true);
    check('[7] 不含 schema_migrations', !('schema_migrations' in (body?.d1?.storage?.rowsByTable || {})));
  }

  console.log('[8] GraphQL 失败不影响存储');
  {
    installFetch({ failOn: 'd1AnalyticsAdaptiveGroups' });
    const env = {
      img_url: kvMock(), DB: d1Mock(migratedDb(), 3_000_000),
      CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', CF_PLAN_TYPE: 'free',
      KV_NAMESPACE_ID: 'ns', D1_DATABASE_ID: 'd',
    };
    const { status, body } = await call(env);
    check('[8] 整体仍 200', status === 200);
    check('[8] 存储照常', body?.d1?.storage?.usedBytes === 3_000_000);
    check('[8] 读写段为 null', body?.d1?.operations === null);
    check('[8] 记录了失败原因', String(body?.d1?.analyticsError || '').length > 0, body?.d1?.analyticsError);
  }

  console.log('[9] KV / R2 / D1 都没绑 → 503');
  {
    installFetch({});
    const { status, body } = await call({ CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' });
    check('[9] 503', status === 503, `status=${status}`);
    check('[9] success=false', body?.success === false);
    check('[9] d1Available=false', body?.d1Available === false);
  }

  console.log('[10] 无 D1 且无 API → 保持原有 503 行为');
  {
    installFetch({});
    const { status } = await call({ img_url: kvMock(), KV_NAMESPACE_ID: 'ns' });
    check('[10] 503（行为未因新增 D1 而改变）', status === 503, `status=${status}`);
  }

  console.log('[11] 计划缓存写入 img_url（原来写死 env.KV 导致缓存失效）');
  {
    const calls = installFetch({ subs: [] });
    const kv = kvMock();
    const env = { img_url: kv, DB: d1Mock(migratedDb(), 1000), CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', KV_NAMESPACE_ID: 'ns' };
    await call(env);
    const first = calls.filter((u) => u.includes('/subscriptions')).length;
    check('[11] 第一次查了订阅接口', first === 1, `count=${first}`);
    check('[11] 缓存确实写进了 img_url', kv._store.has('kv-usage:config:plan'), [...kv._store.keys()].join(','));
    await call(env);
    const second = calls.filter((u) => u.includes('/subscriptions')).length;
    check('[11] 第二次命中缓存，未重复请求', second === 1, `count=${second}`);
  }

  console.log('[12] resetAt 文案包含 D1');
  {
    installFetch({});
    const env = { img_url: kvMock(), DB: d1Mock(migratedDb(), 1000), CF_PLAN_TYPE: 'free' };
    const { body } = await call(env);
    check('[12] 提到 D1 每日重置', String(body?.resetAt || '').includes('D1'), body?.resetAt);
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
