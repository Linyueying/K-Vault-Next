import { parseSignedTelegramFileId } from '../../utils/telegram.js';
import { getRecordWithKey as findRecordWithKey } from '../../utils/file-record.js';
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { resolveCorsHeaders, handleApiPreflight } from '../../utils/cors.js';
import { buildShareRecord, hasActiveShare, verifySharePassword } from '../../utils/share-options.js';

/**
 * 获取文件元数据 API（包括原始文件名）—— `GET /api/file-info/{id}`
 *
 * ## 修复前的问题
 *
 * 该接口**无需任何授权**即可读取任意文件的元数据，且响应固定带
 * `Access-Control-Allow-Origin: *`。两者叠加的后果是：任意站点都能跨域
 * 枚举你的文件 ID，拿到原始文件名、大小、上传时间、存储后端，
 * 以及内部的 KV key（`key` 字段）。
 *
 * ## 现在的授权模型
 *
 * 按「谁能看这个文件的元数据」分四档，任一命中即放行：
 *
 * | 档位 | 判据 | 典型来源 |
 * |------|------|----------|
 * | 1 | `fileId` 本身是 HMAC 签名直链 | 自授权，无需额外凭据 |
 * | 2 | 请求带有效 API Token | `/api/v1/file/{id}/info`（v1 中间件已校验并写入 `context.data.apiToken`） |
 * | 3 | 管理员会话 / Basic Auth | 后台、图库、首页弹层预览 |
 * | 4 | 该文件有**有效分享授权** | 分享页访客：分享未过期、未超次、密码正确 |
 *
 * 第 4 档刻意复用 `share-info.js` 的判定顺序（有效期 → 密码 → 次数），
 * 保证「同一个链接在两个入口给出一致的解释」。
 *
 * 未命中任何一档时返回 **404 而不是 403**：403 会确认「该 ID 存在」，
 * 等于把接口变成一个文件 ID 存在性探测器。
 *
 * ## 响应字段分级
 *
 * 只有第 2/3 档（文件所有者）能拿到 `key`（内部 KV 标识）。分享访客与
 * 签名直链只拿展示所需的字段 —— 与 `share-info.js` 「绝不外泄裸 fileId /
 * KV key」的约定保持一致。
 *
 * @module api/file-info
 */

/** 分享访客与签名直链可见的字段（不含内部标识） */
const PUBLIC_FIELDS = ['fileName', 'fileSize', 'uploadTime', 'storageType', 'listType', 'label', 'liked'];

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return handleApiPreflight(request, env);
  }

  // CORS 头只解析一次（内部要读运行时配置），后面所有响应复用
  const cors = await corsHeaders(context);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, cors);
  }

  // [[path]] 路由：多层路径会被解析成数组，需要 join 后再解码
  let fileId = params.path ?? params.id;
  if (Array.isArray(fileId)) {
    fileId = fileId.join('/');
  }
  if (!fileId) {
    return jsonResponse({ error: 'Missing file ID' }, 400, cors);
  }
  try {
    fileId = decodeURIComponent(fileId);
  } catch (_) {
    // 解码失败则保留原值
  }

  try {
    // ---------- 档位 1：签名直链，自授权 ----------
    // 签名里已经带 HMAC，验签通过即证明这个 ID 是本项目签发的，
    // 且它本身不指向 KV 记录，因此不需要再走下面的授权链。
    const signed = await parseSignedTelegramFileId(fileId, env);
    if (signed) {
      const fileName = signed.fileName || `${signed.fileId}.${signed.fileExtension || 'bin'}`;
      const payload = {
        success: true,
        fileId,
        fileName,
        originalName: signed.fileName || null,
        fileSize: signed.fileSize || 0,
        uploadTime: signed.timestamp || null,
        storageType: 'telegram',
        listType: 'None',
        label: 'None',
        liked: false,
        source: 'signed-link',
      };
      // 签名 id 本身就是请求 URL 里的东西，回显它没有价值，一并省掉
      return jsonResponse(
        pickFields(payload, PUBLIC_FIELDS.concat(['success', 'source'])),
        200,
        cors
      );
    }

    if (!env.img_url) {
      return jsonResponse({ error: 'KV storage not available' }, 500, cors);
    }

    // ---------- 档位 2：API Token（v1 中间件已校验） ----------
    const hasApiToken = Boolean(context?.data?.apiToken);

    // ---------- 档位 3：管理员会话 / Basic Auth ----------
    // 必须先用 isAuthRequired 守住：checkAuthentication 在「未配置账密」时
    // 会返回 authenticated:true（那是给登录页用的放行语义），直接用会重新
    // 打开「没设密码 = 全公开」的口子。
    const isAdmin = !hasApiToken && isAuthRequired(env)
      ? (await checkAuthentication(context)).authenticated
      : false;

    const { record, kvKey: foundKey } = await findRecordWithKey(env, fileId);

    if (!record || !record.metadata) {
      // 刻意**不回显**调用方传进来的 fileId / fileName：
      // 反射调用方输入既没有用途，又把接口变成一个「原样回显」的探针面。
      // 前端（preview.html）遇到非 200 直接当 null 处理，不读响应体。
      return jsonResponse({ error: 'File not found' }, 404, cors);
    }

    const metadata = record.metadata;

    // ---------- 档位 4：有效分享授权 ----------
    if (!hasApiToken && !isAdmin) {
      const denial = await evaluateShareAccess(env, metadata, foundKey, request, cors);
      if (denial) return denial;
    }

    const fullPayload = {
      success: true,
      fileId,
      fileName: metadata.fileName || fileId,
      originalName: metadata.fileName || null,
      fileSize: metadata.fileSize || 0,
      uploadTime: metadata.TimeStamp || null,
      storageType: metadata.storageType || metadata.storage || 'telegram',
      listType: metadata.ListType || 'None',
      label: metadata.Label || 'None',
      liked: metadata.liked || false,
    };
    if (foundKey) fullPayload.key = foundKey;

    // 只有所有者（API Token / 管理员）拿得到内部标识（`key` 与 `fileId`）。
    // 分享访客拿不到 —— 与 share-info.js「绝不外泄裸 fileId / KV key」一致：
    // 拿到它就能绕过短链直连 /file/...，避开计数。
    const body = hasApiToken || isAdmin
      ? fullPayload
      : pickFields(fullPayload, PUBLIC_FIELDS.concat(['success']));

    return jsonResponse(body, 200, cors);
  } catch (error) {
    // 细节只在服务端留痕。回显 error.message 会把源码路径、KV/D1 内部报错
    // 甚至上游凭据片段递给匿名调用方。
    console.error('Error fetching file info:', error);
    return jsonResponse({ error: 'Internal server error' }, 500, cors);
  }
}

