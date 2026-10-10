/**
 * MCP (Model Context Protocol) 端点入口 —— Streamable HTTP，无状态。
 *
 * ============================================================================
 * 端点行为
 * ============================================================================
 *
 *   POST    /mcp   JSON-RPC 2.0 请求（单条对象，或批量数组）
 *   GET     /mcp   405 —— 本实现不提供 SSE 流（见 protocol.js 的说明）
 *   OPTIONS /mcp   204 —— CORS 预检
 *   其它方法        405
 *
 * `/mcp/anything` 与 `/mcp` 等价：客户端的会话信息走 header 而非路径，
 * 路径段在这里没有语义。用 `[[path]]` 通配是为了兼容把子路径当传输标识的
 * 个别实现，避免它们直接 404。
 *
 * ============================================================================
 * 与根中间件、目录中间件的关系
 * ============================================================================
 *
 *   functions/_middleware.js   安全响应头 + 全站通用限流（不含 /mcp）
 *   functions/mcp/_middleware.js  MCP 鉴权 L1/L2，注入 context.data.apiToken
 *   functions/mcp/[[path]].js   本文件：协议分发
 *
 * 也就是说，进入本文件时 Token **已经校验过了**。这里只做协议层的事。
 *
 * @module mcp/[[path]]
 */

import { envValue } from '../utils/env-config.js';
import { apiError } from '../utils/api-v1.js';
import { resolveCorsHeaders } from '../utils/cors.js';
import { writeAuditLog, AUDIT_EVENTS } from '../utils/audit.js';
import { getMcpConfig } from '../utils/runtime-config.js';
import { dispatchTool, listToolsFor } from './tools.js';
import {
  MAX_BODY_BYTES,
  RPC_ERROR_CODES,
  SERVER_CAPABILITIES,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  isMcpEnabled,
  isNotificationMethod,
  jsonResponse,
  methodNotFound,
  negotiateProtocolVersion,
  parseRpcBody,
  rpcError,
  rpcResult,
  toolResult,
  validateRpcEnvelope,
} from './protocol.js';

/**
 * 读取请求体，并施加体积上限。
 *
 * 先看 Content-Length（免费），再在流式读取时累计字数兜底 ——
 * 后者防的是「声明小、实际大」的分块请求。超限返回 null 由调用方转 413。
 */
