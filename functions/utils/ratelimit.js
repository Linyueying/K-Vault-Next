/**
 * 通用限流工具（KV 固定窗口 + 账户级失败锁定）。
 *
 * 设计原则（与 checkTokenRateLimit 对齐）：
 * - 使用 img_url KV 存储计数器/状态，key 带窗口起点或 TTL，自动过期，不膨胀。
 * - KV 读失败 → 放行（fail-open），避免限流组件自身故障导致全站不可用。
 * - KV 写失败 → 仅告警，不影响请求放行。
 * - 限流是「节流」而非「强阻断」：KV 最终一致下允许轻微超量，足够挡住暴力破解 /
 *   扫号，不追求精确计数（硬限制应依赖 Cloudflare Rate Limiting / WAF）。
 */

const RL_NS = 'rl';

/**
 * 取真实客户端 IP。
 * 优先 Cloudflare 注入的 CF-Connecting-IP（不可伪造），回退 X-Forwarded-For 首段。
 * 两者皆无（本地 / 测试）→ 'unknown'，此时限流退化为按单一 key（仍保留节流语义）。
 */
export function getClientIp(request) {
  try {
    const cf = request.headers.get('CF-Connecting-IP');
    if (cf) return String(cf).trim();
    const xff = request.headers.get('X-Forwarded-For');
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

function sanitizeKey(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 128);
}

function ratelimitDisabled(env) {
  return Boolean(env && env.DISABLE_RATE_LIMIT === 'true');
}

/**
 * isolate 内的本地计数器（同步、无 await）。
 *
 * 为什么需要它：固定窗口限流原本是「读 KV → 判定 → 写 KV」，三步之间都有
 * await。并发请求会同时读到同一个旧值、一起放行 —— 实测 max=5 时并发 20 个
 * 请求全部通过。KV 没有原子自增，跨 isolate 无法根治；但在**同一 isolate 内**
 * 可以先用一个同步 Map 记账，把并发窗口收掉。
 *
 * 语义是「先占坑、后核算」：本地计数先 +1 并立刻判定，超限直接拒；
 * 未超限才继续走 KV（KV 负责跨 isolate 的粗粒度约束）。
 * 本地计数只在 isolate 存活期内有效（会被回收），因此不承担长期准确性，
 * 只负责挡住"同一瞬间打进来的一批"。
 */
const localCounters = new Map();

/** 清理过期的本地窗口（避免 Map 无限增长） */
function sweepLocalCounters(now) {
  if (localCounters.size < 512) return;
  for (const [k, v] of localCounters) {
    if (v.windowStart + v.windowMs < now) localCounters.delete(k);
  }
}

/**
 * 固定窗口限流（按任意 key，如 IP / 账户名 / 路由）。
 *
 * @param {object}   opts
 * @param {object}   opts.env        绑定，需要 env.img_url
 * @param {string}   opts.key        限流维度 key（如 IP、账户名）
 * @param {string}   opts.namespace  命名空间，区分不同限流场景
 * @param {number}   opts.windowMs   窗口时长（毫秒）
 * @param {number}   opts.max        窗口内最大请求数
 * @returns {Promise<{allowed:boolean, limit:number, remaining:number, retryAfterMs:number}>}
 */
export async function fixedWindowRateLimit({ env, key, namespace, windowMs, max }) {
  if (ratelimitDisabled(env)) {
    return { allowed: true, limit: max, remaining: max, retryAfterMs: 0 };
  }

  const safeKey = sanitizeKey(key);
  const ns = sanitizeKey(namespace);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const ttlSeconds = Math.max(Math.ceil(windowMs / 1000) + 5, 10);
  const kvKey = `${RL_NS}:${ns}:${safeKey}:${windowStart}`;
  const retryAfterMs = windowStart + windowMs - now;

  // 无 KV 绑定：放行（fail-open）
  if (!env?.img_url) {
    return { allowed: true, limit: max, remaining: max, retryAfterMs: 0 };
  }

  // ── 第一道：isolate 内同步计数（无 await，并发下准确） ──────────
  // 必须在任何 await 之前完成"占用"，否则这一拍又变成读-改-写竞态。
  sweepLocalCounters(now);
  const localKey = `${ns}|${safeKey}|${windowStart}`;
  const local = localCounters.get(localKey);
  const localCount = local ? local.count : 0;
  if (localCount >= max) {
    return { allowed: false, limit: max, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 1) };
  }
  localCounters.set(localKey, {
    count: localCount + 1,
    windowStart,
    windowMs
  });

  // ── 第二道：KV 计数（跨 isolate 的粗粒度约束） ────────────────
  let count = 0;
  try {
    const raw = await env.img_url.get(kvKey, { type: 'json' });
    count = Number(raw?.count || 0);
  } catch {
    count = 0;
  }

  // 取本地与 KV 的较大者：本地是"本 isolate 已放行数"，
  // KV 是"所有 isolate 已知的总数"，任一方超限都应拦下。
  if (count >= max) {
    return { allowed: false, limit: max, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 1) };
  }

  try {
    await env.img_url.put(kvKey, JSON.stringify({ count: count + 1 }), { expirationTtl: ttlSeconds });
  } catch (error) {
    console.warn('[ratelimit] counter write failed:', error?.message || error);
  }

  return {
    allowed: true,
    limit: max,
    remaining: Math.max(max - Math.max(count, localCount) - 1, 0),
    retryAfterMs: 0,
  };
}

