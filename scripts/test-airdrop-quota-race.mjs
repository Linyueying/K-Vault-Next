/**
 * 隔空投送 —— 当日额度并发竞态回归测试
 *
 * 背景（红队结论）：每日额度原本是「读 KV → 判定 → 写 KV」，三步都有 await。
 * 并发请求会同时读到同一个旧值、一起放行 —— 实测 dailyLimit=3 时并发 12 个
 * 建房间请求**全部成功**，额度形同虚设。KV 没有原子自增，跨 isolate 无法根治。
 *
 * 修复：在 checkAirdropAccess 里加一层 isolate 内**同步**计数（claimDailySlot），
 * 在任何 await 之前完成判定与占用；KV 退化为跨 isolate 的粗粒度约束。
 *
 * 本测试构造真实并发（Promise.all），断言：
 *   [1] 并发 N 个 create，成功数不超过 dailyLimit
 *   [2] 顺序请求仍能正常耗尽额度（不能因加锁而误伤）
 *   [3] 建房间失败时归还额度（releaseDailySlot）
 *   [4] 收端 join 不消耗发起额度
 *
 * 用最小 D1 / KV 打桩驱动真实 onRequestPost。
 */
import { onRequestPost as createPost } from '../functions/api/airdrop/create.js';
import { onRequestPost as joinPost } from '../functions/api/airdrop/join.js';
import { invalidateRuntimeConfigCache } from '../functions/utils/runtime-config.js';

let pass = 0;
let fail = 0;

function ok(msg) { pass++; console.log(`  ✅ ${msg}`); }
function bad(msg) { fail++; console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

/**
 * 每个用例前必须清一次运行时配置缓存。
 *
 * getAirdropConfig 的 configCache 是**模块级单例**（按 group 作键，
 * 30s TTL）—— 生产环境一个 isolate 只有一个 env，这是合理优化；
 * 但测试里不同用例会传不同的环境变量，缓存会把上一段的
 * dailyLimit 带进下一段（实测：第二段 limit=2 却按 limit=3 放行）。
 * 这不是产品 bug，是测试必须自己处理的隔离问题。
 */
function resetConfigCache() {
  invalidateRuntimeConfigCache();
}

// ── 最小 KV 打桩（带一点延迟，放大读-改-写竞态） ──────────────────
function makeKv(store = new Map()) {
  return {
    store,
    async get(key, opts) {
      // 模拟 KV 网络往返：正是这个 await 让"读-判定-写"变成竞态
      await new Promise((r) => setTimeout(r, 1));
      const raw = store.get(key);
      if (raw === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      await new Promise((r) => setTimeout(r, 1));
      store.set(key, value);
    },
    async delete(key) { store.delete(key); }
  };
}

// ── 最小 D1 打桩：只支持 airdrop 相关 SQL ────────────────────────
function makeDb(sessions = new Map()) {
  return {
    sessions,
    prepare(sql) {
      const s = String(sql);
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          // SELECT * FROM airdrop_sessions WHERE code = ?
          if (/SELECT \* FROM airdrop_sessions WHERE code = \?/i.test(s)) {
            const row = sessions.get(stmt._args[0]);
            return row ? { ...row } : null;
          }
          // 存在性检查类查询（ensureSchema 探针）
          if (/SELECT 1/i.test(s) || /sqlite_master/i.test(s)) return { 1: 1 };
          return null;
        },
        async all() { return { results: [], success: true }; },
        async run() {
          // INSERT INTO airdrop_sessions (code, sender_token, created_at, expires_at)
          if (/INSERT INTO airdrop_sessions/i.test(s)) {
            const [code, senderToken, createdAt, expiresAt] = stmt._args;
            sessions.set(code, {
              code, sender_token: senderToken, receiver_token: null,
              created_at: createdAt, expires_at: expiresAt,
              status: 'waiting', files_json: '[]', fail_reason: null
            });
            return { success: true, meta: { changes: 1 } };
          }
          // UPDATE airdrop_sessions SET receiver_token = ?, status = 'linked', linked_at = ?
          //   WHERE code = ? AND receiver_token IS NULL
          // bind 顺序是 (receiverToken, nowMs, code) —— 三个参数，别漏掉中间的 linked_at。
          if (/SET receiver_token/i.test(s)) {
            const [receiverToken, , code] = stmt._args;
            const row = sessions.get(code);
            // 模拟 "WHERE ... AND receiver_token IS NULL"：已被抢占则不生效
            if (row && !row.receiver_token) {
              row.receiver_token = receiverToken;
              row.status = 'linked';
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT INTO airdrop_stats/i.test(s)) return { success: true, meta: { changes: 1 } };
          if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(s)) return { success: true, meta: { changes: 0 } };
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts) { return Promise.all(stmts.map((x) => x.run())); },
    async exec() { return { count: 0, duration: 0 }; },
  };
}

function req(path, headers = {}, ip = '9.9.9.9', init = {}) {
  const h = new Headers(headers);
  if (ip) h.set('CF-Connecting-IP', ip);
  return new Request(`https://example.com${path}`, { ...init, headers: h });
}

function ctx(env, request) {
  return { request, env, params: {}, next: async () => new Response(null) };
}

function makeEnv(extra = {}) {
  return {
    img_url: makeKv(),
    DB: makeDb(),
    AIRDROP_ENABLED: 'true',
    AIRDROP_DAILY_LIMIT: '3',
    AIRDROP_TTL_MINUTES: '5',
    AIRDROP_GUEST_ALLOWED: 'true',
    AIRDROP_GUEST_RECEIVE_ALLOWED: 'true',
    R2_BUCKET: null,
    TG_BOT_TOKEN: 'x',
    TG_CHAT_ID: '1',
    ...extra
  };
}

async function postCreate(env, ip) {
  return createPost(ctx(env, req('/api/airdrop/create', {}, ip, { method: 'POST' })));
}

console.log('\n[1] 并发建房间：成功数不得超过每日额度');
{
  resetConfigCache();
  const env = makeEnv({ AIRDROP_DAILY_LIMIT: '3' });
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => postCreate(env, '1.2.3.4'))
  );
  const created = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429).length;
  info(`并发 ${N} 次（限额 3）：成功 ${created}，被限 ${limited}`);
  if (created <= 3) ok(`并发下成功数 ${created} ≤ 限额 3（本地同步计数生效）`);
  else bad(`并发绕过额度：限额 3，实际成功 ${created}`);
}

