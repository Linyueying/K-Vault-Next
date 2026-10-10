/**
 * MCP 工具注册表 —— 工具定义、scope 过滤、调用分发。
 *
 * ============================================================================
 * 工具定义的单一事实来源
 * ============================================================================
 *
 * 每个工具在这里声明四件事：name / description / inputSchema / requiredScope。
 * 执行函数放在 handlers.js，通过 `handler` 这个 key 关联。
 *
 * 之所以把「定义」与「执行」分开，是为了让 tools/list 与 tools/call 共用同一份
 * 元数据 —— 否则两处各写一份描述，改了一处忘了另一处，模型看到的说明与实际
 * 行为就会对不上。
 *
 * ============================================================================
 * inputSchema 的取舍
 * ============================================================================
 *
 * 只用 JSON Schema 的最简子集：type / properties / required / enum /
 * description / minimum / maximum。**刻意避开** oneOf / anyOf / $ref / allOf。
 *
 * 原因：MCP 客户端对 JSON Schema 的支持程度参差不齐，主流客户端对基础类型
 * 支持良好，但对组合关键字的表现不统一（有的忽略、有的报错）。工具 schema
 * 是给模型的「说明书」，可读性比表达力重要。
 *
 * @module mcp/tools
 */

import { detectConfiguredStorages } from '../api/v1/capabilities.js';
import { VALID_STORAGES } from '../utils/api-token.js';
import { TOOL_HANDLERS } from './handlers.js';
import { toolError } from './protocol.js';

/** 所有工具共用的 storage 参数说明（enum 在运行时按部署实际情况收敛）。 */
const STORAGE_DESCRIPTION =
  '存储后端。留空使用服务端默认后端。可选值仅包含本部署已配置成功的后端。';

/**
 * 把「声明支持的存储」与「本部署已配置的存储」求交集。
 *
 * 不直接把 VALID_STORAGES 全量写进 enum：那样模型会看到一个未配置的后端、
 * 选中它、然后拿到运行时错误，再反复重试。宁可一开始就不提供这个选项。
 * 若一个后端都没配（理论上不会发生，Telegram 兜底），回落到全量以免 enum 为空。
 */
function availableStorages(env) {
  let configured = [];
  try {
    configured = detectConfiguredStorages(env) || [];
  } catch {
    configured = [];
  }
  const filtered = VALID_STORAGES.filter((name) => configured.includes(name));
  return filtered.length > 0 ? filtered : [];
}

/** 构造 storage 属性；无可用后端时省略 enum（避免空 enum 被客户端误判为「不允许任何值」）。 */
function storageProperty(env) {
  const options = availableStorages(env);
  return {
    type: 'string',
    description: STORAGE_DESCRIPTION,
    ...(options.length > 0 ? { enum: options } : {}),
  };
}