async function readBodyWithinLimit(request, limit) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declared) && declared > limit) return null;

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    // 提前 return 时 reader 已被 cancel，无需再次处理。
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 处理单条已校验的请求，返回 JSON-RPC 响应对象；通知类返回 null。 */
async function handleSingle(context, message, env, request, waitUntil) {
  const envelope = validateRpcEnvelope(message);
  if (!envelope.ok) {
    return rpcError(envelope.id, envelope.code, envelope.message);
  }

  const { id, method, params } = envelope;

  // 通知：服务端不得回复 body。initialized 是客户端握手完成信号，
  // 其余 notifications/* 本实现不消费，静默吞掉即可（吞掉 ≠ 报错）。
  if (isNotificationMethod(method)) return null;

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'initialize') {
    // 未带 Token 的握手：回协议版本与 serverInfo（客户端靠它完成协商），
    // 但**不声明 tools 能力**、**不给 instructions** —— 不暴露工具清单，
    // 也就不会诱导客户端去调一个它必然拿不到权限的 tools/list。
    // 这是「握手免鉴权」与「不泄露信息」之间的平衡点。
    const authed = Boolean(context.data?.apiToken);
    return rpcResult(id, {
      // 版本协商：未命中时回服务端最新版，而不是报错。
      // 客户端拿到回包后自行决定是否继续 —— 这是规范的既定分工。
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: authed ? SERVER_CAPABILITIES : {},
      serverInfo: SERVER_INFO,
      ...(authed ? { instructions: SERVER_INSTRUCTIONS } : {}),
    });
  }

  // ↓↓↓ 以下方法涉及数据访问 / 权限判定，必须有 Token（握手方法已在上面放行）↓↓↓
  const token = context.data?.apiToken;
  if (!token) {
    // 传输层鉴权失败 → HTTP 401（不是 JSON-RPC error 信封）。
    // 用哨兵对象返回，由外层转成带状态的 Response —— 保持 handleSingle
    // 的返回类型统一（都是可 JSON 序列化的对象），避免混入 Response 实例。
    return { __transportError: true, status: 401, body: {
      success: false,
      error: {
        code: 'TOKEN_INVALID',
        message: `API Token is required for ${method}.`,
      },
    } };
  }

  if (method === 'tools/list') {
    // 两级过滤：先剔除管理员禁用的工具，再按 Token scope 收敛。
    // 顺序无关紧要（两个条件互不影响），但「先策略后权限」读起来更贴近
    // 语义 —— 禁用是部署级策略，scope 是调用方权限。
    // dispatchTool 会把这层策略**再校验一遍** —— 列表过滤只影响可发现性，
    // 不能当成安全边界（客户端完全可以硬编码工具名直接 call）。
    return rpcResult(id, {
      tools: listToolsFor(token, env, context.data?.mcpDisabledTools || []),
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params: "name" must be a non-empty string.');
    }
    const args = params?.arguments;
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params: "arguments" must be an object.');
    }

    const toolName = name.trim();
    const outcome = await dispatchTool(context, id, toolName, args || {});

    if (outcome.notFound) {
      // 工具名不存在属于参数问题（调用方给的名字无效），不是「方法不存在」——
      // method 是 "tools/call"，工具名是它的参数。
      return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${toolName}`);
    }

    if (outcome.denied) {
      // 拒绝分两种：scope 不足（凭据配错）与工具被管理员禁用（部署策略）。
      // 都按**业务错误**回（result.isError），不是 JSON-RPC 协议错误：
      // 协议上这次调用完全合法，只是不被允许，模型需要看到这个事实而不是被
      // 当成协议故障。审计里用不同 detail 区分，否则运维从日志上分不清
      // 「该给 Token 加 scope」还是「去后台把这个工具打开」。
      // toolError 把 payload 序列化成 content[0].text（见 protocol.js 的
      // toolResult），结构化字段并不在顶层，所以这里解一次 JSON 取 error.code；
      // 解析不出来（非常规响应）时按 scope 拒绝归档，不影响主流程。
      let deniedCode = 'TOKEN_SCOPE_DENIED';
      try {
        const payload = JSON.parse(outcome.denied?.content?.[0]?.text || '{}');
        if (payload?.error?.code === 'TOOL_DISABLED') deniedCode = 'TOOL_DISABLED';
      } catch {
        // 保持默认值
      }
      waitUntil?.(
        writeAuditLog(env, {
          event: AUDIT_EVENTS.MCP_TOOL_DENIED,
          tokenId: context.data?.apiToken?.id || null,
          operation: `tools/call ${toolName}`.slice(0, 64),
          success: false,
          client: String(request.headers.get('User-Agent') || '').slice(0, 60) || 'unknown',
          detail: deniedCode,
        }).catch(() => {})
      );
      return rpcResult(id, outcome.denied);
    }

    // 成功执行 → 记一条审计，便于回答「谁在什么时候动了什么」。
    waitUntil?.(
      writeAuditLog(env, {
        event: AUDIT_EVENTS.MCP_TOOL_CALL,
        tokenId: context.data?.apiToken?.id || null,
        operation: `tools/call ${toolName}`.slice(0, 64),
        success: true,
        client: String(request.headers.get('User-Agent') || '').slice(0, 60) || 'unknown',
        detail: null,
      }).catch(() => {})
    );

    return rpcResult(id, outcome.result);
  }

  return methodNotFound(id, method);
}

/** 按 HTTP 语义回一个 405，并声明允许的方法。 */
function methodNotAllowed() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Allow: 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // fail-closed 的开关判定在 `_middleware.js` 里（必须在鉴权之前，否则未开启时
  // 会先返回 401、反而确认了端点的存在）。这里只做兜底断言：正常路径下
  // 中间件已经把关，走到这里必然已开启。
  if (!isMcpEnabled(env, envValue)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store' },
    });
  }

  const corsHeaders = await resolveCorsHeaders(request, env);
  const withCors = (response) => {
    try {
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
    } catch {
      // 只读 headers：跳过
    }
    return response;
  };

  const method = String(request.method || 'GET').toUpperCase();

  // 预检已在目录中间件处理；这里兜底（中间件在 fail-closed 之后才会执行到）。
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (method !== 'POST') {
    // 无状态模式不提供 SSE（GET）、也不提供会话终止（DELETE）。
    return withCors(methodNotAllowed());
  }

  // ⚠️ 这里**不再**做「无 token 即 401」的兜底守卫。
  //
  // 原因：鉴权粒度已经下沉到「单个 JSON-RPC 方法」——同一个 HTTP 请求里，
  // initialize 允许匿名，tools/call 不允许。在 body 解析之前按 HTTP 层面
  // 一刀切，会把合法的匿名握手请求也拒掉。判定统一放在 handleSingle 里，
  // 那里才知道这次调用的是哪个 method。批量请求也因此逐条独立判定，
  // 语义更精确。

  // 工具级禁用清单：每个请求回源读一次（含 30s isolate 缓存），
  // 挂到 context.data 上供 tools/list 过滤与 tools/call 拒绝共用。
  //
  // 为什么在这里读、而不是在 _middleware.js：
  //   中间件的开关判定必须是同步的（见协议层 isMcpEnabled 的说明），
  //   而这里已经是 async 上下文，可以承担这一次 KV 回源。放在路由层还有
  //   一个好处：批量请求里的所有条目共用同一次读取，不会逐条重复回源。
  //
  // 读取失败**不**让请求失败：回退为空清单（= 不额外禁用任何工具），
  // 总开关（fail-closed）已在中间件把关。配置读不出来时让已开启的 MCP
  // 退化为「全部工具可用」，比整站 500 更符合"配置故障不该放大成事故"。
  const mcpConfig = await getMcpConfig(env).catch((e) => {
    console.error('MCP config read error, falling back to no tool restrictions:', e);
    return null;
  });
  context.data = context.data || {};
  context.data.mcpDisabledTools = Array.isArray(mcpConfig?.disabledTools)
    ? mcpConfig.disabledTools
    : [];

  let raw;
  try {
    raw = await readBodyWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return withCors(apiError('BAD_REQUEST', 'Failed to read request body.', 400));
  }
  if (raw === null) {
    return withCors(
      apiError('PAYLOAD_TOO_LARGE', `MCP request body exceeds ${MAX_BODY_BYTES} bytes.`, 413)
    );
  }

  const parsed = parseRpcBody(raw);
  if (!parsed.ok) {
    // -32700 是协议错误 → HTTP 200 + error 信封（传输层与协议层状态分离）。
    return withCors(jsonResponse(rpcError(null, parsed.code, parsed.message)));
  }

  const waitUntil = typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : null;

  // 批量请求：逐条处理，过滤掉通知（无响应体）后一并返回。
  if (Array.isArray(parsed.value)) {
    if (parsed.value.length === 0) {
      return withCors(
        jsonResponse(rpcError(null, RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: empty batch.'))
      );
    }
    const responses = [];
    let transportError = null;
    for (const item of parsed.value) {
      // 单条失败不影响同批次其它请求 —— 这是 JSON-RPC 批量的既定语义。
      const one = await handleSingle(context, item, env, request, waitUntil);
      if (one && one.__transportError) {
        // 批内某条需要 Token 但没带：整体按传输层错误回（HTTP 401），
        // 因为「这次 HTTP 请求就没通过鉴权」，逐条 200 会掩盖这个事实。
        transportError = transportError || one;
        continue;
      }
      if (one) responses.push(one);
    }
    if (transportError) {
      return withCors(jsonResponse(transportError.body, transportError.status));
    }
    // 全是通知：规范允许回 202 且无 body。
    if (responses.length === 0) {
      return withCors(new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } }));
    }
    return withCors(jsonResponse(responses));
  }

  let response;
  try {
    response = await handleSingle(context, parsed.value, env, request, waitUntil);
  } catch (error) {
    // 未捕获异常 → -32603。message 在 rpcError 内部已过 redactSecrets，
    // 因此即便异常文本里夹带了凭证也不会外泄。
    return withCors(
      jsonResponse(rpcError(null, RPC_ERROR_CODES.INTERNAL_ERROR, error?.message || 'Internal error.'))
    );
  }

  if (response === null) {
    // 通知：202 且无 body。
    return withCors(new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } }));
  }

  // 传输层错误（如缺 Token 的 tools/call）：以 HTTP 状态码返回，而非 200。
  if (response.__transportError) {
    return withCors(jsonResponse(response.body, response.status));
  }

  return withCors(jsonResponse(response));
}

// 显式导出，供测试直接引用（避免测试通过 onRequest 间接构造完整上下文）。
export { handleSingle, readBodyWithinLimit, toolResult };
