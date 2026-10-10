/**
 * MCP 端点目录级中间件 —— 鉴权第一、二层。
 *
 * ============================================================================
 * 为什么不复用 functions/api/v1/_middleware.js
 * ============================================================================
 *
 * v1 的中间件靠**请求路径**推断所需 scope（`resolveRequiredScope`：/upload → upload、
 * /files → read …）。而 MCP 是单一入口 `/mcp`，工具名藏在 POST body 里，
 * HTTP 层面根本看不出这次调用要什么权限 —— 路径推导在这里无从下手。
 *
 * 因此改成分层：
 *   L1（本文件）    只校验 Token 有效性，不校验任何 scope → 注入 context.data.apiToken
 *   L3（tools.js）  在分发到具体工具时，按该工具声明的 requiredScope 二次校验
 *
 * 这样既能复用同一套 Token 存储与哈希校验，又不会把「工具级权限」错误地
 * 提前到「连接级」—— 否则一个 read-only 的 Agent 连 tools/list 都拿不到。
 *
 * ============================================================================
 * 握手方法免鉴权（条件鉴权）
 * ============================================================================
 *
 * `initialize` / `ping` / `notifications/*` 属于**协议层握手**，本层放行、
 * 不要求 Token；`tools/list` 与 `tools/call` 才强制鉴权。
 *
 * 为什么不在中间件里直接卡死全部请求：
 *
 *   1) 主流 MCP 客户端（Claude Desktop、各 SDK）在 initialize 阶段尚未发送
 *      Authorization —— 它们把「连接建立」与「凭据提供」分两步。若握手就 401，
 *      客户端在拿到 capabilities 之前就断了，无法协商、无法降级。
 *   2) initialize 只回静态能力声明（协议版本 / serverInfo / instructions），
 *      不含任何用户数据、不含工具清单，放行不构成信息泄露。
 *      工具清单（tools/list）仍然需要 Token，且**按 scope 过滤**。
 *
 * 实现上刻意**不在这里解析 body**：中间件读流会消费掉 request.body，
 * 下游 [[path]].js 就拿不到原始字节了。改由两层配合 ——
 *   本层：有 Token 就校验并注入；无 Token 则「裸放行」，**不注入** apiToken。
 *   路由层：对 tools/list、tools/call 检查 context.data.apiToken 是否存在，
 *          缺失即回 401。这样职责单一，且中间件不必懂 JSON-RPC。
 *
 * 「失败即关闭」没有被削弱：tools/* 依然强制 Token，未开启 MCP 依然 404。
 *
 * @module mcp/_middleware
 */

import { checkTokenRateLimit, parseBearerToken, touchApiTokenUsage, verifyApiToken } from '../utils/api-token.js';
import { apiError } from '../utils/api-v1.js';
import { handleApiPreflight, resolveCorsHeaders } from '../utils/cors.js';
import { writeAuditLog, AUDIT_EVENTS } from '../utils/audit.js';
import { getClientIp } from '../utils/ratelimit.js';
import { envValue } from '../utils/env-config.js';
import { getMcpConfig } from '../utils/runtime-config.js';
import { isMcpEnabled } from './protocol.js';

/**
 * isolate 内固定窗口限流。
 *
 * 根级 `functions/_middleware.js` 的通用限流只覆盖 `/api/`、`/file/`、`/upload`
 * 三个前缀，`/mcp` 不在其中。与其去改全站中间件（影响面大、回头还得再验证一遍），
 * 不如在这里做一份局部限流 —— 目录级中间件只作用于自己的子树，边界清晰。
 *
 * 只做 isolate 内计数（零 KV 开销）：挡得住打在同一个 isolate 上的脚本洪水，
 * 而跨 isolate 的强一致约束交给 per-token 的 checkTokenRateLimit 承担。
 */
const LOCAL_WINDOW_MS = 60 * 1000;
const LOCAL_MAX_PER_WINDOW = 300;
const localHits = new Map();

function localRateLimit(key) {
  const now = Date.now();
  const windowStart = Math.floor(now / LOCAL_WINDOW_MS) * LOCAL_WINDOW_MS;

  // 顺手清理过期窗口，避免 Map 随 IP 增长而无限膨胀。
  for (const [entryKey, entry] of localHits) {
    if (entry.windowStart !== windowStart) localHits.delete(entryKey);
  }

  const entry = localHits.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    localHits.set(key, { windowStart, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > LOCAL_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: windowStart + LOCAL_WINDOW_MS - now };
  }
  return { allowed: true };
}

function clientTag(request) {
  return String(request.headers.get('User-Agent') || '').slice(0, 60) || 'unknown';
}

