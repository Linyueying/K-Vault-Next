/**
 * R2 上传操作通用重试与错误分类模块
 *
 * 目标：
 *   1. 将 R2 瞬态故障（边缘抖动 / 5xx / 429 / 网络重置）与永久错误
 *      （NoSuchUpload / 参数错误 / 鉴权失败）明确区分。
 *   2. 对幂等操作（R2 put / createMultipartUpload / uploadPart / complete / head）
 *      提供带 Full Jitter 的指数退避重试，避免并发分片在边缘抖动时同时重打产生惊群。
 *   3. 支持 AbortSignal（例如 URL 转存超时或取消），中断时立即停止退避。
 */

const EXPIRED_PATTERNS = [
  /no\s*such\s*upload/i,
  /nosuchupload/i,
  /multipart\s+upload.*(not\s+found|does\s+not\s+exist|expired|aborted|invalid)/i,
  /upload\s+id.*(not\s+found|expired|invalid)/i,
];

const CLIENT_ERROR_PATTERNS = [
  /entity\s*too\s*small/i,
  /invalid\s*part/i,
  /malformed/i,
  /bad\s*request/i,
  /access\s*denied/i,
  /unauthorized/i,
  /forbidden/i,
];

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed\s*out/i,
  /network/i,
  /reset/i,
  /temporar/i,
  /unavailable/i,
  /overload/i,
  /throttl/i,
  /rate\s*limit/i,
  /internal\s*error/i,
  /service\s+unavailable/i,
  /gateway/i,
  /try\s+again/i,
  /econn/i,
  /etimedout/i,
  /50[0234]/,
  /429/,
  /408/,
];

/**
 * 分类 R2 错误：
 *   - 'aborted'   : 调用方主动取消
 *   - 'expired'   : multipart 会话已失效/不存在（客户端应重建会话而非死重试）
 *   - 'client'    : 不可重试的客户端/参数错误
 *   - 'transient' : 可重试的瞬态服务端/网络错误
 *
 * @param {any} error
 * @returns {'aborted' | 'expired' | 'client' | 'transient'}
 */
export function classifyR2Error(error) {
  if (!error) return 'transient';
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return 'aborted';

  const status = Number(error.status ?? error.statusCode ?? error.$metadata?.httpStatusCode ?? 0);
  const msg = String(error.message || error.code || error || '');

  if (EXPIRED_PATTERNS.some((re) => re.test(msg))) return 'expired';
  if (status === 404 && /upload/i.test(msg)) return 'expired';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'transient';
  if (status >= 400 && status < 500) return 'client';

  if (CLIENT_ERROR_PATTERNS.some((re) => re.test(msg))) return 'client';
  if (TRANSIENT_PATTERNS.some((re) => re.test(msg))) return 'transient';

  // 未显式带 4xx 的未知 R2 绑定异常默认视为瞬态，交由有界重试处理
  return 'transient';
}

/**
 * 计算带 Full Jitter 的退避等待时间（毫秒）。
 * Full Jitter: random(base/2, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))
 * 保留 base/2 下界避免 0ms 紧循环，同时打散并发请求重试峰值。
 */
export function computeBackoffDelay(attempt, baseDelayMs = 200, maxDelayMs = 2000) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  const floor = Math.min(exp, Math.max(50, Math.round(baseDelayMs * 0.5)));
  return Math.round(floor + Math.random() * Math.max(0, exp - floor));
}

function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 对幂等 R2 操作执行有界指数退避重试。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.baseDelayMs=200]
 * @param {number} [options.maxDelayMs=2000]
 * @param {AbortSignal} [options.signal]
 * @param {(err: any, attempt: number, delayMs: number) => void} [options.onRetry]
 * @returns {Promise<T>}
 */
export async function retryR2Op(fn, options = {}) {
  const maxAttempts = Math.max(1, Math.min(6, Number(options.maxAttempts) || 3));
  const baseDelayMs = Number(options.baseDelayMs) >= 0 ? Number(options.baseDelayMs) : 200;
  const maxDelayMs = Number(options.maxDelayMs) >= 0 ? Number(options.maxDelayMs) : 2000;
  const { signal, onRetry } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const kind = classifyR2Error(err);
      if (kind !== 'transient' || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      if (typeof onRetry === 'function') {
        try { onRetry(err, attempt, delayMs); } catch (_) {}
      }
      await sleepWithSignal(delayMs, signal);
    }
  }
  throw lastError;
}
