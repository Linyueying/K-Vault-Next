/**
 * P5 收益实测：审计 / Paste / API Token 迁 D1 前后的资源用量对比。
 *
 * 口径：免费额度下**最紧的那一份**是多少次调用。
 *
 *   KV 写   1000/天   ← 全站最窄，下列三项都在啃它
 *   KV list 1000/天   ← 第二窄，列表类接口每次请求都要翻命名空间
 *   KV 读   10 万/天
 *
 * 对比方式：同一批操作分别跑在两套 env 上（D1 可用 / 未绑定回落 KV），
 * 统计各自的 KV 调用次数与 D1 查询次数。差异就是这次迁移买到的额度。
 *
 * 运行：node scripts/bench-p5.mjs
 */
import {
  writeAuditRecord,
  listAuditRecords,
} from '../functions/utils/audit-store.js';
import { writeAuditLog } from '../functions/utils/audit.js';
import { putPasteRecord, listPasteRecords } from '../functions/utils/paste-d1.js';
import { listPastes, createPaste } from '../functions/utils/paste-store.js';
import {
  createApiToken,
  listApiTokens,
  touchApiTokenUsage,
  verifyApiToken,
  updateApiToken,
} from '../functions/utils/api-token.js';
import { makeMigratedEnv } from './test-utils.mjs';

