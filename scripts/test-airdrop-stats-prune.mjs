/**
 * 隔空投送 —— 使用记录「自动清除」的回归测试。
 *
 * ============================================================================
 * 防的是什么
 * ============================================================================
 *
 * airdrop_sessions 会随 TTL 被清掉，但 airdrop_stats 是**持久历史**，只增不减。
 * 不设上限就会无限增长，持续占用 D1 存储与免费额度（行数 + 索引体积）。
 *
 * 本次加入「保留条数」上限（cfg.statsRetention，默认 500）：
 *   - 超出上限时，删掉最旧的若干条（保留最新 N 条）
 *   - 0 = 关闭自动清理（管理员显式关掉）
 *   - 平时由 recordStat 抽样触发，也可由管理接口手动触发
 *
 * 本套件锁住 pruneStats 的边界行为：
 *   [1] 未超限：一条都不删
 *   [2] 超出上限：恰好删到只剩 N 条，且删的是**最旧的**
 *   [3] retention = 0：完全不动数据
 *   [4] 空表 / 记录数刚好等于上限：不删、不报错
 *
 * 运行：node scripts/test-airdrop-stats-prune.mjs
 */
import { pruneStats } from '../functions/utils/airdrop.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // 固定基准时间，避免用 now 造成不稳定

/**
 * 极简 D1 桩：只认 airdrop_stats 的 INSERT / 明细 SELECT / prune 用到的
 * 「水位线查询」与「按 created_at 删除」。其余（迁移/PRAGMA）无害回落。
 */
function makeDb() {
  const stats = [];
  const NEW_COLS = ['file_count', 'total_size', 'sender_ip', 'receiver_ip', 'completed_at'];
  return {
    _stats: stats,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (/PRAGMA table_info\(airdrop_stats\)/.test(sql)) {
            return [{ name: 'code' }, ...NEW_COLS.map((c) => ({ name: c }))][0];
          }
          if (/SELECT version FROM/.test(sql)) return { version: 0 };
          // pruneStats 的水位线查询：ORDER BY created_at DESC LIMIT 1 OFFSET ?
          if (/ORDER BY created_at DESC LIMIT 1 OFFSET/.test(sql)) {
            const offset = Number(this._args[0]) || 0;
            const sorted = [...stats].sort((a, b) => b.created_at - a.created_at);
            const row = sorted[offset];
            return row ? { created_at: row.created_at } : null;
          }
          return null;
        },
        async all() {
          if (/PRAGMA table_info\(airdrop_stats\)/.test(sql)) {
            return { results: [{ name: 'code' }, ...NEW_COLS.map((c) => ({ name: c }))] };
          }
          if (/COUNT\(\*\) AS total/.test(sql)) return { results: [] };
          if (/FROM airdrop_stats WHERE role = 'sender'/.test(sql)) {
            return { results: [...stats].sort((a, b) => b.created_at - a.created_at) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO airdrop_stats/.test(sql)) {
            // 新结构：code, role, is_guest, file_name, file_size, file_count,
            //         total_size, sender_ip, receiver_ip, outcome, created_at
            const a = this._args;
            stats.push({
              code: a[0], role: a[1], is_guest: a[2], file_name: a[3], file_size: a[4],
              file_count: a[5], total_size: a[6], sender_ip: a[7], receiver_ip: a[8],
              outcome: a[9], created_at: a[10], completed_at: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          // pruneStats 的删除：DELETE FROM airdrop_stats WHERE created_at < ?
          if (/DELETE FROM airdrop_stats WHERE created_at </.test(sql)) {
            const edge = Number(this._args[0]);
            const before = stats.length;
            for (let i = stats.length - 1; i >= 0; i -= 1) {
              if (stats[i].created_at < edge) stats.splice(i, 1);
            }
            return { success: true, meta: { changes: before - stats.length } };
          }
          // clearStats 用（本套件不直接测，但保持兼容）
          if (/DELETE FROM airdrop_stats\s*$/.test(sql.trim())) {
            const n = stats.length;
            stats.length = 0;
            return { success: true, meta: { changes: n } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch() { return []; },
    async exec() { return { success: true }; },
  };
}

/** 预置 n 条记录，时间戳递增（code = REC00001 …） */
function seed(db, n) {
  for (let i = 0; i < n; i += 1) {
    db._stats.push({
      code: 'REC' + String(i + 1).padStart(5, '0'),
      role: 'sender', is_guest: 0, file_name: 'f', file_size: 1,
      file_count: 1, total_size: 1, sender_ip: '', receiver_ip: '',
      outcome: 'completed', created_at: BASE + i * 1000, completed_at: null,
    });
  }
}

const codes = (db) => db._stats.map((r) => r.code).sort();
const envOf = (db) => ({ DB: db });

// ============================================================================
console.log('[1] 未超限：一条都不删');
{
  const db = makeDb();
  seed(db, 5);
  const r = await pruneStats(envOf(db), 10);
  check('[1] 删除数为 0', r.deleted === 0, String(r.deleted));
  check('[1] 记录数不变（5）', db._stats.length === 5, String(db._stats.length));
}

// ============================================================================
console.log('[2] 超出上限：删到只剩 N 条，且删的是最旧的');
{
  const db = makeDb();
  seed(db, 12); // REC00001 … REC00012
  const r = await pruneStats(envOf(db), 5);
  check('[2] 恰好删了 7 条', r.deleted === 7, String(r.deleted));
  check('[2] ★ 只剩 5 条', db._stats.length === 5, String(db._stats.length));
  // 保留的必须是最新的 5 条：REC00008 … REC00012
  const kept = codes(db);
  const expected = ['REC00008', 'REC00009', 'REC00010', 'REC00011', 'REC00012'];
  check('[2] ★ 保留的是最新的 5 条', JSON.stringify(kept) === JSON.stringify(expected),
    kept.join(','));
  check('[2] ★ 最旧的一条已被删', !kept.includes('REC00001'));
}

// ============================================================================
console.log('[3] retention = 0：关闭自动清理');
{
  const db = makeDb();
  seed(db, 20);
  const r = await pruneStats(envOf(db), 0);
  check('[3] ★ 删除数为 0', r.deleted === 0, String(r.deleted));
  check('[3] ★ 记录一条不少（20）', db._stats.length === 20, String(db._stats.length));
}

// ============================================================================
console.log('[4] 边界：空表 / 刚好等于上限');
{
  const empty = makeDb();
  const r1 = await pruneStats(envOf(empty), 5);
  check('[4] 空表不报错、删除数为 0', r1.deleted === 0);

  const exact = makeDb();
  seed(exact, 5);
  const r2 = await pruneStats(envOf(exact), 5);
  check('[4] ★ 刚好等于上限时不删', r2.deleted === 0 && exact._stats.length === 5,
    `deleted=${r2.deleted}, len=${exact._stats.length}`);

  const one = makeDb();
  seed(one, 1);
  const r3 = await pruneStats(envOf(one), 1);
  check('[4] 单条 + 上限 1：不删', r3.deleted === 0 && one._stats.length === 1);
}

// ============================================================================
console.log('[5] 上限 1：只留最新一条');
{
  const db = makeDb();
  seed(db, 6);
  const r = await pruneStats(envOf(db), 1);
  check('[5] 删了 5 条', r.deleted === 5, String(r.deleted));
  check('[5] ★ 只剩最新一条 REC00006', db._stats.length === 1 && db._stats[0].code === 'REC00006',
    db._stats.map((x) => x.code).join(','));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