/**
 * 校验「分享访客」是否有权读取该文件的元数据。
 *
 * 判定顺序与 `share-info.js` 完全一致：**有效期 → 密码 → 次数**。
 * 密码必须排在次数之前 —— 未通过密码校验的访客不该拿到「还剩几次」
 * 这类信息，也不该能探测出「已耗尽」这个事实。
 *
 * @param env - Pages 环境
 * @param metadata - 文件 KV 元数据
 * @param kvKey - 该文件的 KV key
 * @param request - 原始请求（用于取密码）
 * @param cors - 已解析好的 CORS 响应头
 * @returns {Response|null} 拒绝时返回响应对象，放行时返回 null
 */
async function evaluateShareAccess(env, metadata, kvKey, request, cors = {}) {
  // 从未开通分享的文件：对外表现为「不存在」，而不是「存在但不给看」
  if (!hasActiveShare(metadata)) {
    return jsonResponse({ error: 'File not found', fileName: '', originalName: null }, 404, cors);
  }

  const expiresAt = Number(metadata.shareExpiresAt) || 0;
  if (expiresAt > 0 && Date.now() > expiresAt) {
    return jsonResponse({ error: 'SHARE_EXPIRED', message: '分享链接已过期。' }, 410, cors);
  }

  let password = '';
  try {
    const url = new URL(request.url);
    password = url.searchParams.get('password') || request.headers.get('X-Share-Password') || '';
  } catch {
    password = request.headers.get('X-Share-Password') || '';
  }

  const passwordState = await verifySharePassword(metadata, password);
  if (passwordState === 'missing') {
    return jsonResponse({ error: 'SHARE_PASSWORD_REQUIRED', passwordProtected: true }, 401, cors);
  }
  if (passwordState === 'invalid') {
    return jsonResponse({ error: 'SHARE_PASSWORD_INVALID', passwordProtected: true }, 403, cors);
  }

  const shareRecord = await buildShareRecord(env, metadata, kvKey);
  if (shareRecord.exhausted) {
    return jsonResponse({ error: 'SHARE_LIMIT_REACHED', message: '分享链接的下载次数已用尽。' }, 410, cors);
  }

  return null;
}

/** 取 CORS 响应头（走统一白名单，不再写死 `*`） */
async function corsHeaders(context) {
  try {
    return await resolveCorsHeaders(context.request, context.env);
  } catch {
    return {};
  }
}

/** 按白名单挑选字段，避免把内部标识顺手带出去 */
function pickFields(payload = {}, fields = []) {
  const allowed = new Set(fields);
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 元数据现在是「按访问者授权」的了：public 缓存会把一个人能看到的东西
      // 交给同机/同 CDN 节点的其他人，因此必须 private + no-store。
      'Cache-Control': 'private, no-store, max-age=0',
      ...extraHeaders,
    },
  });
}
