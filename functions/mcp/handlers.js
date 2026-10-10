/**
 * MCP 工具执行层 —— 把工具调用翻译成对现有 API v1 的内部调用。
 *
 * ============================================================================
 * 核心原则：复用，而不是重写
 * ============================================================================
 *
 * `functions/api/v1/*` 本身就已经是「合成 context → 调内部 handler」的适配层：
 *
 *   · v1/upload.js       → uploadInternal({ ...context, request: proxiedRequest })
 *   · v1/files.js        → listFilesInternal(context)
 *   · v1/file/[[path]].js → serveFileInternal({ ...context, params })
 *
 * 于是 MCP 这一层**不再重新实现业务逻辑**，只负责构造一个「看起来像真的」
 * Request + context，再调用 v1 的 onRequest。这样一来，策略校验
 * （checkUploadPolicy）、幂等（Idempotency-Key）、内容去重、审计、遥测、
 * SSRF 防护 —— 全部自动继承。
 *
 * 反过来，若在这里重写一份上传，第二份实现必然与 v1 漂移：某个字段忘了带、
 * 某条策略忘了查，而这类缺陷在测试里往往看不出来（因为测试也测的是新实现）。
 *
 * ============================================================================
 * 为什么必须用真实 origin 合成 URL
 * ============================================================================
 *
 * 下游 handler 用 `buildAbsoluteUrl(request, path)` 生成下载 / 分享链接，
 * 而它取的是 request.url 的 origin。若这里随便塞个占位 origin，返回给 Agent
 * 的链接就是死链。因此合成 URL 必须以**本次 MCP 请求的真实 origin** 为基准。
 *
 * @module mcp/handlers
 */

// 注意导入的具体导出名：并非所有 v1 模块都提供统一的 `onRequest`。
// capabilities.js 与 me.js 只导出 onRequestGet（它们各自只有 GET 语义，
// 没有做方法兜底），因此这里按实际导出名导入 —— 写成 onRequest 会在
// 模块链接阶段直接抛 SyntaxError，整个 /mcp 端点起不来。
import { onRequestGet as v1Capabilities } from '../api/v1/capabilities.js';
import { onRequestGet as v1Me } from '../api/v1/me.js';
import { onRequest as v1Upload } from '../api/v1/upload.js';
import { onRequest as v1Import } from '../api/v1/import.js';
import { onRequest as v1Files } from '../api/v1/files.js';
import { onRequest as v1File } from '../api/v1/file/[[path]].js';
import { onRequest as v1FileInfo } from '../api/v1/file/[[path]]/info.js';
import { onRequest as v1FileShare } from '../api/v1/file/[[path]]/share.js';
import { onRequest as v1Paste } from '../api/v1/paste.js';
import { onRequest as v1Pastes } from '../api/v1/pastes.js';
import { toolError, toolResult } from './protocol.js';

/** base64 解码：MCP 的 arguments 是 JSON，二进制只能走 base64。 */
function decodeBase64(input) {
  const raw = String(input ?? '').trim();
  // 容忍 data URL 形态（`data:image/png;base64,xxxx`）——模型经常这么给。
  const commaIndex = raw.indexOf(',');
  const payload = raw.startsWith('data:') && commaIndex !== -1 ? raw.slice(commaIndex + 1) : raw;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 从 data URL 里顺带把 mime 解析出来，省得用户还要单独传 mimeType。 */
function mimeFromDataUrl(input) {
  const match = /^data:([^;,]+)[;,]/.exec(String(input ?? ''));
  return match ? match[1] : '';
}

/**
 * 构造一个指向本站真实 origin 的合成 Request。
 *
 * Authorization 头会透传：v1 的 handler 大多通过 context.data.apiToken 拿凭证，
 * 但保留原始头可以让任何直接读 header 的中间逻辑也正常工作（防御性冗余）。
 */
function synthRequest(octx, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const origin = new URL(octx.request.url).origin;
  const url = new URL(pathname, origin);
  const merged = new Headers(headers);
  const auth = octx.request.headers.get('Authorization');
  if (auth) merged.set('Authorization', auth);
  const init = { method, headers: merged };
  // GET / HEAD 不允许带 body，传了会直接抛 TypeError。
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
    // workerd 对「带 body 的 Request」要求显式声明 duplex。传 Stream 时必须是
    // 'half'，传 BufferSource 时该字段被接受且不改变语义。加上它可避免不同
    // workerd 版本对 body 流的处理差异，属防御性写法。
    init.duplex = 'half';
  }
  return new Request(url.href, init);
}

