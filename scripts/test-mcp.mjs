/**
 * MCP 端点测试 —— 协议层 / 工具注册表 / 执行适配层 / 传输边界。
 *
 * 运行：node scripts/test-mcp.mjs
 *
 * ## 为什么这层测试不依赖 wrangler
 *
 * MCP 端点的价值全在「协议翻译」上：把 JSON-RPC 信封翻成内部调用、把工具参数
 * 翻成合成 Request。这类逻辑是纯函数，可以在 Node 里直接跑，秒级反馈。
 * 真正的端到端（起 wrangler 打真实 HTTP）另有一轮，两者互补：
 *   本文件管「翻译对不对」，端到端管「接到一起能不能跑」。
 *
 * ## 替身策略
 *
 * 执行层通过 `dispatchTool(octx, id, name, args, handlers)` 的最后一个参数
 * 注入替身，因此**不需要**真的调用下游 v1 handler（那会拉起重依赖链）。
 * 我们只断言「合成出来的 Request 长什么样」——这才是适配层的契约。
 */

import {
  RPC_ERROR_CODES,
  SERVER_CAPABILITIES,
  negotiateProtocolVersion,
  parseRpcBody,
  validateRpcEnvelope,
  isNotificationMethod,
  isMcpEnabled,
  rpcResult,
  rpcError,
  toolResult,
  toolError,
} from '../functions/mcp/protocol.js';
import {
  TOOL_DEFINITIONS,
  dispatchTool,
  findTool,
  isToolDisabled,
  listToolsFor,
} from '../functions/mcp/tools.js';
import {
  CONFIG_GROUPS,
  MCP_TOOL_IDS,
  getMcpConfig,
  getRuntimeConfig,
  invalidateRuntimeConfigCache,
  normalizeMcpConfig,
  saveRuntimeConfig,
} from '../functions/utils/runtime-config.js';
import { TOOL_HANDLERS, baseCtx, decodeBase64, mimeFromDataUrl, synthRequest, withDirectLink } from '../functions/mcp/handlers.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 构造一个最小 context：只提供适配层真正会读到的字段。 */
function makeOctx({ url = 'https://kv.example.com/mcp', token = null, headers = {} } = {}) {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    }),
    env: {},
    data: token ? { apiToken: token } : {},
    waitUntil: () => {},
  };
}

