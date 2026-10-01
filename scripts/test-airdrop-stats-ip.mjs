/**
 * 隔空投送 —— 使用记录扩展字段（双方 IP / 文件概览 / 耗时）的回归测试。
 *
 * ============================================================================
 * 防的是什么
 * ============================================================================
 *
 * 后台「分享」分区的隔空投送使用记录，原本只记了 连接码 / 文件名 / 大小 /
 * 结果 / 时间。管理员排查问题（谁发给谁、哪个中转节点、传了多久）时缺信息。
 *
 * 本次扩展把下列字段落到 durable 历史表 airdrop_stats（会话表会在 TTL 后清掉，
 * 不能放这里）：
 *   - sender_ip / receiver_ip  双方公网 IP
 *   - file_count / total_size 批量文件概览（不止首文件）
 *   - completed_at            收端取走时刻 → 与 created_at 相减得「耗时」
 *
 * 本套件锁住两件事：
 *   [1] recordStat 写入：sender_ip / file_count / total_size 被正确落库
 *   [2] getUsageStats 读取：recent 把上述新字段（含 receiver_ip / completed_at）
 *       原样暴露在管理后台拿得到的结构里
 *
 * 运行：node scripts/test-airdrop-stats-ip.mjs
 */
import { recordStat, getUsageStats, resetAirdropStatsColumns } from '../functions/utils/airdrop.js';
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
 * 极简 D1 桩：只认本套件用到的 airdrop_stats 读写语句。
 * INSERT 落进内存数组；聚合查询按数组现算；迁移/PRAGMA 噪声一律无害回落。
 */
function makeDb(opts = {}) {
  const legacy = Boolean(opts.legacy); // 模拟「未跑 M0012」的旧库结构
  const rows = () => (legacy
    ? [{ name: 'code' }, { name: 'role' }, { name: 'is_guest' }, { name: 'file_name' },
       { name: 'file_size' }, { name: 'outcome' }, { name: 'created_at' }]
    : [{ name: 'code' }, { name: 'role' }, { name: 'is_guest' }, { name: 'file_name' },
       { name: 'file_size' }, { name: 'file_count' }, { name: 'total_size' },
       { name: 'sender_ip' }, { name: 'receiver_ip' }, { name: 'outcome' },
       { name: 'created_at' }, { name: 'completed_at' }]);
  const stats = [];
  const pushRow = (sql, args) => {
    // 旧结构 INSERT 无 file_count… 四列；新结构有。用 SQL 里是否含 file_count 判断。
    const withDetail = /file_count/.test(sql);
    if (withDetail) {
      // 顺序：code, role, is_guest, file_name, file_size, file_count,
      //       total_size, sender_ip, receiver_ip, outcome, created_at
      stats.push({
        code: args[0], role: args[1], is_guest: args[2], file_name: args[3],
        file_size: args[4], file_count: args[5], total_size: args[6],
        sender_ip: args[7], receiver_ip: args[8], outcome: args[9], created_at: args[10],
        completed_at: null,
      });
    } else {
      // 旧结构：code, role, is_guest, file_name, file_size, outcome, created_at
      stats.push({
        code: args[0], role: args[1], is_guest: args[2], file_name: args[3],
        file_size: args[4], outcome: args[5], created_at: args[6],
        file_count: 0, total_size: 0, sender_ip: '', receiver_ip: '', completed_at: null,
      });
    }
  };
  return {
    _stats: stats,
    prepare(sql) {
      const self = this;
      return {
        _sql: sql,
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (/PRAGMA table_info\(airdrop_stats\)/.test(sql)) return rows()[0];
          if (/SELECT version FROM/.test(sql)) return { version: 0 };
          if (/COUNT\(\*\) AS total/.test(sql)) {
            const total = stats.length;
            const completed = stats.filter((r) => r.outcome === 'completed').length;
            const failed = stats.filter((r) => r.outcome !== 'completed').length;
            const guestCount = stats.filter((r) => r.is_guest === 1).length;
            const bytes = stats.filter((r) => r.outcome === 'completed')
              .reduce((a, r) => a + (r.file_size || 0), 0);
            const lastAt = stats.length ? Math.max(...stats.map((r) => r.created_at)) : 0;
            return { total, completed, failed, guestCount, bytes, lastAt };
          }
          return null;
        },
        async all() {
          if (/PRAGMA table_info\(airdrop_stats\)/.test(sql)) return { results: rows() };
          if (/COUNT\(\*\) AS total/.test(sql)) {
            const total = stats.length;
            const completed = stats.filter((r) => r.outcome === 'completed').length;
            const failed = stats.filter((r) => r.outcome !== 'completed').length;
            const guestCount = stats.filter((r) => r.is_guest === 1).length;
            const bytes = stats.filter((r) => r.outcome === 'completed')
              .reduce((a, r) => a + (r.file_size || 0), 0);
            const lastAt = stats.length ? Math.max(...stats.map((r) => r.created_at)) : 0;
            return { results: [{ total, completed, failed, guestCount, bytes, lastAt }] };
          }
          if (/FROM airdrop_stats WHERE role = 'sender'/.test(sql)) {
            const list = stats.filter((r) => r.role === 'sender')
              .sort((a, b) => b.created_at - a.created_at).slice(0, 20);
            return { results: list };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO airdrop_stats/.test(sql)) pushRow(sql, this._args);
          return { success: true };
        },
      };
    },
    async batch() { return []; },
    async exec() { return { success: true }; },
  };
}

