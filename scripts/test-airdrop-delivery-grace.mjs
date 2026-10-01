/**
 * 隔空投送 —— 交付宽限（getSessionForDelivery）与清理边界的回归测试。
 *
 * ============================================================================
 * 防的是什么
 * ============================================================================
 *
 * 房间的 expires_at 是**建房间那一刻**钉死的（= created_at + TTL），
 * 它不给"传输本身"留任何余量。发端传大文件很容易把窗口吃掉大半，
 * 等到房间翻到 uploaded、收端真正开始逐个下载时，可能已经踩线甚至超时。
 *
 * 此时如果所有读取都走严格的 getSession（过期即拒 + 顺手删中转文件），
 * 就会出现最坏的一种失败：
 *   收端正下到第 N 个文件 → 跨过 expires_at → 剩余文件被清理 →
 *   下载中断，用户看到"文件已失效"，可实际上发端已经传完、文件也还在。
 *
 * 所以取件路径改用 getSessionForDelivery：已 uploaded 的房间在宽限窗口内
 * 仍然放行读取。本套件锁住三件事：
 *   [1] 严格 getSession：过期就是过期（轮询靠它停下来，不能松）
 *   [2] 宽限读取：uploaded + 刚过期 → 仍然放行；超窗 → 拒绝
 *   [3] 非 uploaded（还在等/传一半）不享受宽限，照常过期清理
 *
 * 运行：node scripts/test-airdrop-delivery-grace.mjs
 */
import {
  getSession,
  getSessionForDelivery,
} from '../functions/utils/airdrop.js';
import { ensureSchema } from '../functions/utils/schema.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const NOW = Date.now();
const MIN = 60 * 1000;

/**
 * 极简 D1 桩：只认本套件用到的两类语句。
 * 之所以自己写而不是引 better-sqlite3，是因为仓库里没有原生依赖，
 * 而这里只需要"按 code 存取一行"的行为。
 */
function makeDb(rows) {
  const store = new Map(rows.map((r) => [r.code, { ...r }]));
  const deleted = [];   // 记录被 cleanupExpired 删掉的中转文件
  return {
    _store: store,
    _deleted: deleted,
    prepare(sql) {
      const self = this;
      return {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/SELECT \* FROM airdrop_sessions WHERE code = \?/.test(sql)) {
            const code = String(this._args[0]).toUpperCase();
            return store.get(code) || null;
          }
          return null;
        },
        async all() {
          if (/SELECT code, files_json, status FROM airdrop_sessions/.test(sql)) {
            // 批量清理：返回所有已过期的非终态房间
            const now = this._args[0];
            const list = [...store.values()].filter((r) =>
              r.expires_at < now && !['done', 'failed', 'cancelled', 'expired'].includes(r.status));
            return { results: list };
          }
          if (/SELECT code, files_json, status FROM airdrop_sessions WHERE code = \?/.test(sql)) {
            const code = String(this._args[0]).toUpperCase();
            const r = store.get(code);
            return { results: r ? [r] : [] };
          }
          return { results: [] };
        },
        async run() {
          if (/UPDATE airdrop_sessions SET status = 'expired' WHERE code = \?/.test(sql)) {
            const code = String(this._args[0]).toUpperCase();
            const r = store.get(code);
            if (r) r.status = 'expired';
            return { success: true };
          }
          if (/UPDATE airdrop_sessions SET status = 'expired'/.test(sql)) {
            const now = this._args[0];
            for (const r of store.values()) {
              if (r.expires_at < now && !['done', 'failed', 'cancelled', 'expired'].includes(r.status)) {
                r.status = 'expired';
              }
            }
            return { success: true };
          }
          return { success: true };
        },
      };
    },
    // schema 初始化会用到 batch/exec，给个空实现
    async batch() { return []; },
    async exec() { return { success: true }; },
  };
}

function makeEnv(rows) {
  const db = makeDb(rows);
  return {
    DB: db,
    // 中转节点的删除动作：记录调用，用来断言"宽限期内没有删文件"
    R2_BUCKET: {
      put: async () => {},
      get: async () => null,
      delete: async (key) => { db._deleted.push(key); },
    },
    // 让 ensureSchema 认为表已就绪（schema.js 会 SELECT sqlite_master）
    __schemaReady: true,
  };
}

function makeRow(code, status, expiresAt, files = []) {
  return {
    code,
    status,
    sender_token: 'st_' + code,
    receiver_token: 'rt_' + code,
    progress: 0,
    files_json: JSON.stringify(files),
    file_count: files.length,
    total_size: files.reduce((a, f) => a + (f.size || 0), 0),
    created_at: NOW - 6 * MIN,
    expires_at: expiresAt,
    uploaded_at: status === 'uploaded' ? NOW - MIN : null,
    linked_at: null,
    completed_at: null,
    error: null,
  };
}

