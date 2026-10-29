/**
 * 字节缓存工具（延迟优化 P0-3）
 *
 * 独立成模块的原因：`/file/<id>`（写入缓存）与上传完成（预热缓存）两侧
 * 都要用到同一套「开关判定 + 键构造」规则。两处各写一遍迟早会漂移 ——
 * 上传侧键多了一个查询参数，就会预热出一个永远命中不了的东西。
 *
 * 这里刻意**只依赖叶子模块**（env-config / runtime-config），避免形成
 * metadata-d1 ↔ file-record 那样的循环依赖。runtime-config 不反向依赖
 * 本模块，因此这条边是单向的。
 */

import { getPerfConfig, readPerfConfigFromEnv } from './runtime-config.js';

/**
 * 读取字节缓存策略（KV 覆盖 > 环境变量基线）。
 *
 * 返回整份策略而不是单个布尔 / 数值，是因为调用方通常**同时需要其中三四项**
 * （启用判定 + TTL + 字节上限）。让它们各自调一次 getPerfConfig 会打三四个
 * async —— 虽然 getRuntimeConfig 自带 30 秒进程内缓存，但缓存正巧过期时，
 * 连续几次 await 会各自打一次 KV。一次读取、整份使用。
 *
 * 读取失败时降级到**环境变量基线**而不是「全关」：
 * 这一组里有两个开关的默认值为 true，把它们一律按 false 处理会让一次
 * 短暂的 KV 抖动变成「优化全部失效」；回落到基线的行为与平时完全一致。
 *
 * @param {any} env
 * @returns {Promise<{enabled: boolean, warm: boolean, ttl: number, maxBytes: number}>}
 */
export async function getByteCachePolicy(env) {
  let perf;
  try {
    perf = await getPerfConfig(env);
  } catch (error) {
    console.warn('perf config read failed, falling back to env baseline:', error?.message || error);
    perf = readPerfConfigFromEnv(env);
  }
  return {
    enabled: perf?.publicByteCache === true,
    warm: perf?.warmOnUpload === true,
    ttl: perf?.publicByteCacheTtl,
    maxBytes: perf?.publicByteCacheMaxBytes
  };
}

/**
 * 构造字节缓存键。
 *
 * 键里**刻意不带查询串**：带上 `?dl=1` 会让「预览」和「下载」各存一份同样的
 * 字节，白白翻倍回源与存储。两者的差异只有 Content-Disposition，而那是在
 * 缓存之外逐请求改写的。
 */
export function buildByteCacheKey(requestUrl, fileId) {
  const url = new URL(requestUrl);
  url.search = '';
  url.pathname = `/__kvault-bytecache/${encodeURIComponent(String(fileId || ''))}`;
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * 与 file-record.js 的 STORAGE_PREFIXES 保持一致。
 *
 * 缓存键用的是「URL 里的那一段」，而它既可能是裸 ID（`c.png`），也可能是
 * 带存储前缀的 kvKey（`r2:c.png`）—— 上传接口回传哪种，取决于当时走的哪个
 * 存储分支。删除时手上往往只有裸 ID，所以两个方向都展开：多删几个不存在的
 * 键没有代价，漏删一个就是「删了还能下」。
 */
const KNOWN_PREFIXES = [
  'img:', 'vid:', 'aud:', 'doc:',
  'r2:', 's3:', 'webdav:', 'hf:', 'github:', 'discord:', 'telegram:',
];

/** 展开一个 ID 的所有等价缓存键形态。 */
function equivalentIds(rawValue) {
  const item = String(rawValue || '');
  if (!item) return [];

  const ids = new Set([item]);
  const idx = item.indexOf(':');
  const segmented = idx > 0 && idx < item.length - 1;
  if (segmented) ids.add(item.slice(idx + 1));

  const bare = segmented ? item.slice(idx + 1) : item;
  for (const prefix of KNOWN_PREFIXES) ids.add(`${prefix}${bare}`);
  return [...ids];
}

/**
 * 清除某个文件的所有字节缓存副本。
 *
 * 默认开启字节缓存之后，这一跳从「可选优化」变成「删除语义的一部分」：
 * Cache API 里的副本不会因为源对象消失而消失，最长要留一个 TTL。
 * 删除 / 改名时必须显式清掉，否则用户会看到「后台显示已删除，链接还能下」。
 *
 * 失败只记日志 —— 清理是尽力而为，不能因为边缘缓存不可用就让删除失败；
 * 残留副本仍会随 TTL 自然过期。
 *
 * @param {string} origin - 站点 origin
 * @param {string|string[]} values - 一个或多个 ID / kvKey
 * @returns {Promise<number>} 实际删掉的条数（仅用于日志与测试断言）
 */
export async function purgeByteCache(origin, values) {
  if (!origin) return 0;
  if (typeof caches === 'undefined' || !caches?.default) return 0;

  const inputs = Array.isArray(values) ? values : [values];
  const ids = new Set();
  for (const input of inputs) {
    for (const id of equivalentIds(input)) ids.add(id);
  }

  let purged = 0;
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const removed = await caches.default.delete(buildByteCacheKey(`${origin}/`, id));
        if (removed) purged += 1;
      } catch (error) {
        console.warn('byte cache purge failed:', error?.message || error);
      }
    })
  );
  return purged;
}

/**
 * 上传/分享完成后预热缓存。
 *
 * 背景：字节缓存是「首次访问付费、后续全白嫖」的模型。典型场景
 * 「上传完立刻把链接甩到群里」恰好撞在最慢的那一次上 —— 上传者自己
 * 先跑一趟，等真正有人点的时候已经是命中状态了。
 *
 * 实现上是一次自我 fetch：走完整链路（闸门照跑），能不能缓存由下载
 * 侧判定，预热不享有任何特权。
 *
 * @param {any} env - Pages 环境
 * @param {{waitUntil?: Function}} ctx - 执行上下文
 * @param {string} origin - 站点 origin（来自当前请求）
 * @param {string} fileKey - 文件 kvKey
 * @param {{size?: number}} [options] - 已知文件大小时可提前跳过注定进不了缓存的大文件
 */
export async function scheduleWarm(env, ctx, origin, fileKey, options = {}) {
  const policy = await getByteCachePolicy(env);
  if (!policy.enabled || !policy.warm) return false;
  if (!origin || !fileKey || typeof ctx?.waitUntil !== 'function') return false;

  // 超过单文件上限的文件注定写不进缓存，预热只是白跑一趟完整下载
  // （对 100MB 的文件等于凭空翻一倍出网流量）。大小未知时照常预热，
  // 下载侧还有一次 Content-Length 兜底判定。
  const size = Number(options?.size);
  if (Number.isFinite(size) && size > 0 && size > Number(policy.maxBytes || Infinity)) return false;

  try {
    const target = new URL(`/file/${encodeURIComponent(String(fileKey))}`, origin).toString();
    const job = fetch(target, {
      method: 'GET',
      headers: { 'X-KVault-Warm': '1' },
    })
      .then(async (response) => {
        // 把 body 读完：只有这样下载侧的 storeByteCache 才会被真正触发，
        // 否则 Worker 可能在流还没写完时就被当作「请求已结束」而丢弃。
        try {
          if (response.body) await response.arrayBuffer();
        } catch {
          /* 流读取失败不影响主流程 */
        }
      })
      .catch((error) => console.warn('byte cache warm failed:', error?.message || error));

    ctx.waitUntil(job);
    return true;
  } catch (error) {
    console.warn('failed to schedule warm:', error?.message || error);
    return false;
  }
}