export async function onRequest(context) {
  const { request, env } = context;

  // ⚠️ 开关检查必须放在**鉴权之前**（这里，而不是 [[path]].js 里）。
  //
  // 中间件先于同目录的 [[path]].js 执行，若把检查放在路由里，未开启时
  // 会先被这里的鉴权拦下返回 401 —— 那等于告诉探测者「这个端点是存在的，
  // 只是你没带凭证」，恰好抵消了 fail-closed 想要的效果。
  // 未开启时应当干脆 404，与「根本不存在的路径」无法区分。
  //
  // 这里 await 一次配置回源（getMcpConfig，KV 覆盖 > 环境基线，带 30s
  // isolate 缓存）。早先为「零 KV 往返」改读内存镜像，结果镜像只在保存配置
  // 的那个 isolate、且仅 30 秒内有效，过期后回退到未配置的环境变量 → 永久
  // 404。详见 protocol.js 中 isMcpEnabled 的说明。
  //
  // 读到的整组配置顺手挂到 context.data.mcpConfig，供 [[path]].js 复用，
  // 避免同一请求内二次回源。
  context.data = context.data || {};
  context.data.mcpConfig = await getMcpConfig(env).catch((e) => {
    console.error('MCP config read error, falling back to enabled check via env:', e);
    return null;
  });

  if (!(await isMcpEnabled(env, envValue))) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store' },
    });
  }

  // 预检必须最先处理且不要求 Bearer —— 浏览器在发送真正的 POST 之前先发 OPTIONS，
  // 此时还带不上 Authorization。
  if (request.method === 'OPTIONS') {
    return await handleApiPreflight(request, env);
  }

  if (!env?.img_url) {
    return apiError('SERVER_MISCONFIGURED', 'KV binding img_url is not configured.', 500);
  }

  const corsHeaders = await resolveCorsHeaders(request, env);
  const applyCors = (response) => {
    if (!response || !response.headers) return response;
    for (const [key, value] of Object.entries(corsHeaders)) {
      try {
        response.headers.set(key, value);
      } catch {
        // 只读 headers 跳过即可，不影响主流程
      }
    }
    return response;
  };

  const ip = getClientIp(request) || 'unknown';
  const local = localRateLimit(ip);
  if (!local.allowed) {
    const limited = apiError('RATE_LIMITED', 'Too many MCP requests from this client.', 429);
    limited.headers.set('Retry-After', String(Math.max(Math.ceil(local.retryAfterMs / 1000), 1)));
    return applyCors(limited);
  }

  const tokenValue = parseBearerToken(request);

  // 无 Bearer：放行但不注入 apiToken，交由 [[path]].js 按方法决定是否拒绝。
  // 打到这里的是「还没带凭据的握手请求」——由下游区分 initialize（放行）
  // 与 tools/*（401）。注意这里**不能**直接 401，否则 initialized 之前
  // 的 initialize 就被拦掉，客户端无法完成协商。
  if (!tokenValue) {
    context.data = context.data || {};
    context.data.apiToken = null;
    return applyCors(await context.next());
  }

  // requiredScope 传 '@me'：本层只确认「凭证有效」，不涉及任何具体权限。
  const verifyResult = await verifyApiToken(tokenValue, env, '@me');

  if (!verifyResult.ok) {
    // 审计与遥测都不阻塞响应：用 waitUntil 异步落盘。
    context.waitUntil?.(
      writeAuditLog(env, {
        event: AUDIT_EVENTS.TOKEN_VERIFY_FAILED,
        operation: `MCP ${request.method} /mcp`,
        success: false,
        client: clientTag(request),
        detail: verifyResult.code || 'TOKEN_INVALID',
      }).catch(() => {})
    );
    context.waitUntil?.(
      touchApiTokenUsage(extractTokenId(tokenValue), env, {
        success: false,
        operation: `MCP ${request.method} /mcp`.slice(0, 64),
        client: clientTag(request),
      }).catch(() => {})
    );

    return applyCors(
      apiError(
        verifyResult.code || 'TOKEN_INVALID',
        verifyResult.message || 'API Token is invalid.',
        verifyResult.status || 401
      )
    );
  }

  // L2：per-token 限流（含跨 isolate 语义，计数存 KV）。
  const rateLimit = await checkTokenRateLimit(verifyResult.token, env);
  if (!rateLimit.allowed) {
    const limited = apiError('RATE_LIMITED', 'API Token rate limit exceeded.', 429, {
      retryAfterMs: rateLimit.retryAfterMs,
    });
    limited.headers.set('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    return applyCors(limited);
  }

  // 沿用 v1 的既有约定：把 token 记录挂在 context.data.apiToken 上，
  // 供 tools.js 做工具级 scope 校验、供 handlers 透传给下游做策略/幂等。
  context.data = context.data || {};
  context.data.apiToken = verifyResult.token;

  const touchPromise = touchApiTokenUsage(verifyResult.token.id, env, {
    success: true,
    operation: 'MCP POST /mcp'.slice(0, 64),
    client: clientTag(request),
  }).catch(() => {});
  context.waitUntil?.(touchPromise);

  return applyCors(await context.next());
}

function extractTokenId(tokenValue) {
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_/.exec(String(tokenValue || '').trim());
  return match ? match[1] : '';
}