/**
 * 工具定义表。
 *
 * `requiredScope` 语义：
 *   · ''      → 公开能力，任何有效 Token 均可（仍需 Token，MCP 端点整体要鉴权）
 *   · '@me'   → 任意有效 Token，不要求特定 scope
 *   · 其它    → 必须包含该 scope（upload / read / delete / paste）
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'kvault_capabilities',
    handler: 'capabilities',
    requiredScope: '',
    description:
      '探测服务端能力：本部署已启用的存储后端、单文件上传上限、支持的图片类型。'
      + '建议作为第一个调用的工具，用来确认哪些 storage 可用、以及上传体积的边界。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kvault_token_info',
    handler: 'token_info',
    requiredScope: '@me',
    description:
      '自省当前 API Token：id、名称、scopes、策略（policy）、过期时间、最后使用时间。'
      + 'Agent 启动时调用可确认自己的权限范围，避免后续调用必然失败的工具。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kvault_upload_file',
    handler: 'upload_file',
    requiredScope: 'upload',
    description:
      '上传一个小文件（内容以 base64 传递）。**仅适合 ≤512KB** 的图片或文本。'
      + '⚠️ 三种大文件通道，按场景选：'
      + '（1）远程 URL → 用 kvault_import_url（服务端抓取，不经模型上下文）；'
      + '（2）本地大文件 → 用命令行 `node scripts/kvault-upload.mjs upload <路径>`'
      + '（把本地路径直接换成直链，支持目录/glob/多文件）；'
      + '（3）超大文件（>100MB）→ 用网页端的分片上传（R2 原生 multipart，最高 10GB）。'
      + 'base64 会使体积膨胀约 33%，且本端点请求体上限 1MiB，超过会直接失败。'
      + '支持可选的分享控制（slug / 有效期 / 密码 / 下载次数）。',
    inputSchema: {
      type: 'object',
      properties: {
        contentBase64: {
          type: 'string',
          description:
            '文件内容的 base64 字符串。也接受 data URL（data:image/png;base64,...）形式。'
            + '注意 base64 会膨胀约 33%：本端点请求体上限 1MiB，因此原文件实际上限约 750KB。',
        },
        fileName: {
          type: 'string',
          description: '文件名（含扩展名），例如 cover.png。扩展名会影响返回的 MIME 类型。',
        },
        mimeType: {
          type: 'string',
          description: 'MIME 类型，例如 image/png。留空则从 data URL 或文件名推断。',
        },
        storage: storageProperty({}),
        folderPath: { type: 'string', description: '存储目录前缀，例如 blog/2026。' },
        slug: {
          type: 'string',
          description: '自定义分享短链标识（仅限字母、数字、下划线、短横线）。冲突时返回 SLUG_CONFLICT。',
        },
        expiresIn: {
          type: 'integer',
          minimum: 1,
          description: '分享链接有效期（秒）。留空表示永久有效。',
        },
        maxDownloads: {
          type: 'integer',
          minimum: 1,
          description: '分享链接最大下载次数。留空表示不限次数。',
        },
        password: { type: 'string', description: '分享链接访问密码。留空表示无密码。' },
      },
      required: ['contentBase64'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_import_url',
    handler: 'import_url',
    requiredScope: 'upload',
    description:
      '让服务端抓取一个远程 URL 并入库（大文件请用这个，而非 base64 上传）。'
      + '服务端带 SSRF 防护：仅允许 http/https、端口白名单、拒绝内网与云 metadata 地址，'
      + '每一跳重定向都会重新校验。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的远程地址（http 或 https）。' },
        storage: storageProperty({}),
        folder: { type: 'string', description: '存储目录前缀。' },
        deduplicate: {
          type: 'boolean',
          description: '是否启用内容去重（按 SHA-256）。默认 true；重复内容会直接返回已有文件。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_list_files',
    handler: 'list_files',
    requiredScope: 'read',
    description:
      '分页列出已上传的文件。返回 files[] 与 pagination{cursor,total,listComplete}；'
      + '取下一页时把 pagination.cursor 传回 cursor 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页条数，默认 50，最大 200。' },
        cursor: { type: 'integer', minimum: 0, description: '分页游标，来自上一次响应的 pagination.cursor。' },
        storage: storageProperty({}),
        search: { type: 'string', description: '按文件名关键字过滤。' },
        folderPath: { type: 'string', description: '仅列出指定目录前缀下的文件。' },
        listType: { type: 'string', description: '按文件类型过滤（image / video / audio / file）。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_get_file_info',
    handler: 'get_file_info',
    requiredScope: 'read',
    description: '获取单个文件的元信息（名称、大小、MIME、存储后端、上传时间）。不返回文件内容。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文件 ID，来自上传响应或列表结果。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_get_file',
    handler: 'get_file',
    requiredScope: 'read',
    description:
      '获取文件的下载链接与状态（**不内联二进制内容**）。'
      + '若文件带访问密码，请通过 password 参数提供。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文件 ID。' },
        password: { type: 'string', description: '文件访问密码（仅当该文件设置了密码时需要）。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_manage_share',
    handler: 'manage_share',
    requiredScope: 'share',
    description:
      '管理**已存在文件**的分享链接（不重新上传）。四种动作：'
      + 'action=create（默认）创建或覆盖分享配置；'
      + 'action=update 增量修改（只改传入的字段）；'
      + 'action=revoke 取消分享（清除全部限制并删除短链映射）；'
      + 'action=get 只查询当前分享状态，不改动任何数据。'
      + '⚠️ 增量语义：字段**不传** = 保持不变；传 0/空串 = 清除该限制。'
      + '返回 links.share（分享短链）与 links.download（直链）。'
      + '需要 Token 具备 share scope。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文件 ID，来自上传响应或 kvault_list_files。' },
        action: {
          type: 'string',
          enum: ['create', 'update', 'revoke', 'get'],
          description: '要执行的动作，默认 create。get 只读查询。',
        },
        slug: {
          type: 'string',
          description:
            '自定义分享短链标识（仅限字母、数字、下划线、短横线）。'
            + '传空串则恢复为自动短链（用文件 ID）。冲突时返回 SLUG_CONFLICT。',
        },
        expiresIn: {
          type: 'integer',
          minimum: 0,
          description: '分享链接有效期（秒）。0 或留空表示永久有效。',
        },
        maxDownloads: {
          type: 'integer',
          minimum: 0,
          description: '分享链接最大下载次数。0 或留空表示不限次数。',
        },
        password: { type: 'string', description: '分享访问密码。传空串清除密码。' },
        title: { type: 'string', description: '分享页标题。传空串清除。' },
        description: { type: 'string', description: '分享页描述。传空串清除。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_delete_file',
    handler: 'delete_file',
    requiredScope: 'delete',
    description: '永久删除一个文件（同时移除元数据与直链）。此操作不可撤销。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的文件 ID。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_create_paste',
    handler: 'create_paste',
    requiredScope: 'paste',
    description: '创建一个文本片段（paste），返回可访问的链接。支持语法高亮语言、有效期与密码。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '文本内容。' },
        language: { type: 'string', description: '语法高亮语言标识，例如 text / json / javascript。默认 text。' },
        expiresIn: { type: 'integer', minimum: 1, description: '有效期（秒）。留空表示永久。' },
        password: { type: 'string', description: '访问密码。留空表示无密码。' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'kvault_list_pastes',
    handler: 'list_pastes',
    requiredScope: 'read',
    description: '分页列出已创建的文本片段。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页条数，默认 50，最大 200。' },
        cursor: { type: 'integer', minimum: 0, description: '分页游标。' },
      },
      additionalProperties: false,
    },
  },
];

/**
 * 当前 Token 有权限调用的工具（tools/list 用）。
 *
 * 为什么不列出「全部工具、调用时再拒」：
 *   tools/list 的产出会被客户端直接喂给模型当工具清单。列出必然被拒的工具，
 *   等于诱导模型去调用、拿到错误、然后重试或产生幻觉。可见性与可调用性
 *   对齐，是对模型最友好的行为。
 *
 * ⚠️ 这只是**可用性过滤**，不是安全边界。真正的权限判定在 dispatchTool 里
 * 每次都重新做一遍 —— 两者都要有，缺一不可。
 *
 * @param {object} token middleware 注入的 token 记录
 * @param {object} [env] 用于按部署实际情况收敛 storage enum
 */