const FILES = [
  { idx: 0, name: 'a.bin', size: 10, backend: 'r2', key: 'airdrop/T1/0', status: 'downloaded' },
  { idx: 1, name: 'b.bin', size: 20, backend: 'r2', key: 'airdrop/T1/1', status: 'uploaded' },
];

// ============================================================================
console.log('[1] 严格 getSession：过期就是过期（轮询靠它停下）');
{
  const env = makeEnv([makeRow('AAA11111', 'waiting', NOW - 1000)]);
  const s = await getSession(env, 'AAA11111');
  check('[1] ★ 过期房间严格读取返回 null', s === null, String(s));

  const env2 = makeEnv([makeRow('BBB22222', 'waiting', NOW + 5 * MIN)]);
  const s2 = await getSession(env2, 'BBB22222');
  check('[1] 未过期正常返回', s2 !== null && s2.code === 'BBB22222');

  // uploaded 且已过期 → 严格读取也必须拒绝（不能因为 uploaded 就永不判过期）
  const env3 = makeEnv([makeRow('CCC33333', 'uploaded', NOW - 1000, FILES)]);
  const s3 = await getSession(env3, 'CCC33333');
  check('[1] ★ 已 uploaded 但过期 → 严格读取仍拒绝（轮询会停）', s3 === null, String(s3));
}

// ============================================================================
console.log('[2] 交付宽限：uploaded 刚过期仍可继续取件');
{
  // 刚过期 10 秒，仍在 5 分钟宽限内
  const env = makeEnv([makeRow('DDD44444', 'uploaded', NOW - 10 * 1000, FILES)]);
  const s = await getSessionForDelivery(env, 'DDD44444');
  check('[2] ★ uploaded 刚过期 → 宽限放行（收端能取完剩下的）', s !== null, String(s));
  check('[2] ★ 且没有删任何中转文件', env.DB._deleted.length === 0,
    JSON.stringify(env.DB._deleted));

  // 未过期，正常放行
  const env2 = makeEnv([makeRow('EEE55555', 'uploaded', NOW + MIN, FILES)]);
  const s2 = await getSessionForDelivery(env2, 'EEE55555');
  check('[2] 未过期正常放行', s2 !== null);

  // 超过宽限窗口（过期 6 分钟 > 5 分钟宽限）→ 拒绝
  const env3 = makeEnv([makeRow('FFF66666', 'uploaded', NOW - 6 * MIN, FILES)]);
  const s3 = await getSessionForDelivery(env3, 'FFF66666');
  check('[2] ★ 超出宽限窗口 → 拒绝并清理', s3 === null, String(s3));
}

// ============================================================================
console.log('[3] 非 uploaded 不享受宽限');
{
  // 还在等配对就过期了 → 没有文件要交付，照常清理
  const env = makeEnv([makeRow('GGG77777', 'waiting', NOW - 10 * 1000, [])]);
  const s = await getSessionForDelivery(env, 'GGG77777');
  check('[3] ★ waiting 过期 → 不宽限', s === null, String(s));

  // 传了一半就过期 → 清单不完整，没有交付价值，照常清理
  const half = [{ idx: 0, name: 'a.bin', size: 10, backend: 'r2', key: 'airdrop/H/0', status: 'uploaded' }];
  const env2 = makeEnv([makeRow('HHH88888', 'uploading', NOW - 10 * 1000, half)]);
  const s2 = await getSessionForDelivery(env2, 'HHH88888');
  check('[3] ★ uploading 过期 → 不宽限', s2 === null, String(s2));

  // 已 done 的房间：终态，不受过期影响（由 cleanup 之外的路径处理）
  const env3 = makeEnv([makeRow('III99999', 'done', NOW - 10 * 1000, FILES)]);
  const s3 = await getSessionForDelivery(env3, 'III99999');
  check('[3] 终态(done)不受过期判定影响', s3 !== null);
}

// ============================================================================
console.log('[4] 边界：宽限窗口两侧');
{
  // 恰好过期 5 分钟 - 1 秒 → 仍在窗口内
  const env = makeEnv([makeRow('JJJ10101', 'uploaded', NOW - (5 * MIN - 1000), FILES)]);
  const s = await getSessionForDelivery(env, 'JJJ10101');
  check('[4] ★ 过期 4分59秒 → 仍放行（窗口边界内）', s !== null, String(s));

  // 恰好过期 5 分钟 + 1 秒 → 出窗口
  const env2 = makeEnv([makeRow('KKK20202', 'uploaded', NOW - (5 * MIN + 1000), FILES)]);
  const s2 = await getSessionForDelivery(env2, 'KKK20202');
  check('[4] ★ 过期 5分01秒 → 拒绝（窗口边界外）', s2 === null, String(s2));

  // 不存在的房间
  const env3 = makeEnv([]);
  const s3 = await getSessionForDelivery(env3, 'ZZZ99999');
  check('[4] 不存在的房间 → null', s3 === null);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