/**
 * 读取账户级失败锁定状态（一次 KV 读）。
 *
 * 维护 { fails, firstFailAt, lockedUntil }：
 * - 失败计数在 windowMs 内累计（滑动：距首次失败超过窗口则重置）
 * - 累计达到 maxFails 则锁定 lockMs 毫秒（跨 IP 生效，防针对某账户的定向爆破）
 *
 * @returns {Promise<{locked:boolean, retryAfterMs:number, fails:number, _internal:object|null}>}
 *   _internal 仅在未锁定时非 null，供 applyFailure 复用，避免二次读取。
 */
export async function getAccountLockState(env, account, namespace, { windowMs, lockMs } = {}) {
  const ns = sanitizeKey(namespace);
  const key = sanitizeKey(account);
  const kvKey = `${RL_NS}:lock:${ns}:${key}`;
  const now = Date.now();
  const empty = { locked: false, retryAfterMs: 0, fails: 0, _internal: null };

  if (!env?.img_url) return empty;

  let state = { fails: 0, firstFailAt: 0, lockedUntil: 0 };
  try {
    const raw = await env.img_url.get(kvKey, { type: 'json' });
    if (raw && typeof raw === 'object') state = { ...state, ...raw };
  } catch {
    return empty;
  }

  if (Number(state.lockedUntil) > now) {
    return {
      locked: true,
      retryAfterMs: Number(state.lockedUntil) - now,
      fails: Number(state.fails || 0),
      _internal: null,
    };
  }

  const ttlSeconds = Math.max(
    Math.ceil(((Number(windowMs) || 900000) + (Number(lockMs) || 900000)) / 1000) + 5,
    30
  );
  return {
    locked: false,
    retryAfterMs: 0,
    fails: Number(state.fails || 0),
    _internal: { kvKey, state, now, ttlSeconds },
  };
}

/**
 * 在未锁定时登记一次失败；达到阈值则锁定 lockMs。
 * 必须传入 getAccountLockState 返回的 _internal（仅当未锁定时非 null）。
 *
 * @returns {Promise<{locked:boolean, retryAfterMs:number, fails:number}>}
 */
export async function applyFailure(env, internal, { maxFails, windowMs, lockMs }) {
  if (!internal || !env?.img_url) {
    return { locked: false, retryAfterMs: 0, fails: 0 };
  }

  const now = internal.now;
  let state = internal.state;
  let firstFailAt = Number(state.firstFailAt || 0);
  let fails = Number(state.fails || 0);

  // 滑动窗口：距首次失败超过 windowMs 则重置计数
  if (firstFailAt && now - firstFailAt > windowMs) {
    fails = 0;
    firstFailAt = 0;
  }

  fails += 1;
  if (firstFailAt === 0) firstFailAt = now;

  let lockedUntil = 0;
  if (fails >= maxFails) {
    lockedUntil = now + lockMs;
  }

  try {
    await env.img_url.put(
      internal.kvKey,
      JSON.stringify({ fails, firstFailAt, lockedUntil }),
      { expirationTtl: internal.ttlSeconds }
    );
  } catch (error) {
    console.warn('[ratelimit] lock state write failed:', error?.message || error);
  }

  return {
    locked: lockedUntil > now,
    retryAfterMs: lockedUntil > now ? lockedUntil - now : 0,
    fails,
  };
}

/**
 * 登录成功后清零失败计数。
 */
export async function resetFailures(env, account, namespace) {
  if (!env?.img_url) return;
  const ns = sanitizeKey(namespace);
  const key = sanitizeKey(account);
  try {
    await env.img_url.delete(`${RL_NS}:lock:${ns}:${key}`);
  } catch (error) {
    console.warn('[ratelimit] lock state delete failed:', error?.message || error);
  }
}