/**
 * 构造下游 context。
 *
 * `data` 原样透传是关键：v1/upload.js 与 v1/import.js 会读
 * `context.data.apiToken` 做策略校验和幂等键归属，丢了它策略会静默失效
 * （token 变 null → 无策略 → 全部放行）。
 */
function baseCtx(octx, request, params = {}) {
  return {
    ...octx,
    request,
    params,
    data: octx.data || {},
  };
}

/**
 * 给上传类响应补一个顶层 `directLink` + `note`。
 *
 * ============================================================================
 * 为什么需要这一层包装
 * ============================================================================
 *
 * v1 的响应里链接藏在 `links.download`，字段名对模型来说不够直白 ——
 * 实测中模型会去翻 `file.url`（不存在）、或干脆把整个 `links` 对象当成
 * 「一堆链接」而复述给用户，而不是选出那个真正要用的直链。
 *
 * 顶层给它一个**唯一确定**的 `directLink`，模型选错的概率大幅下降。
 * 同时用 `note` 明确写出「这就是你要贴出去的地址」，因为指令性文字比
 * 结构化字段更容易被模型遵循。
 *
 * **不改 v1 契约**：`links` / `file` 原样保留，只是在外层加了两个键。
 * 直接调 REST 的客户端看不到任何变化，只有 MCP 的工具返回多这两个字段。
 * 这是刻意的 —— 内部适配层不该反向污染对外的 API 契约。
 */
function withDirectLink(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const download = payload?.links?.download;
  if (typeof download !== 'string' || !download) return payload;
  return {
    ...payload,
    directLink: download,
    note: `Direct link: ${download}`,
  };
}

/**
 * 把下游 handler 的 Response 归一化成 MCP content。
 *
 * 分两类：
 *   · JSON 响应 → 原样 JSON 文本，保留 code / links 等全部字段；
 *   · 非 JSON（文件字节流）→ **不回传字节**，改写为「可下载链接 + 状态」。
 *
 * 为什么二进制不内联：base64 会放大 33%，且客户端拿到几 MB 文本既无意义
 * 又容易撑爆上下文窗口。图床场景下 Agent 要的是链接。
 *
 * `emphasizeDirectLink`：把 `links.download` 提升为顶层 `directLink` 并附一句
 * `note`。**只对上传类工具开启**，原因见下方注释。
 *
 * @param {{emphasizeDirectLink?: boolean}} [options]
 */
async function normalizeResult(response, octx, id, { emphasizeDirectLink = false } = {}) {
  const contentType = String(response.headers.get('Content-Type') || '');
  const ok = response.ok;

  if (contentType.includes('application/json')) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      return toolError('UPSTREAM_INVALID_JSON', 'Upstream returned malformed JSON.', {
        status: response.status,
      });
    }
    // v1 的响应体已经是 `{success:...}` 信封，直接透传最省事也最保真。
    return toolResult(emphasizeDirectLink ? withDirectLink(payload) : payload, !ok);
  }

  // 非 JSON：一律当作二进制/文本流处理。
  // 顺带把内容读掉，否则 Worker 可能因为未消费的流而无法正常结束请求。
  let preview = '';
  try {
    const buf = await response.arrayBuffer();
    if (buf.byteLength <= 4096) {
      preview = new TextDecoder().decode(buf);
    }
  } catch {
    // 读取失败不影响链接返回
  }

  const origin = new URL(octx.request.url).origin;
  return toolResult(
    {
      success: ok,
      status: response.status,
      fileId: id,
      contentType: contentType || 'application/octet-stream',
      download: id ? `${origin}/file/${encodeURIComponent(id)}` : null,
      note: 'Binary content is not inlined. Use the download link above.',
      ...(preview ? { preview } : {}),
    },
    !ok
  );
}

/* ==========================================================================
 * 各工具实现
 * ========================================================================== */