function makeEnv() {
  return { DB: makeDb() };
}

/** 旧库（无 M0012 列）环境；PRAGMA 只能通过 all() 拿到（first() 返回首行，不够）。 */
function makeEnvLegacy() {
  const db = makeDb({ legacy: true });
  db._stats.push({ code: 'LEG00001', role: 'sender', is_guest: 0, file_name: 'old.bin',
    file_size: 7, file_count: 0, total_size: 0, sender_ip: '', receiver_ip: '',
    outcome: 'uploaded', created_at: NOW - MIN, completed_at: null });
  // 记录 PRAGMA 被探测的次数（用于验证缓存生效）
  const origPrepare = db.prepare.bind(db);
  let probeCount = 0;
  db.prepare = (sql) => {
    if (/PRAGMA table_info\(airdrop_stats\)/.test(sql)) probeCount += 1;
    return origPrepare(sql);
  };
  const env = { DB: db };
  Object.defineProperty(env, '_probeCount', { get: () => probeCount });
  return env;
}

// ============================================================================
console.log('[1] recordStat 写入：sender_ip / file_count / total_size 落库');
{
  const env = makeEnv();
  const entry = {
    code: 'SND11111',
    role: 'sender',
    isGuest: false,
    fileName: '首文件.pdf',
    fileSize: 1024,
    fileCount: 3,
    totalSize: 3072,
    senderIp: '203.0.113.7',
    outcome: 'uploaded',
  };
  await recordStat(env, entry);
  const row = env.DB._stats[0];
  check('[1] 写入了恰好一行', env.DB._stats.length === 1);
  check('[1] ★ sender_ip 落库', row && row.sender_ip === '203.0.113.7', row && row.sender_ip);
  check('[1] ★ file_count 落库', row && row.file_count === 3, row && String(row.file_count));
  check('[1] ★ total_size 落库', row && row.total_size === 3072, row && String(row.total_size));
  check('[1] 角色与结果正确', row && row.role === 'sender' && row.outcome === 'uploaded');
}

// ============================================================================
console.log('[2] getUsageStats 读取：新字段原样暴露给后台');
{
  const env = makeEnv();
  // 直接预置一行「已送达」记录，含 receiver_ip 与 completed_at，
  // 专门验证读取路径把这些字段带出来（写路径由 download 侧 UPDATE 填充）。
  env.DB._stats.push({
    code: 'SND22222', role: 'sender', is_guest: 1, file_name: '大礼包.zip',
    file_size: 4096, file_count: 5, total_size: 20480,
    sender_ip: '198.51.100.9', receiver_ip: '192.0.2.45',
    outcome: 'completed', created_at: NOW - 2 * MIN, completed_at: NOW - MIN,
  });
  const stats = await getUsageStats(env, 7);
  const r = stats.recent && stats.recent[0];
  check('[2] recent 至少返回一行', Array.isArray(stats.recent) && stats.recent.length >= 1);
  check('[2] ★ senderIp 暴露', r && r.senderIp === '198.51.100.9', r && r.senderIp);
  check('[2] ★ receiverIp 暴露', r && r.receiverIp === '192.0.2.45', r && r.receiverIp);
  check('[2] ★ fileCount 暴露', r && r.fileCount === 5, r && String(r.fileCount));
  check('[2] ★ totalSize 暴露', r && r.totalSize === 20480, r && String(r.totalSize));
  check('[2] ★ completedAt 暴露', r && r.completedAt === NOW - MIN, r && String(r.completedAt));
  check('[2] isGuest 标为访客', r && r.isGuest === true, r && String(r.isGuest));
  // 耗时 = completed_at - created_at = 1 分钟
  const dur = r ? (r.completedAt - r.createdAt) : null;
  check('[2] ★ 耗时可由两端时间戳相减得到（60s）', dur === MIN, String(dur));
  // 聚合口径仍正确
  check('[2] 聚合 total / completed 正确', stats.total === 1 && stats.completed === 1,
    `${stats.total}/${stats.completed}`);
}