export function listToolsFor(token, env = {}, disabledTools = []) {
  const disabled = normalizeDisabledSet(disabledTools);
  return TOOL_DEFINITIONS
    .filter((tool) => !disabled.has(tool.name))
    .filter((tool) => hasScope(token, tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: resolveSchema(tool.inputSchema, env),
    }));
}

/**
 * 把「被管理员禁用的工具名」收敛成一个 Set，便于 O(1) 判定。
 *
 * 每一项都 trim 后比对；未知名字也照收 —— 归一化层
 * （runtime-config.js 的 normalizeMcpDisabledTools）已经过滤过一轮，
 * 这里再收一次未知名字不会有害（它本来就不在 TOOL_DEFINITIONS 里，
 * 永远不会被匹配到），却省掉一次白名单交叉校验。
 */
function normalizeDisabledSet(disabledTools) {
  if (!Array.isArray(disabledTools)) return new Set();
  const set = new Set();
  for (const item of disabledTools) {
    const name = String(item ?? '').trim();
    if (name) set.add(name);
  }
  return set;
}

/** 判断某个工具是否被管理员在后台禁用。 */
export function isToolDisabled(name, disabledTools) {
  return normalizeDisabledSet(disabledTools).has(String(name || ''));
}

/**
 * 把定义里的 storage enum 占位（空对象）替换成按 env 收敛后的真实属性。
 *
 * 定义表本身是模块级常量，而可用后端依赖运行时 env，所以 enum 只能在
 * 出参时动态求解。这比在定义里写死 enum 更准确（写死会列出未配置的后端）。
 */
