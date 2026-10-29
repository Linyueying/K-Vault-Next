/**
 * 记录快路径缓存（延迟优化 P0-2）
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 * getRecordWithKey 是 **D1 优先**，而 D1 是单点主库 —— 部署里 D1 若在欧美、
 * 用户在亚太，每一次下载都要先付一次 80–300ms 的跨洋 SELECT，只为拿到
 * 「这个 ID 指向哪个存储的哪个 key」。这一跳排在所有闸门之前，纯粹是延迟，
 * 而记录在绝大多数情况下根本不变。
 *
 * 两级缓存：
 *   L1 isolate 内存 —— 零往返，命中率受 isolate 复用率限制
 *   L2 KV `reccache:<id>` —— 边缘读 ~5-20ms，跨 isolate 与跨 PoP 共享
 *
 * ============================================================================
 * 为什么只缓存「无任何保护属性」的记录
 * ============================================================================
 * 缓存的是**含分享密码哈希、有效期、下载配额的元数据**。对受保护的文件，
 * 哪怕几十秒的陈旧读取都可能意味着「刚改的密码不生效」「配额被绕过」——
 * 用一点点延迟换这种风险不值得。所以这里用 `isCacheableRecord` 硬排除：
 * 带密码 / 有效期 / 次数上限的文件一律不进缓存，每次都真读源。
 *
 * 于是「缓存里的东西」在语义上恒等于「公开的、无条件的定位信息」，
 * 剩下的不一致窗口只有文件名之类的展示型字段，用主动失效收敛。
 *
 * ============================================================================
 * 为什么默认关闭
 * ============================================================================
 * 它终究是一次「可用性换一致性」的取舍，所以是显式开关而非默认行为。
 * L1 是零成本的，因此始终生效；L2 需要 `RECORD_CACHE=1`。
 */

import { envValue } from './env-config.js';

/** L1 存活时长：短到足以让「改完立刻刷新」几乎总能看到新值。 */
const RECORD_CACHE_TTL_MS = 30 * 1000;
const RECORD_CACHE_MAX_ENTRIES = 128;
const RECORD_CACHE_KV_PREFIX = 'reccache:';
/** 序列化上限：超过就不缓存，避免把大对象塞进 KV 与进程内存。 */
const RECORD_CACHE_MAX_JSON_BYTES = 64 * 1024;

/** fileId -> { payload, expiresAt } */
const recordCache = new Map();