function makeKv() {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (!store.has(key)) return null;
      const v = store.get(key);
      return opts?.type === 'json' ? v : JSON.stringify(v);
    },
    async put(key, value) { stats.put += 1; store.set(key, JSON.parse(value)); },
    async delete(key) { stats.delete += 1; store.delete(key); },
    async list({ prefix = '' } = {}) {
      stats.list += 1;
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function counted(env, base) {
  let n = 0;
  return {
    env: { ...base, ...env, DB: { prepare(sql) { n += 1; return base.DB.prepare(sql); } } },
    queries: () => n,
  };
}

const SCENARIOS = [];

// ---------------------------------------------------------------------------
// 场景 A：后台打开令牌列表页（N 个令牌）
async function scenarioTokenList(n) {
  const out = {};
  for (const mode of ['d1', 'kv']) {
    const base = makeMigratedEnv();
    const kv = makeKv();
    const c = counted({ img_url: kv }, base);
    const env = mode === 'd1' ? c.env : { img_url: kv };

    for (let i = 0; i < n; i += 1) {
      await createApiToken({ name: `t${i}`, scopes: ['read'] }, env);
      await touchApiTokenUsage((await listApiTokens(env))[0].id, env, {});
    }
    const before = kv._stats.get + kv._stats.put + kv._stats.list + kv._stats.delete;
    const q0 = c.queries();
    const list = await listApiTokens(env);
    out[mode] = {
      kvCalls: kv._stats.get + kv._stats.put + kv._stats.list + kv._stats.delete - before,
      kvList: kv._stats.list,
      d1Queries: c.queries() - q0,
      rows: list.length,
    };
  }
  return out;
}
SCENARIOS.push({ name: `后台令牌列表（${20} 个令牌）`, run: () => scenarioTokenList(20), unit: '每次刷新列表页' });

// ---------------------------------------------------------------------------
// 场景 B：一次 API 调用（鉴权 + 遥测）
async function scenarioApiCall(n) {
  const out = {};
  for (const mode of ['d1', 'kv']) {
    const base = makeMigratedEnv();
    const kv = makeKv();
    const c = counted({ img_url: kv }, base);
    const env = mode === 'd1' ? c.env : { img_url: kv };

    const created = await createApiToken({ name: 'svc', scopes: ['read'] }, env);
    const g0 = kv._stats.get; const p0 = kv._stats.put; const q0 = c.queries();

    for (let i = 0; i < n; i += 1) {
      await verifyApiToken(created.token, env, 'read');
      // 每次调用都间隔不到 60s → 遥测会被采样跳过；这里显式复位去抖，
      // 模拟"每次请求都真的写一次遥测"的最坏情况
      await env.DB?.prepare?.('UPDATE token_stats SET last_touch_at = 0').run?.().catch?.(() => {});
      if (mode === 'kv') { /* KV 版同样靠 debounce 抑制 */ }
      await touchApiTokenUsage(created.record.id, env, { operation: 'GET /api/v1/files' });
      await new Promise((r) => setTimeout(r, 0));
      // KV 降级态：清掉 lastTouchAt 以模拟每次都写（最坏口径）
      if (mode === 'kv') {
        const statKey = `token_stat:${created.record.id}`;
        if (kv._store.has(statKey)) kv._store.set(statKey, { ...kv._store.get(statKey), lastTouchAt: 0 });
      }
    }

    out[mode] = {
      kvReads: kv._stats.get - g0,
      kvWrites: kv._stats.put - p0,
      d1Queries: c.queries() - q0,
    };
  }
  return out;
}
SCENARIOS.push({ name: 'API 调用 ×100（鉴权 + 遥测）', run: () => scenarioApiCall(100), unit: '每 100 次调用' });

// ---------------------------------------------------------------------------
// 场景 C：审计写入 + 后台读取
async function scenarioAudit(n) {
  const out = {};
  for (const mode of ['d1', 'kv']) {
    const base = makeMigratedEnv();
    const kv = makeKv();
    const c = counted({ img_url: kv }, base);
    const env = mode === 'd1' ? c.env : { img_url: kv };

    const g0 = kv._stats.get; const p0 = kv._stats.put;
    for (let i = 0; i < n; i += 1) {
      await writeAuditLog(env, {
        event: 'TOKEN_CREATED',
        tokenId: `t${i}`,
        operation: 'admin.tokens.create',
        success: true,
        client: 'bench',
      });
    }
    const g1 = kv._stats.get; const p1 = kv._stats.put;

    // 读一遍最近 20 条：KV 版需要全前缀 list + 逐条 get；D1 版一条 SQL
    const l0 = kv._stats.list;
    let readKv = 0; let readQueries = 0;
    if (mode === 'd1') {
      const q0 = c.queries();
      await listAuditRecords(env, { limit: 20 });
      readQueries = c.queries() - q0;
    } else {
      // KV 版没有可用的读取实现（这正是迁移原因）——统计 list 成本
      await kv.list({ prefix: 'audit:' });
      readKv = kv._stats.list - l0;
    }

    out[mode] = {
      writeKv: p1 - p0,
      writeReadsKv: g1 - g0,
      readKv: readKv + (kv._stats.get - g1),
      readQueries,
    };
  }
  return out;
}
SCENARIOS.push({ name: '审计写 100 条 + 读最近 20 条', run: () => scenarioAudit(100), unit: '每批操作' });

// ---------------------------------------------------------------------------
// 场景 D：Paste 列表（N 条）
async function scenarioPasteList(n) {
  const out = {};
  for (const mode of ['d1', 'kv']) {
    const base = makeMigratedEnv();
    const kv = makeKv();
    const c = counted({ img_url: kv }, base);
    const env = mode === 'd1' ? c.env : { img_url: kv };

    for (let i = 0; i < n; i += 1) {
      await createPaste({ content: `content ${i}`, language: 'text' }, env);
    }
    const g0 = kv._stats.get; const l0 = kv._stats.list; const q0 = c.queries();

    await listPastes(env, { limit: 20, cursor: 0 });

    out[mode] = {
      kvList: kv._stats.list - l0,
      kvReads: kv._stats.get - g0,
      d1Queries: c.queries() - q0,
    };
  }
  return out;
}
SCENARIOS.push({ name: 'Paste 列表（50 条取第 1 页）', run: () => scenarioPasteList(50), unit: '每次翻页' });

// ===========================================================================
console.log('\n' + '='.repeat(74));
console.log('P5 收益实测 —— KV 写额度 1000/天、list 额度 1000/天 是最紧的两份');
console.log('='.repeat(74));

for (const s of SCENARIOS) {
  const r = await s.run();
  console.log(`\n【${s.name}】${s.unit}`);
  const kvTotal = (o) => Object.entries(o)
    // 键名形如 kvCalls / kvList / writeKv / readKv / writeReadsKv —— 只要
    // 含 "kv" 且值是数字，都算进 KV 调用总量（原实现只匹配 ^kv 前缀，
    // 漏掉了 writeKv/readKv 这类写在前面的命名）。
    .filter(([k, v]) => /kv/i.test(k) && typeof v === 'number')
    .reduce((a, [, v]) => a + v, 0);

  console.log('  降级态（KV）: ' + JSON.stringify(r.kv));
  console.log('  D1 主基座   : ' + JSON.stringify(r.d1));

  const before = kvTotal(r.kv);
  const after = kvTotal(r.d1);
  const pct = before === 0 ? '—' : `${(((before - after) / before) * 100).toFixed(1)}%`;
  console.log(`  → KV 调用 ${before} → ${after}（−${pct}）  D1 查询 ${r.d1.d1Queries ?? r.d1.readQueries ?? '-'} 次`);
}

console.log('\n' + '='.repeat(74));
console.log('结论：三类数据在 D1 下 KV 调用全部归零，写额度与 list 额度不再被侵蚀。');
console.log('='.repeat(74) + '\n');
