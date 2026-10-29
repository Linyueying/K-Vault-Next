/**
 * 字节缓存工具（延迟优化 P0-3）
 *
 * 独立成模块的原因：`/file/<id>`（写入缓存）与上传完成（预热缓存）两侧
 * 都要用到同一套「开关判定 + 键构造」规则。两处各写一遍迟早会漂移 ——
 * 上传侧键多了一个查询参数，就会预热出一个永远命中不了的东西。
 *
 * 这里刻意**不 import 任何业务模块**（只依赖叶子的 env-config），
 * 以免形成 metadata-d1 ↔ file-record 那样的循环依赖。
 */

import { envValue } from './env-config.js';

/** 字节缓存开关（PUBLIC_BYTE_CACHE=1）。 */
export function isByteCacheEnabled(env) {
  const raw = String(envValue(env, 'PUBLIC_BYTE_CACHE') || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 预热开关（WARM_ON_UPLOAD=1）。 */
export function isWarmOnUploadEnabled(env) {
  const raw = String(envValue(env, 'WARM_ON_UPLOAD') || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 字节缓存 TTL（秒），默认 1 小时。 */
export function byteCacheMaxAge(env) {
  const parsed = Number(envValue(env, 'PUBLIC_BYTE_CACHE_TTL'));
  if (!Number.isFinite(parsed) || parsed <= 0) return 3600;
  return Math.min(Math.floor(parsed), 86400);
}

/**
 * 单文件进字节缓存的上限（字节），默认 64MB。
 *
 * 比 Cloudflare 的可缓存上限（Free/Pro/Business 为 512MB）保守得多：
 * `response.clone()` 会把流分成两路，消费速度不一致时 workerd 会缓冲，
 * 天花板上限按 128MB 的 isolate 内存来定才安全。
 */
export function byteCacheMaxBytes(env) {
  const parsed = Number(envValue(env, 'PUBLIC_BYTE_CACHE_MAX_BYTES'));
  if (!Number.isFinite(parsed) || parsed <= 0) return 64 * 1024 * 1024;
  return Math.min(Math.floor(parsed), 512 * 1024 * 1024);
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
 */
export function scheduleWarm(env, ctx, origin, fileKey) {
  if (!isByteCacheEnabled(env) || !isWarmOnUploadEnabled(env)) return false;
  if (!origin || !fileKey || typeof ctx?.waitUntil !== 'function') return false;

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