function resolveSchema(schema, env) {
  const properties = schema.properties || {};
  if (!Object.prototype.hasOwnProperty.call(properties, 'storage')) return schema;

  const cloned = { ...schema, properties: { ...properties } };
  cloned.properties.storage = storageProperty(env);
  return cloned;
}

/**
 * 判断 token 是否满足所需 scope。
 *
 * 注意 '@me' 与 '' 都表示「不要求特定 scope」：
 *   · ''    —— 公开能力（如 capabilities），MCP 端点整体仍需有效 Token
 *   · '@me' —— 任意有效 Token（与 v1/_middleware.js 的哨兵语义保持一致）
 */
function hasScope(token, requiredScope) {
  const required = String(requiredScope || '').trim().toLowerCase();
  if (!required || required === '@me') return true;
  const scopes = Array.isArray(token?.scopes) ? token.scopes : [];
  return scopes.includes(required);
}

/** 按名字查工具定义。 */
export function findTool(name) {
  const target = String(name || '');
  return TOOL_DEFINITIONS.find((tool) => tool.name === target) || null;
}

/**
 * 执行一次 tools/call。
 *
 * 分三步，每步的失败语义严格区分：
 *   1. 工具不存在            → 由调用方（dispatch）回 -32602
 *   2. scope 不足            → result.isError（业务语义，而非协议错误）
 *   3. 执行抛异常            → 由调用方回 -32603（且 message 已脱敏）
 *
 * ⚠️ scope 校验**不重新调用 verifyApiToken**：那会为每次 tools/call 多付一次
 * D1/KV 读 + 一次 timingSafeEqual。middleware 已经在同一请求内校验过并把记录
 * 放进了 context.data.apiToken，这里直接读 scopes 即可 —— 同一请求内的快照，
 * 语义与重新校验一致，但不引入额外存储读。
 *
 * @param {object} octx MCP 请求的 context（含 data.apiToken / data.mcpDisabledTools）
 * @param {string|number|null} id JSON-RPC 请求 id
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @param {Record<string, Function>} [handlers] 可注入的执行映射（测试用）
 * @returns {Promise<{result: object} | {denied: object} | {notFound: true}>}
 */
export async function dispatchTool(octx, id, name, args, handlers = TOOL_HANDLERS) {
  const tool = findTool(name);
  if (!tool) return { notFound: true };

  // 管理员在后台禁用的工具：即使 Token 权限充足也一律拒绝。
  //
  // 判定放在 scope 校验**之前**：被禁用的工具对调用方应当表现为
  // 「服务端不提供这个能力」，而不是「你有权限问题」。反过来放（先查
  // scope）会对一个本不该存在的工具泄露它所需的 scope 名，等于把已关闭的
  // 能力轮廓透出去。消息里明确说「已被管理员禁用」，便于 Agent 与运维
  // 区分「这是策略限制」还是「这是凭证问题」，从而不再重试。
  if (isToolDisabled(tool.name, octx?.data?.mcpDisabledTools)) {
    return {
      denied: toolError(
        'TOOL_DISABLED',
        `Tool ${tool.name} is disabled by the administrator of this deployment.`
      ),
    };
  }

  const token = octx?.data?.apiToken;
  if (!hasScope(token, tool.requiredScope)) {
    return {
      denied: toolError(
        'TOKEN_SCOPE_DENIED',
        `API Token does not include the "${tool.requiredScope}" scope required by ${tool.name}.`
      ),
    };
  }

  const handler = handlers[tool.handler];
  if (typeof handler !== 'function') {
    // 走到这里说明注册表与执行表脱节（改了一处忘了另一处），属于编码错误。
    throw new Error(`Tool handler "${tool.handler}" is not implemented.`);
  }

  const result = await handler(octx, args && typeof args === 'object' ? args : {}, id);
  return { result };
}