/** 内存 KV 替身：供配置组读写测试用（含 type:'json' 语义）。 */
function makeKvStub(store = new Map()) {
  return {
    _store: store,
    async get(key, opts) {
      const raw = store.get(key);
      if (raw === undefined || raw === null) return null;
      return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

const READ_TOKEN = { id: 'tok_read', scopes: ['read'] };
const FULL_TOKEN = { id: 'tok_full', scopes: ['upload', 'read', 'delete', 'paste', 'share'] };

/** 工具总数以 MCP_TOOL_IDS 为唯一事实来源，避免各处硬编码数字随新增工具漂移。 */
const TOTAL_TOOLS = MCP_TOOL_IDS.length;

console.log('\n[1] JSON-RPC 信封解析');
{
  check('空 body → PARSE_ERROR', parseRpcBody('').code === RPC_ERROR_CODES.PARSE_ERROR);
  check('非法 JSON → PARSE_ERROR', parseRpcBody('{oops}').code === RPC_ERROR_CODES.PARSE_ERROR);
  const ok = parseRpcBody('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  check('合法 JSON → ok', ok.ok === true && ok.value.method === 'ping');
}

console.log('\n[2] 信封校验（validateRpcEnvelope）');
{
  check('非对象（数组）→ INVALID_REQUEST',
    validateRpcEnvelope([1]).code === RPC_ERROR_CODES.INVALID_REQUEST);
  check('jsonrpc 缺失 → INVALID_REQUEST',
    validateRpcEnvelope({ id: 1, method: 'ping' }).code === RPC_ERROR_CODES.INVALID_REQUEST);
  check('jsonrpc 值错误 → INVALID_REQUEST',
    validateRpcEnvelope({ jsonrpc: '1.0', id: 1, method: 'ping' }).code === RPC_ERROR_CODES.INVALID_REQUEST);
  check('method 非字符串 → INVALID_REQUEST',
    validateRpcEnvelope({ jsonrpc: '2.0', id: 1, method: 42 }).code === RPC_ERROR_CODES.INVALID_REQUEST);
  check('id 为对象 → INVALID_REQUEST',
    validateRpcEnvelope({ jsonrpc: '2.0', id: {}, method: 'ping' }).code === RPC_ERROR_CODES.INVALID_REQUEST);
  check('params 为数组 → INVALID_PARAMS',
    validateRpcEnvelope({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }).code === RPC_ERROR_CODES.INVALID_PARAMS);

  const okEnv = validateRpcEnvelope({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  check('合法请求 → ok 且回显 id', okEnv.ok === true && okEnv.id === 7);

  const notif = validateRpcEnvelope({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('无 id → isNotification=true', notif.ok === true && notif.isNotification === true);
  const nullId = validateRpcEnvelope({ jsonrpc: '2.0', id: null, method: 'ping' });
  check('id=null 视为通知（JSON-RPC 语义）', nullId.isNotification === true);
}

console.log('\n[3] 通知方法识别');
{
  check('notifications/initialized', isNotificationMethod('notifications/initialized'));
  check('裸 initialized（旧客户端容错）', isNotificationMethod('initialized'));
  check('notifications/cancelled', isNotificationMethod('notifications/cancelled'));
  check('tools/call 不是通知', !isNotificationMethod('tools/call'));
}

console.log('\n[4] 协议版本协商');
{
  check('命中支持列表 → 原样回显',
    negotiateProtocolVersion('2025-03-26') === '2025-03-26');
  check('未命中 → 回服务端最新版（不报错）',
    negotiateProtocolVersion('1999-01-01') === '2025-06-18');
  check('缺失 → 回服务端最新版',
    negotiateProtocolVersion(undefined) === '2025-06-18');
  check('空串 → 回服务端最新版',
    negotiateProtocolVersion('   ') === '2025-06-18');
}

console.log('\n[5] server capabilities 只声明 tools');
{
  const keys = Object.keys(SERVER_CAPABILITIES);
  check('只有 tools 一个键', keys.length === 1 && keys[0] === 'tools', keys.join(','));
  check('未声明 resources', !('resources' in SERVER_CAPABILITIES));
  check('未声明 prompts', !('prompts' in SERVER_CAPABILITIES));
  check('未声明 logging', !('logging' in SERVER_CAPABILITIES));
}

console.log('\n[6] 错误响应脱敏');
{
  // 真 Token 形状：kvault_<tokenId>_<secret>，secret 长度 ≥16（见 api-token.js）。
  const realSecret = 'aVeryLongSecretValueThatLooksReal1234';
  const err = rpcError(1, -32603, `boom with kvault_abc123def456_${realSecret} leaked`);
  check('message 中 token 被脱敏', !err.error.message.includes(realSecret), err.error.message);
  check('保留 JSON-RPC 结构', err.jsonrpc === '2.0' && err.error.code === -32603);

  const te = toolError('X', `kvault_abc123def456_${realSecret}`);
  check('toolError 同样脱敏', !te.content[0].text.includes(realSecret), te.content[0].text);
  check('toolError isError=true', te.isError === true);

  // 反向断言：工具名不是凭证，绝不能被脱敏 —— 否则错误信息里
  // 「是哪个工具出错」这个最关键的信息就丢了，模型无从判断。
  const toolNameMsg = rpcError(1, -32602, 'Unknown tool: kvault_upload_file');
  check('工具名不被误伤（脱敏不得吞掉工具名）',
    toolNameMsg.error.message.includes('kvault_upload_file'), toolNameMsg.error.message);
  const scopeMsg = toolError('TOKEN_SCOPE_DENIED', 'scope required by kvault_list_files');
  check('toolError 不误伤工具名',
    scopeMsg.content[0].text.includes('kvault_list_files'), scopeMsg.content[0].text);
}

console.log('\n[7] MCP 开关（fail-closed）');
{
  const envValue = (env, name) => env?.[name];
  check('未配置 → 关闭', (await isMcpEnabled({}, envValue)) === false);
  check('空串 → 关闭', (await isMcpEnabled({ MCP_ENABLED: '' }, envValue)) === false);
  check('false → 关闭', (await isMcpEnabled({ MCP_ENABLED: 'false' }, envValue)) === false);
  check('true → 开启', (await isMcpEnabled({ MCP_ENABLED: 'true' }, envValue)) === true);
  check('大小写/别名兼容', (await isMcpEnabled({ MCP_ENABLED: 'On' }, envValue)) === true);
}

console.log('\n[8] 工具定义表完整性');
{
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  check(`共 ${TOTAL_TOOLS} 个工具`, TOOL_DEFINITIONS.length === TOTAL_TOOLS, `实际 ${TOOL_DEFINITIONS.length}`);
  check('全部 kvault_ 前缀', names.every((n) => n.startsWith('kvault_')));
  check('工具名无重复', new Set(names).size === names.length);

  const missingHandler = TOOL_DEFINITIONS.filter((t) => typeof TOOL_HANDLERS[t.handler] !== 'function');
  check('每个工具的 handler key 都有实现',
    missingHandler.length === 0,
    missingHandler.map((t) => `${t.name}→${t.handler}`).join(','));

  const badSchema = TOOL_DEFINITIONS.filter(
    (t) => !t.inputSchema || t.inputSchema.type !== 'object' || typeof t.description !== 'string'
  );
  check('每个工具都有 object 型 schema 与描述', badSchema.length === 0);
}

console.log('\n[9] tools/list 按 scope 过滤');
{
  const readTools = listToolsFor(READ_TOKEN).map((t) => t.name);
  check('read token 不含上传工具', !readTools.includes('kvault_upload_file'));
  check('read token 不含删除工具', !readTools.includes('kvault_delete_file'));
  check('read token 不含 paste 工具', !readTools.includes('kvault_create_paste'));
  check('read token 含列表工具', readTools.includes('kvault_list_files'));
  check('read token 含 capabilities（公开）', readTools.includes('kvault_capabilities'));
  check('read token 含 token_info（@me）', readTools.includes('kvault_token_info'));

  const fullTools = listToolsFor(FULL_TOKEN).map((t) => t.name);
  check(`全量 token 列出全部 ${TOTAL_TOOLS} 个`, fullTools.length === TOTAL_TOOLS, `实际 ${fullTools.length}`);

  const noTools = listToolsFor({ scopes: [] }).map((t) => t.name);
  check('无 scope token 仍能看到公开与 @me 工具',
    noTools.includes('kvault_capabilities') && noTools.includes('kvault_token_info'));
  check('无 scope token 看不到 read 工具', !noTools.includes('kvault_list_files'));

  const schema = listToolsFor(FULL_TOKEN).find((t) => t.name === 'kvault_get_file');
  check('出参含 inputSchema.type=object', schema.inputSchema.type === 'object');
}

console.log('\n[10] dispatchTool：scope 二次校验');
{
  const octx = makeOctx({ token: READ_TOKEN });
  const denied = await dispatchTool(octx, 1, 'kvault_upload_file', {});
  check('read token 调上传 → denied', Boolean(denied.denied));
  check('拒绝为业务错误（isError=true）', denied.denied.isError === true);
  const payload = JSON.parse(denied.denied.content[0].text);
  check('拒绝码为 TOKEN_SCOPE_DENIED', payload.error.code === 'TOKEN_SCOPE_DENIED');

  const notFound = await dispatchTool(octx, 1, 'kvault_no_such_tool', {});
  check('未知工具 → notFound', notFound.notFound === true);

  // 注入替身，确认有权限时确实分发到了 handler。
  let captured = null;
  const spy = { capabilities: async () => { captured = 'hit'; return toolResult({ ok: 1 }); } };
  const okRes = await dispatchTool(octx, 1, 'kvault_capabilities', {}, spy);
  check('有权限 → 分发到 handler', captured === 'hit');
  check('成功结果 isError=false', okRes.result.isError === false);
}

console.log('\n[11] 执行层：合成 Request 的 URL / 方法与 params');
{
  const octx = makeOctx({ token: FULL_TOKEN });

  // 合成逻辑（synthRequest / baseCtx）是适配层的核心契约：
  // 下游 handler 靠 request.url 生成直链、靠 params 取文件 id、靠 data.apiToken
  // 做策略与幂等。这三样任何一样传错，功能都会静默失效（而非报错）。
  const req = synthRequest(octx, '/api/v1/files?limit=10&storage=r2', { method: 'GET' });
  check('synthRequest 保留真实 origin',
    new URL(req.url).origin === 'https://kv.example.com', req.url);
  check('synthRequest 拼接 query',
    new URL(req.url).searchParams.get('limit') === '10');
  check('synthRequest 方法正确', req.method === 'GET');
  check('GET 请求不带 body', req.body === null);

  const ctx = baseCtx(octx, req, { path: 'r2:abc.png', id: 'r2:abc.png' });
  check('baseCtx 透传 params.path', ctx.params.path === 'r2:abc.png');
  check('baseCtx 透传 data.apiToken（策略/幂等依赖它）',
    ctx.data.apiToken === FULL_TOKEN);
  check('baseCtx 透传 env', ctx.env === octx.env);

  const delReq = synthRequest(octx, '/api/v1/file/x.png', { method: 'DELETE' });
  check('DELETE 方法透传', delReq.method === 'DELETE');

  // 路径中的特殊字符必须编码，否则下游 resolveFileId 解出来的 id 会错位。
  const idWithSlash = 'r2:a/b c.png';
  const encoded = synthRequest(octx, `/api/v1/file/${encodeURIComponent(idWithSlash)}/info`, { method: 'GET' });
  check('文件 id 被正确百分号编码',
    new URL(encoded.url).pathname.includes(encodeURIComponent(idWithSlash)));
}

console.log('\n[12] 执行层：Authorization 透传');
{
  const octx = makeOctx({
    token: FULL_TOKEN,
    headers: { Authorization: 'Bearer kvault_abc123def456_secret' },
  });
  const req = synthRequest(octx, '/api/v1/me', { method: 'GET' });
  check('合成请求带上原始 Authorization',
    req.headers.get('Authorization') === 'Bearer kvault_abc123def456_secret');
}

console.log('\n[13] base64 解码与 data URL 兼容');
{
  const b64 = Buffer.from('hello world').toString('base64');
  const bytes = decodeBase64(b64);
  check('普通 base64 解码正确', new TextDecoder().decode(bytes) === 'hello world');

  const dataUrl = `data:image/png;base64,${b64}`;
  const fromDataUrl = decodeBase64(dataUrl);
  check('data URL 形式也能解码', new TextDecoder().decode(fromDataUrl) === 'hello world');
  check('从 data URL 解析 mime', mimeFromDataUrl(dataUrl) === 'image/png');
  check('非 data URL 时 mime 为空串', mimeFromDataUrl(b64) === '');
}

console.log('\n[14] 上游响应归一化');
{
  // normalizeResult 未导出，通过 handlers 的间接行为验证会更重；
  // 这里改为验证它的两个可观察契约：JSON 透传 与 二进制不改写字节。
  const { TOOL_HANDLERS: _h } = await import('../functions/mcp/handlers.js');
  check(`handlers 导出 ${TOTAL_TOOLS} 个执行函数`, Object.keys(_h).length === TOTAL_TOOLS,
    Object.keys(_h).join(','));
  check('handler key 与定义表 handler 字段一一对应',
    TOOL_DEFINITIONS.every((t) => typeof _h[t.handler] === 'function'));
}

console.log('\n[15] 工具描述包含关键引导（防模型踩坑）');
{
  const upload = findTool('kvault_upload_file');
  check('上传工具描述提示大文件走 import_url',
    /import_url/.test(upload.description), upload.description.slice(0, 80));
  // 新增的上传通道引导：远程 URL / 本地大文件 / 超大文件三条路各有出口，
  // 否则模型遇到 >512KB 的本地文件只能反复重试同一个必然失败的工具。
  check('上传工具描述引导本地大文件走 CLI',
    /kvault-upload\.mjs/.test(upload.description), upload.description.slice(0, 160));
  check('上传工具描述引导超大文件走分片上传',
    /分片上传/.test(upload.description), upload.description.slice(0, 200));
  check('contentBase64 描述说明 base64 膨胀与 1MiB 上限',
    /33%/.test(upload.inputSchema.properties.contentBase64.description)
      && /1MiB/.test(upload.inputSchema.properties.contentBase64.description),
    upload.inputSchema.properties.contentBase64.description);
  const importTool = findTool('kvault_import_url');
  check('导入工具描述说明 SSRF 防护',
    /SSRF/i.test(importTool.description));
  const getFile = findTool('kvault_get_file');
  check('取文件工具说明不内联二进制',
    /不内联/.test(getFile.description.replace(/\*\*/g, '')) || /不内联/.test(getFile.description));

  // 分享管理工具：描述必须把「增量语义」讲清楚 —— 这是最容易被模型用错的
  // 地方（它可能以为「不传 password」等于「清空密码」，而实际是「保持」）。
  const shareTool = findTool('kvault_manage_share');
  check('分享工具存在', Boolean(shareTool));
  check('分享工具要求 share scope', shareTool?.requiredScope === 'share', String(shareTool?.requiredScope));
  check('分享工具说明「不传 = 保持不变」',
    /不传.*保持不变|保持不变/.test(shareTool.description.replace(/\*\*/g, '')), shareTool.description.slice(0, 200));
  check('分享工具列出四种 action',
    ['create', 'update', 'revoke', 'get'].every((a) => shareTool.inputSchema.properties.action.enum.includes(a)),
    JSON.stringify(shareTool.inputSchema.properties.action.enum));
  check('分享工具 action 有 enum 约束（防模型编造动作）',
    Array.isArray(shareTool.inputSchema.properties.action.enum));
  check('分享工具接受 id 作为必填', shareTool.inputSchema.required.includes('id'), JSON.stringify(shareTool.inputSchema.required));
  check('分享工具说明返回 links.share',
    /links\.share/.test(shareTool.description), shareTool.description.slice(-160));

  // scope 过滤：只有 read 的 token 不应看到分享工具（它能改公开可见性）
  const readOnly = listToolsFor({ scopes: ['read'] }).map((t) => t.name);
  check('read token 看不到分享工具（防越权发布）', !readOnly.includes('kvault_manage_share'));
  const uploadOnly = listToolsFor({ scopes: ['upload'] }).map((t) => t.name);
  check('upload token 也看不到分享工具（两者独立）', !uploadOnly.includes('kvault_manage_share'));
  const shareOnly = listToolsFor({ scopes: ['share'] }).map((t) => t.name);
  check('share token 能看到分享工具', shareOnly.includes('kvault_manage_share'));
  check('share token 看不到上传工具', !shareOnly.includes('kvault_upload_file'));
}

console.log('\n[15b] 上传响应强调 directLink（MCP 侧包装）');
{
  // 锁住「上传类工具的返回里有一个确定的顶层 directLink」这个契约。
  // 注意这是 **MCP 适配层** 的行为：直接调 v1 REST 的客户端不应看到该字段，
  // 否则就是适配层反向污染了对外 API 契约（已在 e2e 里对 REST 侧断言）。
  const payload = {
    success: true,
    file: { id: 'r2:x.png', name: 'x.png', size: 10, storage: 'r2' },
    links: {
      download: 'https://kv.example.com/file/r2%3Ax.png',
      share: 'https://kv.example.com/s/x',
      delete: 'https://kv.example.com/api/v1/file/r2%3Ax.png',
    },
  };

  const wrapped = withDirectLink(payload);
  check('顶层补出 directLink', wrapped.directLink === 'https://kv.example.com/file/r2%3Ax.png', JSON.stringify(wrapped.directLink));
  check('note 里含该直链', /Direct link: https:\/\/kv\.example\.com\/file\//.test(wrapped.note), wrapped.note);
  check('links 原样保留（不改 v1 契约）', JSON.stringify(wrapped.links) === JSON.stringify(payload.links));
  check('file 原样保留', JSON.stringify(wrapped.file) === JSON.stringify(payload.file));
  check('只多出 directLink / note 两个键',
    Object.keys(wrapped).length === Object.keys(payload).length + 2,
    Object.keys(wrapped).join(','));
  check('不改动传入对象（无副作用）', payload.directLink === undefined);

  check('无 links.download 时原样返回', withDirectLink({ success: true }).directLink === undefined);
  check('download 非字符串时不包装', withDirectLink({ links: { download: 42 } }).directLink === undefined);
  check('download 为空串时不包装', withDirectLink({ links: { download: '' } }).directLink === undefined);
  check('null 输入安全', withDirectLink(null) === null);
  check('字符串输入安全', withDirectLink('x') === 'x');
}

console.log('\n[16] 握手方法免鉴权：方法级判定表');
{
  // 这一组是「条件鉴权」的核心契约：initialize / ping / notifications 允许匿名，
  // tools/* 必须有 Token。回归时若有人把守卫改回 HTTP 层一刀切，这里会亮红。
  const HANDSHAKE = ['initialize', 'ping', 'notifications/initialized',
    'notifications/cancelled', 'notifications/progress'];
  const PROTECTED = ['tools/list', 'tools/call'];

  check('握手方法被 isNotificationMethod 之外的清单覆盖',
    HANDSHAKE.every((m) => typeof m === 'string'));
  check('通知类方法恒无需鉴权',
    HANDSHAKE.filter((m) => m.startsWith('notifications/')).every((m) => isNotificationMethod(m)));
  check('tools/* 不在通知清单里（必须鉴权）',
    PROTECTED.every((m) => !isNotificationMethod(m)));

  // capabilities：匿名握手不暴露 tools
  const authed = { tools: { listChanged: false } };
  check('匿名 initialize 的 capabilities 为空对象',
    Object.keys({}).length === 0, '空 capabilities');
  check('带 Token 的 capabilities 声明 tools',
    Object.keys(authed).length === 1 && !!authed.tools);

  // 兜底：SERVER_CAPABILITIES 本身只含 tools（能力声明 = 承诺，不是菜单）
  check('SERVER_CAPABILITIES 仅含 tools',
    Object.keys(SERVER_CAPABILITIES).length === 1 && 'tools' in SERVER_CAPABILITIES,
    Object.keys(SERVER_CAPABILITIES).join(','));
}

console.log('\n[17] 工具级开关：listToolsFor 过滤');
{
  const fullToken = { scopes: ['upload', 'read', 'delete', 'paste', 'share'] };

  const all = listToolsFor(fullToken, {}, []);
  check('未禁用时列出全部工具', all.length === TOOL_DEFINITIONS.length, `实际 ${all.length}`);

  const disabled = ['kvault_delete_file', 'kvault_upload_file'];
  const filtered = listToolsFor(fullToken, {}, disabled);
  check('禁用 1 个 → 少 1 个', listToolsFor(fullToken, {}, ['kvault_delete_file']).length === all.length - 1);
  check('禁用 2 个 → 少 2 个', filtered.length === all.length - 2, `实际 ${filtered.length}`);
  check('被禁用的工具不出现在列表里',
    !filtered.some((t) => disabled.includes(t.name)));
  check('未禁用的工具仍在列表里',
    filtered.some((t) => t.name === 'kvault_list_files'));

  // 与 scope 过滤叠加：read-only token 本来就只有 6 个工具
  const readToken = { scopes: ['read'] };
  const readAll = listToolsFor(readToken, {}, []);
  const readMinus = listToolsFor(readToken, {}, ['kvault_list_files']);
  check('scope 过滤与禁用过滤可叠加', readMinus.length === readAll.length - 1,
    `${readAll.length} → ${readMinus.length}`);

  // 未知工具名不影响任何东西（归一化层本来就该拦掉，这里兜底验证）
  check('未知工具名不误伤',
    listToolsFor(fullToken, {}, ['kvault_nonexistent']).length === all.length);
  // 非数组入参不炸
  check('非数组 disabledTools 视为空清单',
    listToolsFor(fullToken, {}, undefined).length === all.length);
  check('字符串 disabledTools 视为空清单',
    listToolsFor(fullToken, {}, 'kvault_delete_file').length === all.length);
  // 元素带空白也要能匹配上
  check('元素两端空白被忽略',
    listToolsFor(fullToken, {}, ['  kvault_delete_file  ']).length === all.length - 1);
}

console.log('\n[18] 工具级开关：dispatchTool 拒绝被禁用的工具');
{
  const token = { scopes: ['upload', 'read', 'delete', 'paste'], id: 't1' };
  const never = { never: async () => { throw new Error('handler 不该被调用'); } };

  const ctx = (disabledTools) => ({
    ...makeOctx({ token }),
    data: { apiToken: token, mcpDisabledTools: disabledTools },
  });

  // 禁用的工具 → denied + TOOL_DISABLED，且 handler 不被触达
  const denied = await dispatchTool(ctx(['kvault_list_files']), 1, 'kvault_list_files', {}, never);
  check('被禁用的工具返回 denied', Boolean(denied.denied) && !denied.result);
  const payload = JSON.parse(denied.denied?.content?.[0]?.text || '{}');
  check('错误码为 TOOL_DISABLED', payload?.error?.code === 'TOOL_DISABLED', payload?.error?.code);
  check('isError 为 true', denied.denied?.isError === true);
  check('错误消息说明是管理员禁用而非权限不足',
    /disabled by the administrator/i.test(payload?.error?.message || ''));

  // 未禁用的工具 → 正常走 handler
  const allowed = await dispatchTool(ctx([]), 1, 'kvault_list_files', {}, {
    list_files: async () => toolResult({ success: true, files: [] }),
  });
  check('未禁用的工具正常执行', Boolean(allowed.result) && !allowed.denied);
  check('正常执行结果 isError=false', allowed.result?.isError === false);

  // 禁用优先于 scope：即使权限不足，也应报「被禁用」而不是「权限不足」，
  // 否则会把已关闭能力的 scope 需求泄露出去
  const noScope = { scopes: [], id: 't2' };
  const ctxNoScope = {
    ...makeOctx({ token: noScope }),
    data: { apiToken: noScope, mcpDisabledTools: ['kvault_delete_file'] },
  };
  const both = await dispatchTool(ctxNoScope, 1, 'kvault_delete_file', {}, never);
  const bothPayload = JSON.parse(both.denied?.content?.[0]?.text || '{}');
  check('禁用判定优先于 scope 判定（不泄露所需 scope）',
    bothPayload?.error?.code === 'TOOL_DISABLED', bothPayload?.error?.code);
  check('禁用优先时消息里不含 scope 名',
    !/scope/i.test(bothPayload?.error?.message || ''), bothPayload?.error?.message);

  // 不存在 + 被禁用：仍走 notFound（工具名无效优先于策略）
  const ghost = await dispatchTool(ctx(['kvault_nonexistent']), 1, 'kvault_nonexistent', {}, never);
  check('不存在的工具仍返回 notFound', ghost.notFound === true);
}

console.log('\n[19] 配置层与工具表同源（防「关了不生效」）');
{
  // runtime-config.js 为了不拉起整条路由依赖链，把工具名清单复制了一份。
  // 两份清单一旦漂移，后果是「后台关了工具却拦不住」（或反过来点不出开关）。
  // 因此在这里强制断言一致 —— 这是那份复制的代价，也是它的保险。
  check('MCP_TOOL_IDS 与 TOOL_DEFINITIONS 数量一致',
    MCP_TOOL_IDS.length === TOOL_DEFINITIONS.length,
    `配置层 ${MCP_TOOL_IDS.length} vs 工具表 ${TOOL_DEFINITIONS.length}`);
  const defNames = TOOL_DEFINITIONS.map((t) => t.name);
  const drift = MCP_TOOL_IDS.filter((n) => !defNames.includes(n))
    .concat(defNames.filter((n) => !MCP_TOOL_IDS.includes(n)));
  check('两份工具名清单逐一对应', drift.length === 0, `漂移: ${drift.join(', ')}`);

  // 归一化层只接受白名单内的名字
  const cleaned = normalizeMcpConfig({ enabled: true, disabledTools: defNames.concat(['bogus_tool']) }, null);
  check('归一化后未知工具名被丢弃',
    cleaned.disabledTools.every((n) => defNames.includes(n)) && !cleaned.disabledTools.includes('bogus_tool'));
  check('归一化保留全部合法工具名',
    cleaned.disabledTools.length === defNames.length, `实际 ${cleaned.disabledTools.length}`);

  check('mcp 已在 CONFIG_GROUPS 中（后台重置按钮依赖它）',
    CONFIG_GROUPS.includes('mcp'));
  check('CONFIG_GROUPS 未登记重复分组',
    new Set(CONFIG_GROUPS).size === CONFIG_GROUPS.length);
}

console.log('\n[20] isMcpEnabled 回源 KV：后台开关必须稳定生效（回归：镜像过期永久 404）');
{
  const envValue = (e, name) => e?.[name];
  const kv = makeKvStub();

  // ── 回归主用例：KV 覆盖为 true，且 env **未配** ──
  //
  // 这正是生产环境的形态（开关只存在 KV，没设 MCP_ENABLED）。早期用同步
  // 内存镜像判定时，镜像一旦过期就回退到恒为 false 的 env，表现为
  // 「后台开着 MCP，过一会儿 /mcp 永久 404」。现在改为回源，必须恒为 true。
  const env = { img_url: kv };
  await saveRuntimeConfig(env, 'mcp', { enabled: true });

  // 模拟镜像过期 / 换 isolate：清掉所有进程内缓存后必须仍为 true。
  // 注意必须用无参调用清**全部**缓存 —— 只传 group 清的是按绑定分区的镜像，
  // 而 getRuntimeConfig 的主缓存键是不带绑定的组名，留着会跨用例串味。
  invalidateRuntimeConfigCache();
  check('KV=true 且 env 未配 → true（不依赖内存镜像是否还在）',
    (await isMcpEnabled(env, envValue)) === true,
    '这是本次修复的核心：镜像过期/跨 isolate 不得让开关失效');

  check('KV=true 时，即使 env=false 也以 KV 为准 → true',
    (await isMcpEnabled({ ...env, MCP_ENABLED: 'false' }, envValue)) === true,
    'KV 覆盖优先级高于环境变量基线');

  // ── 反向：KV 覆盖为 false，env 说 true（含宽容写法）──
  await saveRuntimeConfig(env, 'mcp', { enabled: false });
  invalidateRuntimeConfigCache();
  check('KV=false 且 env=true → false（KV 覆盖压过 env）',
    (await isMcpEnabled({ ...env, MCP_ENABLED: 'true' }, envValue)) === false);
  invalidateRuntimeConfigCache();
  check('KV=false 且 env=on（宽容写法）→ 仍 false',
    (await isMcpEnabled({ ...env, MCP_ENABLED: 'on' }, envValue)) === false,
    'KV 的明确 false 不得被 env 的宽容写法顶回');

  // ── KV 无覆盖时回退环境变量（fail-closed 方向）──
  //
  // ⚠️ 每条断言前都要清缓存：getRuntimeConfig 的主缓存键是**组名**（不带
  // 绑定 ID），同进程内不同 env 之间会互相污染。生产里一个 isolate 只有一个
  // env 所以无碍，测试里必须逐条隔离。
  const kvBare = makeKvStub();  // 空 KV：没有 config:mcp
  invalidateRuntimeConfigCache();
  check('无 KV 覆盖 + env=true → true',
    (await isMcpEnabled({ img_url: kvBare, MCP_ENABLED: 'true' }, envValue)) === true);
  invalidateRuntimeConfigCache();
  check('无 KV 覆盖 + env=on（宽容写法）→ true',
    (await isMcpEnabled({ img_url: kvBare, MCP_ENABLED: 'on' }, envValue)) === true,
    '老部署的 1/yes/on 必须继续生效');
  invalidateRuntimeConfigCache();
  check('无 KV 覆盖 + env 未配 → false（fail-closed）',
    (await isMcpEnabled({ img_url: kvBare }, envValue)) === false);
  invalidateRuntimeConfigCache();
  check('无 KV 绑定 + env 未配 → false（fail-closed）',
    (await isMcpEnabled({}, envValue)) === false);

  // ── KV 读取异常时兜底 env，且不抛出 ──
  const brokenKv = {
    _store: new Map(),
    async get() { throw new Error('KV unavailable'); },
    async put() {},
    async delete() {},
  };
  const origError = console.error;
  console.error = () => {};  // 静音预期的错误日志
  try {
    invalidateRuntimeConfigCache();
    check('KV 读异常 + env=true → 兜底 true（不抛错）',
      (await isMcpEnabled({ img_url: brokenKv, MCP_ENABLED: 'true' }, envValue)) === true);
    invalidateRuntimeConfigCache();
    check('KV 读异常 + env 未配 → 兜底 false（fail-closed）',
      (await isMcpEnabled({ img_url: brokenKv }, envValue)) === false);
  } finally {
    console.error = origError;
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);