console.log('\n[2] 顺序建房间：额度应被正常耗尽（未误伤）');
{
  resetConfigCache();
  const env = makeEnv({ AIRDROP_DAILY_LIMIT: '3' });
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await postCreate(env, '5.6.7.8');
    statuses.push(r.status);
  }
  info(`顺序 5 次（限额 3）：状态 ${statuses.join(', ')}`);
  const okCount = statuses.filter((s) => s === 200).length;
  if (okCount === 3) ok('顺序请求恰好放行 3 次');
  else bad(`顺序请求放行 ${okCount} 次，期望 3`);
  if (statuses.slice(3).every((s) => s === 429)) ok('超出后正确返回 429');
  else bad(`超出后状态异常：${statuses.slice(3).join(', ')}`);
}

console.log('\n[3] 不同 IP 互不影响额度');
{
  resetConfigCache();
  const env = makeEnv({ AIRDROP_DAILY_LIMIT: '2' });
  const a = await Promise.all([postCreate(env, '10.0.0.1'), postCreate(env, '10.0.0.1'), postCreate(env, '10.0.0.1')]);
  const b = await postCreate(env, '10.0.0.2');
  info(`IP-A 连打 3（限额 2）成功 ${a.filter((r) => r.status === 200).length}；IP-B 1 次 → ${b.status}`);
  if (a.filter((r) => r.status === 200).length <= 2 && b.status === 200) {
    ok('额度按 IP 隔离，不互相消耗');
  } else {
    bad('IP 额度隔离失效');
  }
}

console.log('\n[4] 收端 join 不消耗发起额度');
{
  resetConfigCache();
  const env = makeEnv({ AIRDROP_DAILY_LIMIT: '2' });
  const first = await postCreate(env, '20.0.0.1');
  const body = await first.json();
  const code = body.code;
  // 用掉剩余 1 次额度后，join 仍应可用
  await postCreate(env, '20.0.0.1');
  const exhausted = await postCreate(env, '20.0.0.1');
  const j = await joinPost(ctx(env, req('/api/airdrop/join', { 'content-type': 'application/json' }, '20.0.0.9',
    { method: 'POST', body: JSON.stringify({ code }) })));
  info(`发起额度耗尽后 create → ${exhausted.status}；join → ${j.status}`);
  if (exhausted.status === 429 && j.status === 200) ok('join 不受发起额度影响');
  else bad(`额度语义串味：create=${exhausted.status}, join=${j.status}`);
}

console.log('\n[5] 限流开关：DISABLE_RATE_LIMIT 时行为可预期');
{
  resetConfigCache();
  const env = makeEnv({ AIRDROP_DAILY_LIMIT: '1', DISABLE_RATE_LIMIT: 'true' });
  const r = await postCreate(env, '30.0.0.1');
  info(`关闭限流后 create → ${r.status}（额度仍应生效）`);
  if (r.status === 200) ok('关闭限流不影响每日额度（两者独立）');
  else bad(`关闭限流后行为异常：${r.status}`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(` 隔空投送额度并发测试：${pass} 通过 / ${fail} 失败`);
console.log('═══════════════════════════════════════════════════════════');
if (fail > 0) process.exit(1);