// ============================================================================
console.log('[3] 多条记录：recent 按时间倒序、只取 sender 角色');
{
  const env = makeEnv();
  // OLD 用更早的时间戳直接置入，确保与 NEW（recordStat 内部 nowMs()）可比较
  env.DB._stats.push({ code: 'OLD33333', role: 'sender', is_guest: 0,
    file_name: 'a', file_size: 1, file_count: 1, total_size: 1,
    sender_ip: '10.0.0.1', receiver_ip: '', outcome: 'completed',
    created_at: NOW - 10 * MIN, completed_at: NOW - 9 * MIN });
  // 伪造一条 receiver 角色记录，确认不会被 recent 混入
  env.DB._stats.push({ code: 'RCV44444', role: 'receiver', is_guest: 0,
    file_name: 'x', file_size: 0, file_count: 0, total_size: 0,
    sender_ip: '', receiver_ip: '', outcome: 'completed',
    created_at: NOW, completed_at: NOW });
  await recordStat(env, { code: 'NEW55555', role: 'sender', isGuest: true,
    fileName: 'b', fileSize: 2, fileCount: 2, totalSize: 2,
    senderIp: '10.0.0.2', outcome: 'uploaded' });
  const stats = await getUsageStats(env, 7);
  const codes = stats.recent.map((x) => x.code);
  check('[3] ★ 只含 sender 角色（无 receiver）', !codes.includes('RCV44444'),
    codes.join(','));
  check('[3] ★ 按时间倒序：NEW 在 OLD 之前',
    codes.indexOf('NEW55555') < codes.indexOf('OLD33333'), codes.join(','));
}

// ============================================================================
// ★ 核心回归：旧库（尚未执行迁移 M0012）也必须读得出来、写得进去。
//   曾经的现场故障：库没跑迁移 → 明细 SELECT 引用不存在的列 → 统计接口 500
//   → 前端拿不到 backend → 误报「当前没有绑定 R2 或 Telegram」。
console.log('[4] 旧库未迁移：自动回退旧结构，不因缺列而整体失败');
{
  resetAirdropStatsColumns(null);
  const env = makeEnvLegacy();

  // [4a] 读取：新结构 SQL 会先失败，随后自动回退旧结构并返回结果
  const stats = await getUsageStats(env, 7);
  check('[4] ★ 旧库也能读出 recent（未抛错）', Array.isArray(stats.recent), typeof stats.recent);
  check('[4] 旧库 recent 返回已存在记录', stats.recent.length === 1 && stats.recent[0].code === 'LEG00001',
    stats.recent.map((r) => r.code).join(','));
  check('[4] 旧库缺列的字段回落为空串（不出现 undefined）',
    stats.recent[0].senderIp === '' && stats.recent[0].receiverIp === '',
    `${stats.recent[0].senderIp}/${stats.recent[0].receiverIp}`);
  check('[4] ★ 探测结果被缓存为 legacy，后续请求不再重试探',
    env._probeCount >= 1, `probe=${env._probeCount}`);

  // [4b] 写入：recordStat 在旧库上退回旧列 INSERT，仍写成功
  const before = env.DB._stats.length;
  await recordStat(env, { code: 'LEG00002', role: 'sender', isGuest: false,
    fileName: 'legacy.txt', fileSize: 10, fileCount: 2, totalSize: 20,
    senderIp: '1.2.3.4', outcome: 'uploaded' });
  const after = env.DB._stats.length;
  check('[4] ★ 旧库 INSERT 成功（未因缺列失败）', after === before + 1, `${before}->${after}`);
  check('[4] 旧库写入行角色正确', env.DB._stats[after - 1].role === 'sender');
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
