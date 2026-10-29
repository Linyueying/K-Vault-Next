/**
 * 字节缓存工具（下载延迟优化）
 *
 * 独立成模块的原因：`/file/<id>`（写入缓存）与上传完成（预热缓存）两侧
 * 都要用到同一套「键构造 + 体积上限」规则。两处各写一遍迟早会漂移 ——
 * 上传侧键多了一个查询参数，就会预热出一个永远命中不了的东西。
 *
 * 这里刻意**只依赖叶子模块**，避免形成 metadata-d1 ↔ file-record 那样的
 * 循环依赖。
 *
 * ============================================================================
 * 为什么没有开关
 * ============================================================================
 * 这三项（字节缓存 / TTL / 单文件上限）是常量，不读 KV、不读环境变量。
 * 理由：它们处在每个下载请求的必经之路上，做成可配置就得在热路径上多读
 * 一次配置、多一层「配置读失败该降级成什么」的兜底，而这些复杂度换来的
 * 只是一项「关掉会变慢」的选项 —— 不值。
 * 需要临时停用时改这里的常量重新部署，是分钟级操作。
 */

/**
 * 缓存时长（秒）。也是「删除后最坏情况下边缘副本残留多久」的上限 ——
 * 正常情况下删除/改名/加密码都会主动清副本（见 purgeByteCache），
 * 这个 TTL 只是兜底。
 */
export const BYTE_CACHE_TTL_SECONDS = 3600;

/**
 * 单文件进缓存的上限（字节）。
 *
 * 64MB 远低于平台 512MB 的上限：`response.clone()` 分流时两路消费速度不一致，
 * workerd 会缓冲差值；天花板要按 128MB 的 isolate 内存来定才安全。
 * 超过这个体积的文件不缓存，也不会被预热（省掉白跑一趟整份下载）。
 */
export const BYTE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 读取字节缓存策略。
 *
 * 保留函数形态而不是让调用方直接引常量，是为了让「一次取整份策略」的
 * 用法保持一致 —— 调用方通常同时需要 TTL 与体积上限。
 *
 * @returns {{ttl: number, maxBytes: number}}
 */
export function getByteCachePolicy() {
  return { ttl: BYTE_CACHE_TTL_SECONDS, maxBytes: BYTE_CACHE_MAX_BYTES };
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
  if (!origin || !fileKey || typeof ctx?.waitUntil !== 'function') return false;

  // 超过单文件上限的文件注定写不进缓存，预热只是白跑一趟完整下载
  // （对 100MB 的文件等于凭空翻一倍出网流量）。大小未知时照常预热，
  // 下载侧还有一次 Content-Length 兜底判定。
  const size = Number(options?.size);
  if (Number.isFinite(size) && size > 0 && size > BYTE_CACHE_MAX_BYTES) return false;

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