/** 记录缓存的 L2（KV）是否启用（RECORD_CACHE=1）。 */
export function isRecordCacheEnabled(env) {
  const raw = String(envValue(env, 'RECORD_CACHE') || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** KV 侧缓存时长（秒），默认 60。 */
function recordCacheTtlSeconds(env) {
  const parsed = Number(envValue(env, 'RECORD_CACHE_TTL'));
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.min(Math.floor(parsed), 3600);
}

/**
 * 只有「公开且无条件」的记录才允许进缓存。
 *
 * 三个字段任一存在有效值就拒绝：它们分别对应密码、有效期、下载次数上限。
 * `0` 与空字符串都表示「未设置」，不算保护属性。
 */
export function isCacheableRecord(metadata) {
  if (!metadata || typeof metadata !== 'object') return false;
  for (const field of ['sharePasswordHash', 'shareExpiresAt', 'shareMaxDownloads']) {
    const value = metadata[field];
    if (value === undefined || value === null || value === '') continue;
    if (Number(value) === 0) continue;
    return false;
  }
  return true;
}

/**
 * 与 file-record.js 的 STORAGE_PREFIXES 保持一致的前缀清单。
 *
 * 这里宁可多列：多删几个根本不存在的键没有任何代价，漏删一个则会让
 * 「改了密码 / 删了文件」在 TTL 内不生效。
 */
const KNOWN_PREFIXES = [
  'img:', 'vid:', 'aud:', 'doc:',
  'r2:', 's3:', 'webdav:', 'hf:', 'github:', 'discord:', 'telegram:',
];

/**
 * 展开一个 ID 的所有等价形态。
 *
 * 双向都要覆盖：
 *   `r2:c.png` → 也要清 `c.png`（带前缀的 kvKey → 裸 ID）
 *   `c.png`    → 也要清 `r2:c.png`（manage API 常拿裸 ID，而缓存可能是带前缀写入的）
 * 只做单向会在另一侧留下漏网的副本。
 */
function equivalentKeys(rawValue) {
  const item = String(rawValue || '');
  if (!item) return [];
  const keys = new Set([item]);

  const idx = item.indexOf(':');
  if (idx > 0 && idx < item.length - 1) keys.add(item.slice(idx + 1));
  const bare = idx > 0 ? item.slice(idx + 1) : item;
  for (const prefix of KNOWN_PREFIXES) keys.add(`${prefix}${bare}`);

  return [...keys];
}

/**
 * 让某些 ID 的记录缓存失效。
 *
 * **任何会改变记录内容或指向的写操作都必须调用它** —— 否则改名后的文件
 * 会在 TTL 内继续显示旧名，删除后的记录也可能短暂复活。
 *
 * @param {any} env
 * @param {string|Array<string>} value - 一个或多个 ID / kvKey
 */
export async function forgetRecordCache(env, value) {
  const inputs = Array.isArray(value) ? value : [value];
  const keys = new Set();

  // L1 是进程内存，删它零成本，无条件执行。
  for (const input of inputs) {
    for (const key of equivalentKeys(input)) {
      const existed = recordCache.delete(key);
      if (existed) keys.add(key); // 命中过 L1 → KV 里很可能有同款副本
    }
  }

  // KV 里有东西的前提是 L2 曾经开启过。开关没开 + L1 也没命中
  // → 根本不可能有副本，不必为一个从未缓存过的记录付 ~12 次 KV 写。
  // 这一层判断让「上传 / 改名」这类低频写操作在默认配置下几乎零开销。
  const worthTouchingKv = keys.size > 0 || isRecordCacheEnabled(env);
  if (!worthTouchingKv || !env?.img_url?.delete) return;

  if (keys.size === 0) {
    for (const input of inputs) {
      for (const key of equivalentKeys(input)) keys.add(key);
    }
  }
  await Promise.all(
    [...keys].map((key) =>
      env.img_url
        .delete(`${RECORD_CACHE_KV_PREFIX}${key}`)
        .catch((error) => console.warn('Failed to drop record cache:', error?.message || error))
    )
  );
}

/**
 * 查找缓存：L1 → L2，命中 L2 时顺手提升到 L1。
 *
 * @returns {Promise<{record: any, kvKey: string}|null>}
 */
export async function lookupRecordCache(env, value) {
  if (!value) return null;

  const memoryHit = recordCache.get(String(value));
  if (memoryHit !== undefined) {
    if (memoryHit.expiresAt > Date.now()) return memoryHit.payload;
    recordCache.delete(String(value));
  }

  if (!isRecordCacheEnabled(env) || !env?.img_url?.get) return null;

  try {
    const raw = await env.img_url.get(`${RECORD_CACHE_KV_PREFIX}${value}`, { type: 'json' });
    if (!raw || typeof raw !== 'object' || !raw.record?.metadata) return null;
    // 提升到 L1：同一 isolate 的后续请求连 KV 读都省了
    rememberInMemory(String(value), raw);
    return raw;
  } catch (error) {
    console.warn('Failed to read record cache:', error?.message || error);
    return null;
  }
}

/** 写入 L1（含容量淘汰）。 */
function rememberInMemory(key, payload) {
  if (recordCache.size >= RECORD_CACHE_MAX_ENTRIES) {
    const oldest = recordCache.keys().next().value;
    if (oldest !== undefined) recordCache.delete(oldest);
  }
  recordCache.set(key, {
    payload,
    expiresAt: Date.now() + RECORD_CACHE_TTL_MS,
  });
}

/**
 * 回填两级缓存。
 *
 * @param {any} env
 * @param {string} value - 查询时用的 fileId
 * @param {{record: any, kvKey: string}} result - 真实返回值
 * @param {Array<Promise>|null} background - 非空时把 KV 写入挂进去由调用方 waitUntil
 */
export function writeRecordCache(env, value, result, background = null) {
  const key = String(value || '');
  // 找不到记录不缓存：刚上传 / D1 尚未登记的情况下缓存 miss，
  // 会让文件在 TTL 内一直 404 —— 那是最难排查的一类故障。
  if (!key || !result?.record?.metadata) return;
  if (!isCacheableRecord(result.record.metadata)) return;

  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return; // 含循环引用等无法序列化的形态 → 不缓存
  }
  if (!serialized || serialized.length > RECORD_CACHE_MAX_JSON_BYTES) return;

  rememberInMemory(key, result);

  if (!isRecordCacheEnabled(env) || !env?.img_url?.put) return;
  const write = env.img_url
    .put(`${RECORD_CACHE_KV_PREFIX}${key}`, serialized, {
      expirationTtl: recordCacheTtlSeconds(env),
    })
    .catch((error) => console.warn('Failed to write record cache:', error?.message || error));

  if (Array.isArray(background)) background.push(write);
}

/** 【测试辅助】清空 L1，避免用例之间互相污染。 */
export function clearRecordCacheMemory() {
  recordCache.clear();
}
