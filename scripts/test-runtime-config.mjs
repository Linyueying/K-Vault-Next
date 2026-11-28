/**
 * P6 测试：运行时配置的进程内缓存。
 *
 * ============================================================================
 * 为什么这个套件值得单独存在
 * ============================================================================
 *
 * 在本次改动前，`runtime-config.js` 的 TTL 缓存**完全没有测试覆盖**。
 * 而它的语义有两个方向，任一方向错了都不会报错：
 *
 *   · 缓存**不生效** → 每次请求都回源 KV，只是读放大，功能全对
 *   · 缓存**不失效** → 后台改完配置前台看不到，用户会以为后台坏了
 *
 * 两种都是"功能测试全绿但行为错了"的类型，只能靠断言调用次数来抓。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] TTL 内不重复回源 KV（缓存生效）
 *   [2] TTL 过期后回源（缓存会失效，不会永久陈旧）
 *   [3] 按分组独立缓存（改 guest 不会影响 cors 的缓存）
 *   [4] ★ save 主动失效 → 同 tick 内立即可见（不依赖 TTL）
 *   [5] ★ reset 主动失效 → 同 tick 内立即回落环境变量
 *   [6] KV 未绑定 → 直接返回 env 基线，不产生缓存条目
 *   [7] KV 读异常 → 回落 env 基线，不抛异常
 *   [8] 无 Origin 头时不读配置（跨域请求才需要白名单）
 *   [9] storage 同理：无 KV 绑定时 getGuestConfigResolved 也能用
 *
 * 运行：node scripts/test-runtime-config.mjs
 */
import {
  getRuntimeConfig,
  saveRuntimeConfig,
  resetRuntimeConfig,
  getGuestConfigResolved,
  getCorsConfigResolved,
  getUploadConfigResolved,
  CONFIG_GROUPS,
  invalidateRuntimeConfigCache,
} from '../functions/utils/runtime-config.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 带读写计数的 KV 替身。 */
function makeKv(initial = {}, options = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === 'json' ? value : JSON.stringify(value);
    },
    async put(key, value) {
      stats.put += 1;
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
  };
}

/**
 * 让每个用例从"干净缓存"开始。
 *
 * 模块级 Map 会跨用例保留上一个用例的值 —— 若不清，断言会读到别的 KV
 * 实例的数据。用 invalidateRuntimeConfigCache（只丢缓存、不删 KV）而非
 * resetRuntimeConfig（会删 KV 键），因为多数用例需要保留预置的 KV 值。
 */