async function runCapabilities(octx) {
  const request = synthRequest(octx, '/api/v1/capabilities', { method: 'GET' });
  const response = await v1Capabilities(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

async function runTokenInfo(octx) {
  const request = synthRequest(octx, '/api/v1/me', { method: 'GET' });
  const response = await v1Me(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

/**
 * 上传：v1/upload.js 强依赖 multipart/form-data，
 * 因此这里必须构造真正的 FormData（含 File 对象），而不是 JSON。
 */
async function runUploadFile(octx, args) {
  const content = String(args.contentBase64 ?? '');
  if (!content.trim()) {
    return toolError('VALIDATION_ERROR', 'Field "contentBase64" is required.');
  }

  let bytes;
  try {
    bytes = decodeBase64(content);
  } catch {
    return toolError('VALIDATION_ERROR', 'Field "contentBase64" is not valid base64.');
  }
  if (bytes.byteLength === 0) {
    return toolError('VALIDATION_ERROR', 'Decoded content is empty.');
  }

  const declaredMime = String(args.mimeType ?? '').trim();
  const mime = declaredMime || mimeFromDataUrl(content) || 'application/octet-stream';
  const fileName = String(args.fileName ?? '').trim() || 'upload.bin';

  const form = new FormData();
  form.append('file', new File([bytes], fileName, { type: mime }));

  // 可选项：只透传用户真正给了的，避免把 undefined 塞成字符串 "undefined"。
  const optionalFields = [
    ['storage', args.storage],
    ['folderPath', args.folderPath],
    ['slug', args.slug],
    ['password', args.password],
  ];
  for (const [key, value] of optionalFields) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      form.append(key, String(value));
    }
  }
  // v1/upload.js 读的是 `expires_in` / `max_downloads`（下划线命名）。
  if (args.expiresIn !== undefined && args.expiresIn !== null && args.expiresIn !== '') {
    form.append('expires_in', String(args.expiresIn));
  }
  if (args.maxDownloads !== undefined && args.maxDownloads !== null && args.maxDownloads !== '') {
    form.append('max_downloads', String(args.maxDownloads));
  }

  // 把 FormData 序列化成**已缓冲的字节**再交给合成请求，而不是直接把 FormData
  // 对象塞进 Request 的 body。
  //
  // 原因：`new Request(url, { body: formData })` 在 Node(undici) 下一切正常，
  // 但 workerd 对「构造出的 FormData body 流」的处理与真实入站请求不同 ——
  // 上游解析 multipart 时可能读不到流末尾。先经 `new Response(form)` 缓冲一次，
  // 能同时拿到：带 boundary 的 Content-Type 头 + 定长的 body 字节。
  // 下游拿到的就是一个普通的、有明确长度的请求体，跨运行时行为一致。
  const serialized = new Response(form);
  const formType = serialized.headers.get('Content-Type');
  const formBytes = await serialized.arrayBuffer();

  const request = synthRequest(octx, '/api/v1/upload', {
    method: 'POST',
    body: formBytes,
    headers: formType ? { 'Content-Type': formType } : {},
  });
  const response = await v1Upload(baseCtx(octx, request));
  return normalizeResult(response, octx, '', { emphasizeDirectLink: true });
}

/** URL 导入：v1/import.js 读 JSON body（且要求该 Content-Type）。 */
async function runImportUrl(octx, args) {
  const url = String(args.url ?? '').trim();
  if (!url) {
    return toolError('VALIDATION_ERROR', 'Field "url" is required.');
  }

  const body = { url };
  if (args.storage !== undefined && args.storage !== null && String(args.storage).trim() !== '') {
    body.storage = String(args.storage);
  }
  // v1/import.js 的字段名是 `folder`（不是 folderPath）。
  if (args.folder !== undefined && args.folder !== null && String(args.folder).trim() !== '') {
    body.folder = String(args.folder);
  }
  if (args.deduplicate !== undefined && args.deduplicate !== null) {
    body.deduplicate = Boolean(args.deduplicate);
  }

  const request = synthRequest(octx, '/api/v1/import', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  const response = await v1Import(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

/** 列表：拼 query string，空值不落进 URL。 */
async function runListFiles(octx, args) {
  const qs = new URLSearchParams();
  const queryKeys = ['limit', 'cursor', 'storage', 'search', 'folderPath', 'listType'];
  for (const key of queryKeys) {
    const value = args[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const request = synthRequest(octx, `/api/v1/files${suffix}`, { method: 'GET' });
  const response = await v1Files(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

/**
 * 文件类工具（info / read / delete）：
 * 这三条都落在 `[[path]]` 路由上，**必须**同时注入 params.path，
 * 否则下游 resolveFileId 取不到值会直接 400。
 */
function fileRouteContext(octx, id, pathname, options) {
  const request = synthRequest(octx, pathname, options);
  return baseCtx(octx, request, { path: id, id });
}

async function runGetFileInfo(octx, args) {
  const id = String(args.id ?? '').trim();
  if (!id) return toolError('VALIDATION_ERROR', 'Field "id" is required.');
  const path = `/api/v1/file/${encodeURIComponent(id)}/info`;
  const response = await v1FileInfo(fileRouteContext(octx, id, path, { method: 'GET' }));
  return normalizeResult(response, octx, id);
}

async function runGetFile(octx, args) {
  const id = String(args.id ?? '').trim();
  if (!id) return toolError('VALIDATION_ERROR', 'Field "id" is required.');

  const password = String(args.password ?? '');
  const suffix = password ? `?password=${encodeURIComponent(password)}` : '';
  const path = `/api/v1/file/${encodeURIComponent(id)}${suffix}`;
  const response = await v1File(fileRouteContext(octx, id, path, { method: 'GET' }));
  return normalizeResult(response, octx, id);
}

async function runDeleteFile(octx, args) {
  const id = String(args.id ?? '').trim();
  if (!id) return toolError('VALIDATION_ERROR', 'Field "id" is required.');
  const path = `/api/v1/file/${encodeURIComponent(id)}`;
  const response = await v1File(fileRouteContext(octx, id, path, { method: 'DELETE' }));
  return normalizeResult(response, octx, id);
}

/**
 * 分享管理：把工具参数翻译成 `PATCH /api/v1/file/:id/share` 的请求体。
 *
 * 关键点是**只透传用户真正给了的字段**。v1 端点的增量语义是「字段出现 =
 * 我要改它」（`0`/空串 = 清除），因此把 `undefined` 也塞进 body 会被误读成
 * 「清除这项设置」—— 那会让一次「只想改有效期」的调用顺手把密码删掉。
 * 这正是下面逐个 `hasOwnProperty` 判断存在的原因，也是本函数最容易被改错之处。
 */
async function runManageShare(octx, args) {
  const id = String(args.id ?? '').trim();
  if (!id) return toolError('VALIDATION_ERROR', 'Field "id" is required.');

  const body = {};
  const action = String(args.action ?? 'create').trim().toLowerCase();
  if (action) body.action = action;

  // 字段名与 v1 端点一致（驼峰）；值是「透传」而非「过滤空值」——
  // 空串在此处是有意义的信号（清除），不能当缺省丢掉。
  const passthrough = ['slug', 'expiresIn', 'maxDownloads', 'password', 'title', 'description'];
  for (const key of passthrough) {
    if (Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined && args[key] !== null) {
      body[key] = args[key];
    }
  }

  const path = `/api/v1/file/${encodeURIComponent(id)}/share`;
  // GET 走查询分支，其余走写分支 —— 与 v1 端点的分流逻辑一致。
  const method = action === 'get' ? 'GET' : 'PATCH';
  const response = await v1FileShare(
    fileRouteContext(octx, id, path, {
      method,
      body: method === 'GET' ? null : JSON.stringify(body),
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    })
  );
  return normalizeResult(response, octx, id, { emphasizeDirectLink: true });
}

async function runCreatePaste(octx, args) {
  const content = String(args.content ?? '');
  if (!content.trim()) {
    return toolError('VALIDATION_ERROR', 'Field "content" is required.');
  }

  const body = { content };
  if (args.language !== undefined && String(args.language).trim() !== '') {
    body.language = String(args.language);
  }
  // v1/paste.js 读 `expires_in`（下划线）。
  if (args.expiresIn !== undefined && args.expiresIn !== null && args.expiresIn !== '') {
    body.expires_in = Number(args.expiresIn);
  }
  if (args.password !== undefined && String(args.password).trim() !== '') {
    body.password = String(args.password);
  }

  const request = synthRequest(octx, '/api/v1/paste', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  const response = await v1Paste(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

async function runListPastes(octx, args) {
  const qs = new URLSearchParams();
  for (const key of ['limit', 'cursor']) {
    const value = args[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const request = synthRequest(octx, `/api/v1/pastes${suffix}`, { method: 'GET' });
  const response = await v1Pastes(baseCtx(octx, request));
  return normalizeResult(response, octx, '');
}

/**
 * 工具 key → 执行函数的映射表。
 *
 * 刻意用**显式静态映射**而不是 `import(key)` 动态加载：
 *   1. `scripts/check_functions.py` 靠静态扫描找「调用了但没 import」的符号，
 *      动态 import 它扫不到 —— 漏 import 的缺陷会一路漏到线上才炸；
 *   2. Pages 的打包对动态 import 的解析行为不确定，零构建的项目不应依赖它。
 *
 * 导出为可变对象是为了让 `scripts/test-mcp.mjs` 能注入替身做单测
 * （不真正调用下游 handler，只断言合成出来的 Request 是否正确）。
 */
export const TOOL_HANDLERS = {
  capabilities: runCapabilities,
  token_info: runTokenInfo,
  upload_file: runUploadFile,
  import_url: runImportUrl,
  list_files: runListFiles,
  get_file_info: runGetFileInfo,
  get_file: runGetFile,
  manage_share: runManageShare,
  delete_file: runDeleteFile,
  create_paste: runCreatePaste,
  list_pastes: runListPastes,
};

export { synthRequest, baseCtx, decodeBase64, mimeFromDataUrl, withDirectLink };
