/**
 * MCP (Model Context Protocol) 协议层 —— 常量与纯函数。
 *
 * ============================================================================
 * 为什么单独拆一个文件
 * ============================================================================
 *
 * `[[path]].js` 是 Pages Functions 的入口，import 它会连带拉起整条路由依赖链
 * （cors / audit / api-v1 …）。把协议逻辑（版本协商、JSON-RPC 信封、错误码）
 * 抽成**无依赖纯函数**后，`scripts/test-mcp.mjs` 可以直接 import 本文件做单测，
 * 不必起 wrangler，也不必构造完整 Request 上下文。
 *
 * ============================================================================
 * 传输形态：Streamable HTTP（无状态）
 * ============================================================================
 *
 * · POST /mcp 承载 JSON-RPC 2.0 请求（单条或批量数组）。
 * · GET  /mcp 返回 405 —— 本实现**不提供 SSE 流**。
 *
 * 为什么不做 SSE：
 *   Cloudflare Pages Functions 无常驻进程，SSE 需要长连接 + 服务端主动推送
 *   （如 tools/list_changed 通知）。MCP 规范明确允许服务端不提供 SSE，客户端
 *   在 405 后会退化为纯请求-响应模式。对 Serverless 而言这是唯一合理取舍。
 *
 * 为什么不实现 Mcp-Session-Id：
 *   规范允许服务端不分配 session（此时客户端不得发送该头）。维护 session 需要
 *   落 KV 并在每个请求回读一次，而本项目的 KV 免费额度只有 1000 写/天、读也
 *   敏感 —— 为了一个「有状态的 MCP」付出每请求一次额外读，性价比为零。
 *   无状态还带来一个好处：每个 POST 自包含，天然吻合 Serverless 的请求模型。
 *
 * @module mcp/protocol
 */

import { redactSecrets } from '../utils/redact.js';
import { getMcpConfig } from '../utils/runtime-config.js';

/** JSON-RPC 2.0 版本串。协议固定值，不随 MCP 版本变化。 */
export const JSONRPC_VERSION = '2.0';

/**
 * 支持的 MCP 协议版本，**按新 → 旧排列**。
 * 顺序即优先级：协商时取列表首项作为「服务端最新版」。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 服务端自身信息，回给 initialize。 */
export const SERVER_INFO = {
  name: 'k-vault-next',
  version: '1.0.0',
};

/**
 * 服务端能力声明。
 *
 * ⚠️ 只声明 tools。声明 resources / prompts / logging / completions 会诱导
 * 客户端去调用对应方法，而本实现没有它们，结果是 -32601 一路报错。
 * 「能力声明」的语义是承诺，不是菜单。
 *
 * tools.listChanged=false：工具集是静态的（由 token scopes 决定，不随会话变化），
 * 服务端不会推送变更通知 —— 与「不实现 SSE」保持一致。
 */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
};

/**
 * 给模型的引导语。MCP 客户端的 initialize 响应会把它注入 system prompt，
 * 是模型理解「这个 server 是干什么的」的唯一线索，因此值得写清楚。
 */
export const SERVER_INSTRUCTIONS = [
  'K-Vault-Next 是一个 serverless 文件托管服务（云盘 / 图床）。',
  '工具能力：kvault_capabilities 查看已启用的存储后端与上传上限；',
  'kvault_upload_file 上传小文件（base64，建议 ≤512KB）；',
  'kvault_import_url 让服务端抓取远程 URL 入库（远程大文件请走这个）；',
  'kvault_list_files / kvault_get_file_info / kvault_get_file 浏览与取回；',
  'kvault_manage_share 为**已有文件**创建 / 修改 / 取消分享链接；',
  'kvault_delete_file 删除；kvault_create_paste / kvault_list_pastes 管理文本片段。',
  '工具可见性由 API Token 的 scopes（upload / read / delete / paste / share）决定：',
  'tools/list 只会列出当前 Token 有权调用的工具。',
].join(' ');

/**
 * JSON-RPC 2.0 标准错误码。
 *
 * 规范原文（JSON-RPC 2.0 §5.1）：
 *   -32700 Parse error      —— 服务端收到无效 JSON
 *   -32600 Invalid Request  —— 不是合法的 Request 对象
 *   -32601 Method not found —— 方法不存在 / 不可用
 *   -32602 Invalid params   —— 参数非法
 *   -32603 Internal error   —— 服务端内部错误
 */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/** 单条请求体上限：base64 上传走这里，1MiB 约等于 750KB 原始文件。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 协议版本协商。
 *
 * 规范要求：服务端**必须**返回一个自己支持的版本，哪怕客户端给的不在列表里。
 * 因此未命中时回服务端最新版（列表首项），而不是报错 —— 报错会让客户端直接
 * 断开，且「版本不兼容」本应由客户端拿到回包后自行判断。
 *
 * @param {unknown} clientVersion 客户端 params.protocolVersion
 * @returns {string} 服务端选定并支持的协议版本
 */