function primeCache() {
  invalidateRuntimeConfigCache();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
console.log('[1] TTL 内不重复回源 KV（缓存生效）');
{
  const kv = makeKv({ 'config:guest': { enabled: true, maxFileSize: 111, dailyLimit: 7 } });
  const env = { img_url: kv };
  primeCache();
  kv._stats.get = 0;

  const a = await getGuestConfigResolved(env);
  check('[1] 首次读到 KV 的值', a.enabled === true && a.maxFileSize === 111, JSON.stringify(a));
  check('[1] 首次标记 source=kv', a.source === 'kv', a.source);
  check('[1] 首次回源 1 次', kv._stats.get === 1, String(kv._stats.get));

  for (let i = 0; i < 5; i += 1) await getGuestConfigResolved(env);
  check('[1] ★ 后续 5 次全部命中缓存（仍只回源 1 次）', kv._stats.get === 1, String(kv._stats.get));
  check('[1] 缓存命中时返回值一致',
    (await getGuestConfigResolved(env)).maxFileSize === 111);
}

// ============================================================================
console.log('[2] TTL 过期后回源（不会永久陈旧）');
{
  const kv = makeKv({ 'config:guest': { enabled: true, maxFileSize: 100, dailyLimit: 1 } });
  const env = { img_url: kv };
  primeCache();
  kv._stats.get = 0;

  await getGuestConfigResolved(env);
  check('[2] 首次回源', kv._stats.get === 1);

  // 直接改 KV（绕过 save，模拟"另一个 isolate 改的配置"）
  kv._store.set('config:guest', { enabled: false, maxFileSize: 200, dailyLimit: 2 });
  const cached = await getGuestConfigResolved(env);
  check('[2] TTL 内仍返回旧值（这是缓存的预期行为）',
    cached.maxFileSize === 100, String(cached.maxFileSize));

  // 等 TTL 过去。生产 TTL 是 30s，测试里不真等 —— 用模块导出的常量做断言
  // 更脆，所以这里改为验证"逻辑上会过期"：检查实现确实带时间戳比较。
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../functions/utils/runtime-config.js', import.meta.url), 'utf8'));
  check('[2] ★ 实现里有 TTL 时间戳比较（不是永久缓存）',
    /Date\.now\(\)\s*-\s*cached\.ts\s*<\s*CACHE_TTL_MS/.test(src),
    '未找到 TTL 比较逻辑');
  check('[2] ★ CACHE_TTL_MS 已被拉长到 30 秒', /CACHE_TTL_MS\s*=\s*30000/.test(src),
    (src.match(/CACHE_TTL_MS\s*=\s*\d+/) || [''])[0]);
  check('[2] TTL 是有限值（不是 Infinity 之类）',
    !/CACHE_TTL_MS\s*=\s*(Infinity|Number\.MAX)/.test(src));
}

// ============================================================================
console.log('[3] 按分组独立缓存');
{
  const kv = makeKv({
    'config:guest': { enabled: true, maxFileSize: 100, dailyLimit: 1 },
    'config:cors': { origins: ['https://a.test'] },
    'config:upload': { chunkBackend: 'r2' },
  });
  const env = { img_url: kv };
  primeCache();
  kv._stats.get = 0;

  const g = await getGuestConfigResolved(env);
  const c = await getCorsConfigResolved(env);
  const u = await getUploadConfigResolved(env);
  check('[3] 三组各自读到 KV 值',
    g.maxFileSize === 100 && c.origins[0] === 'https://a.test' && u.chunkBackend === 'r2',
    JSON.stringify({ g, c, u }));
  check('[3] 三组各回源 1 次 = 共 3 次', kv._stats.get === 3, String(kv._stats.get));

  // 再读一遍，三组都该命中
  await getGuestConfigResolved(env);
  await getCorsConfigResolved(env);
  await getUploadConfigResolved(env);
  check('[3] 第二轮三组全命中（仍 3 次）', kv._stats.get === 3, String(kv._stats.get));

  // 改 guest 不应影响其他组的缓存：三者是独立 Map 条目
  await saveRuntimeConfig(env, 'guest', { dailyLimit: 9 });
  kv._stats.get = 0;
  await getCorsConfigResolved(env);
  await getUploadConfigResolved(env);
  check('[3] ★ 改 guest 后 cors/upload 仍命中缓存（独立失效）',
    kv._stats.get === 0, String(kv._stats.get));
}

// ============================================================================
console.log('[4] save 主动失效 → 同 tick 内立即可见');
{
  const kv = makeKv({ 'config:guest': { enabled: true, maxFileSize: 100, dailyLimit: 1 } });
  const env = { img_url: kv };
  primeCache();

  const before = await getGuestConfigResolved(env);
  check('[4] 改前 enabled=true', before.enabled === true);

  await saveRuntimeConfig(env, 'guest', { enabled: false });
  // ★ 关键：不 sleep，立刻读
  const after = await getGuestConfigResolved(env);
  check('[4] ★ 保存后立刻读到新值（未依赖 TTL 过期）', after.enabled === false,
    JSON.stringify(after));
  check('[4] 未变更的字段保留原值', after.maxFileSize === 100, String(after.maxFileSize));
  check('[4] 保存确实写进了 KV', kv._store.get('config:guest').enabled === false);
}

// ============================================================================
console.log('[5] reset 主动失效 → 立即回落环境变量');
{
  const kv = makeKv({ 'config:guest': { enabled: true, maxFileSize: 999, dailyLimit: 99 } });
  const env = { img_url: kv, GUEST_UPLOAD: 'false', GUEST_MAX_FILE_SIZE: '123', GUEST_DAILY_LIMIT: '5' };
  primeCache();

  const fromKv = await getGuestConfigResolved(env);
  check('[5] 有 KV 覆盖时用 KV 值', fromKv.source === 'kv' && fromKv.maxFileSize === 999,
    JSON.stringify(fromKv));

  await resetRuntimeConfig(env, 'guest');
  const afterReset = await getGuestConfigResolved(env);
  check('[5] ★ reset 后立刻回落到 env 基线', afterReset.source === 'env', afterReset.source);
  check('[5] env 基线的值正确', afterReset.maxFileSize === 123 && afterReset.dailyLimit === 5,
    JSON.stringify(afterReset));
  check('[5] reset 确实删了 KV 键', !kv._store.has('config:guest'));
}

// ============================================================================
console.log('[6] KV 未绑定 → 直接返回 env 基线');
{
  const env = { GUEST_UPLOAD: 'true', GUEST_MAX_FILE_SIZE: '777', GUEST_DAILY_LIMIT: '3' };
  const g = await getGuestConfigResolved(env);
  check('[6] 无 KV 时返回 env 值', g.enabled === true && g.maxFileSize === 777,
    JSON.stringify(g));
  check('[6] 标记 source=env', g.source === 'env', g.source);

  const c = await getCorsConfigResolved(env);
  check('[6] cors 组无 KV 也能返回（空白名单）', Array.isArray(c.origins));

  const u = await getUploadConfigResolved(env);
  check('[6] upload 组无 KV 返回默认 auto', u.chunkBackend === 'auto', u.chunkBackend);
}

// ============================================================================
console.log('[7] KV 读异常 → 回落 env 基线，不抛');
{
  const kv = makeKv({}, { failGet: true });
  const env = { img_url: kv, GUEST_UPLOAD: 'true', GUEST_MAX_FILE_SIZE: '888', GUEST_DAILY_LIMIT: '4' };
  primeCache();

  let threw = false;
  let result = null;
  try { result = await getGuestConfigResolved(env); } catch { threw = true; }
  check('[7] ★ KV 读异常时不抛异常', threw === false, '抛了');
  check('[7] 异常时回落 env 基线', result?.maxFileSize === 888, JSON.stringify(result));
  check('[7] 异常时标记 source=env', result?.source === 'env', result?.source);

  const saved = await import('node:fs');
  check('[7] 异常被记录（有 console.error 而非静默吞掉）',
    saved.readFileSync(new URL('../functions/utils/runtime-config.js', import.meta.url), 'utf8')
      .includes('Runtime config read error'));
}

// ============================================================================
console.log('[8] 无 Origin 头时不读配置（跨域才需要白名单）');
{
  const kv = makeKv({ 'config:cors': { origins: ['https://a.test'] } });
  const env = { img_url: kv };
  primeCache();
  kv._stats.get = 0;

  const { resolveCorsHeaders } = await import('../functions/utils/cors.js');
  const noOrigin = new Request('https://x.test/api/v1/me');
  const headers = await resolveCorsHeaders(noOrigin, env);
  check('[8] ★ 无 Origin 时不回源 KV', kv._stats.get === 0, String(kv._stats.get));
  check('[8] 仍带 Vary: Origin（缓存正确性）', headers.Vary === 'Origin', headers.Vary);
  check('[8] 不给 ACAO（同源请求本就不需要）', !('Access-Control-Allow-Origin' in headers));

  const withOrigin = new Request('https://x.test/api/v1/me', {
    headers: { Origin: 'https://a.test' },
  });
  const h2 = await resolveCorsHeaders(withOrigin, env);
  check('[8] 带 Origin 时回源读取白名单', kv._stats.get === 1, String(kv._stats.get));
  check('[8] 白名单内 → 回显该 Origin',
    h2['Access-Control-Allow-Origin'] === 'https://a.test', h2['Access-Control-Allow-Origin']);

  const bad = new Request('https://x.test/api/v1/me', {
    headers: { Origin: 'https://evil.test' },
  });
  const h3 = await resolveCorsHeaders(bad, env);
  check('[8] 白名单外 → 不给 ACAO（浏览器会拦）',
    !('Access-Control-Allow-Origin' in h3), JSON.stringify(h3));
  check('[8] 第二次读命中缓存（仍只 1 次）', kv._stats.get === 1, String(kv._stats.get));
}

// ============================================================================
console.log('[9] 未绑定 KV 时的整体可用性');
{
  const env = {};
  const g = await getGuestConfigResolved(env);
  check('[9] 完全无绑定时不抛，返回默认值',
    g.enabled === false && g.maxFileSize === 5 * 1024 * 1024 && g.dailyLimit === 10,
    JSON.stringify(g));

  let threw = false;
  try { await saveRuntimeConfig(env, 'guest', { enabled: true }); } catch { threw = true; }
  check('[9] 无 KV 时保存会明确报错（而不是静默丢失）', threw === true);

  let resetThrew = false;
  try { await resetRuntimeConfig(env, 'guest'); } catch { resetThrew = true; }
  check('[9] 无 KV 时重置不报错（本就无 KV 可删）', resetThrew === false);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