export function negotiateProtocolVersion(clientVersion) {
  const requested = String(clientVersion ?? '').trim();
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * 构造 JSON-RPC 成功响应。
 * @param {string|number|null} id
 * @param {object} result
 */
export function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result };
}

/**
 * 构造 JSON-RPC 错误响应。
 *
 * message 统一过 redactSecrets：内部异常文本可能夹带 `kvault_<id>_<secret>`
 * 这类凭据，而错误信息是最容易被随手贴进 issue / 日志的地方。
 *
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {object} [data]
 */
export function rpcError(id, code, message, data) {
  const error = { code, message: redactSecrets(String(message ?? 'Unknown error')) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error };
}

/** 协议层错误（-32601/-32602）的便捷构造器。 */
export function methodNotFound(id, method) {
  return rpcError(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${String(method ?? '')}`);
}

export function invalidParams(id, message) {
  return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, message || 'Invalid params.');
}

/**
 * MCP tools/call 的成功结果信封。
 *
 * 所有工具的产出统一包成**单个 text content**（内容是内部 handler 的 JSON
 * 字符串），理由：
 *   · 零歧义、跨客户端兼容最好 —— content 数组的元素类型各家实现支持不一；
 *   · Agent 拿到的是结构化 JSON，可直接解析出 id / links，比自然语言可靠。
 *
 * 二进制（kvault_get_file）**不**内联字节：base64 会放大 33% 且受 body 限制，
 * 而图床场景下 Agent 真正需要的是可分发链接，不是像素。
 *
 * @param {object} payload 已序列化好的对象
 * @param {boolean} [isError]
 */
export function toolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: Boolean(isError),
  };
}

/** 工具级失败：业务错误（如 FILE_NOT_FOUND）走这里，而非 JSON-RPC error。 */
export function toolError(code, message, extra = {}) {
  return toolResult(
    { success: false, error: { code, message: redactSecrets(String(message ?? '')), ...extra } },
    true
  );
}

/**
 * 解析请求体文本为 JSON-RPC 消息。
 *
 * 返回判别式结果而非抛异常：解析失败是**预期内的协议分支**（-32700），
 * 用异常表达会让调用方不得不写 try/catch 包住一个正常流程。
 *
 * @param {string} raw
 * @returns {{ok: true, value: unknown} | {ok: false, code: number, message: string}}
 */
export function parseRpcBody(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, code: RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error: empty body.' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      code: RPC_ERROR_CODES.PARSE_ERROR,
      message: `Parse error: ${error?.message || 'invalid JSON'}`,
    };
  }
}

/**
 * 校验单条 JSON-RPC 请求的信封合法性。
 *
 * 只做**信封**校验（jsonrpc / method / id 类型），不碰 params 语义 ——
 * params 的形状由各方法自己负责，混在一起会让错误码归属变得含糊。
 *
 * @param {unknown} message
 * @returns {{ok: true, id: string|number|null, method: string, params: object, isNotification: boolean}
 *          | {ok: false, id: string|number|null, code: number, message: string}}
 */
export function validateRpcEnvelope(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {
      ok: false,
      id: null,
      code: RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid Request: message must be a JSON-RPC object.',
    };
  }

  const rawId = message.id;
  // id 允许 string / number / null(notification) / 缺失(notification)。
  // 其它类型（对象、数组、布尔）无法回显，按规范判为 Invalid Request。
  const idValid =
    rawId === undefined ||
    rawId === null ||
    typeof rawId === 'string' ||
    typeof rawId === 'number';
  if (!idValid) {
    return {
      ok: false,
      id: null,
      code: RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid Request: "id" must be a string, number, or null.',
    };
  }

  if (message.jsonrpc !== JSONRPC_VERSION) {
    return {
      ok: false,
      id: rawId ?? null,
      code: RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid Request: "jsonrpc" must be exactly "2.0".',
    };
  }

  if (typeof message.method !== 'string' || !message.method.trim()) {
    return {
      ok: false,
      id: rawId ?? null,
      code: RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid Request: "method" must be a non-empty string.',
    };
  }

  const params = message.params;
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    return {
      ok: false,
      id: rawId ?? null,
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: 'Invalid params: "params" must be an object when present.',
    };
  }

  return {
    ok: true,
    id: rawId ?? null,
    method: message.method.trim(),
    params: params || {},
    // 无 id 即通知：服务端不得回复 body（HTTP 202）。
    isNotification: rawId === undefined || rawId === null,
  };
}

/** 判断是否通知类方法（除 initialized 外，其余 notifications/* 一律静默吞掉）。 */
export function isNotificationMethod(method) {
  const name = String(method || '');
  // 兼容旧客户端把 initialized 写成裸方法名的情况。
  return name === 'notifications/initialized' || name === 'initialized' || name.startsWith('notifications/');
}

/**
 * MCP 是否启用（fail-closed）。
 *
 * 默认**关闭**：新增的网络面不应因为「部署时忘了配」而自动对公网敞开。
 *
 * ============================================================================
 * 取值优先级：后台运行时配置（KV）> 环境变量 MCP_ENABLED
 * ============================================================================
 *
 * 这样管理员可以在后台随时开关 MCP，不必改环境变量并重新部署 —— 与
 * WebDAV / 隔空投送等既有分组完全一致。
 *
 * 为什么保留 envValue 参数（而不是直接读 env.MCP_ENABLED）：
 *   历史写法用 `isMcpEnabled(env, envValue)`，envValue 会做大小写归一
 *   （把 `MCP_ENABLED` / `mcp_enabled` 都认出来）。这里把 envValue 作为
 *   **读取失败时的兜底**继续用，保证老部署的 `mcp_enabled=true` 不会被忽略。
 *
 * ============================================================================
 * 为什么是**异步回源**，而不是同步读内存镜像
 * ============================================================================
 *
 * 早期版本为了「在鉴权之前零 KV 往返地判断开关」，改读模块级内存镜像
 * （readMcpEnabledSync）。但这个方案有两个硬伤，最终表现为生产环境
 * 「后台开了 MCP，过一会儿访问 /mcp 却永久 404」：
 *
 *   1) 镜像**只在保存过配置的那个 isolate 里有效**。生产是多 isolate 的，
 *      绝大多数请求落到别的 isolate，根本没有镜像。
 *   2) 镜像有 30 秒 TTL（CACHE_TTL_MS）。一旦过期就返回 null，判定随即
 *      **回退到环境变量 MCP_ENABLED** —— 而后台保存的开关只存在 KV 里，
 *      环境变量通常没配，于是回退结果恒为 false。
 *
 * 等于把「跨 isolate 的 30 秒生效延迟」放大成了「永久关闭」。
 *
 * 正确做法就是回源：每次调用都走 getMcpConfig（KV 覆盖 > 环境基线），
 * 它本身带 30 秒 isolate 缓存，因此同 isolate 内的高频 /mcp 请求并不会
 * 反复打 KV。代价上也不吃亏 —— 路由层（[[path]].js）本来就要为工具禁用
 * 清单回源读一次，现在这次读提前到中间件、结果经 context.data 复用，
 * 总 KV 读次数不增反减。
 *
 * 调用方（mcp/_middleware.js、mcp/[[path]].js）本就处于 async 上下文，
 * `await` 放在**预检与鉴权之前**，fail-closed 语义不变：未开启依旧 404，
 * 与「根本不存在的路径」无法区分。
 *
 * @param {object} env
 * @param {(env: object, name: string) => string} envValue
 * @returns {Promise<boolean>}
 */
export async function isMcpEnabled(env, envValue) {
  // 环境变量 MCP_ENABLED 的宽容解析：`true / 1 / yes / on`（大小写不敏感）。
  // 这是**历史行为**，很多老部署写的是 `mcp_enabled=1` 或 `=on`。配置层
  // 的 fromEnv 只认字面量 'true'（与 guest/webdav 同源，供后台视图展示），
  // 因此在这里单独放宽，避免老部署升级后开关莫名失效。
  const envEnabled = () => {
    const raw = String(envValue(env, 'MCP_ENABLED') ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
  };

  let cfg;
  try {
    cfg = await getMcpConfig(env);
  } catch (e) {
    // KV 读取异常时的兜底：退到环境变量基线。
    // 宁可沿用部署期设定，也不要因为一次读失败就把已开启的端点关掉。
    console.error('MCP enabled check fell back to env var:', e);
    return envEnabled();
  }

  // KV 有明确覆盖（source='kv'）时**一律以 KV 为准** —— 包括 false。
  // 否则会出现「后台关了 MCP，却被环境变量的 true 顶回开启」的静默失效。
  if (cfg?.source === 'kv') return cfg.enabled === true;

  // 无 KV 覆盖：以环境变量基线为准，沿用上面的宽容解析。
  return envEnabled();
}

/** 响应统一 JSON：MCP 客户端会同时接受 application/json 与 text/event-stream。 */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 无状态 + 带鉴权，任何中间缓存都不得留存。
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}
