/**
 * WebDAV **服务端** 路由（`/dav/*`）。
 *
 * ============================================================================
 * 定位
 * ============================================================================
 *
 * 把本项目变成一个可被任意 WebDAV 客户端挂载的网盘。所有协议细节（认证、
 * 路径映射、XML 生成、后端读写）都在 `utils/webdav-server.js`，本文件只做
 * 「按 HTTP 方法分发 + 状态码映射」。
 *
 * ============================================================================
 * 支持的方法
 * ============================================================================
 *
 *   OPTIONS   能力宣告（DAV: 1,2 + Allow）
 *   PROPFIND  Depth 0/1 列举目录 / 单文件属性 → 207 Multi-Status
 *   GET       下载（支持 Range），内部转发到既有 /file/ 链路
 *   HEAD      同 GET 无 body
 *   PUT       上传 / 覆盖 → 201 / 204
 *   DELETE    删文件 / 递归删目录 → 204
 *   MKCOL     建目录 → 201
 *   MOVE      重命名 / 移动（文件与目录）→ 201 / 204
 *   COPY      复制（文件；目录递归展开）→ 201 / 204
 *
 * ============================================================================
 * 为什么 GET 走内部转发而不是重写一遍下载
 * ============================================================================
 *
 * `/file/[[path]].js` 已经处理了 7 种存储后端的读取、Range、分享鉴权、
 * 下载计数等一整套逻辑。WebDAV 的 GET 语义与它完全一致，唯一差别是路径
 * 形态（`/dav/a/b.txt` ↔ `/file/<kvKey>`）与认证方式。因此这里只做
 * 「路径 → kvKey」的解析，然后把请求转发给同一个 handler，避免两处维护
 * 同一套下载逻辑（那是必然漂移的）。
 *
 * @module dav/[[path]]
 */

import {
  authenticateWebdav,
  buildMultiStatus,
  davCopyFile,
  davDeleteCollection,
  davDeleteFileByPath,
  davMakeCollection,
  davMovePath,
  davPutFile,
  joinDavPath,
  listDavChildren,
  normalizeDavPath,
  splitDavPath,
  statDavPath,
  WEBDAV_MAX_FILE_SIZE,
} from '../utils/webdav-server.js';
import { onRequest as fileHandler } from '../file/[[path]].js';

/** WebDAV 挂载前缀。 */
const MOUNT = '/dav';

/** 各方法对应的 DAV 能力宣告。 */
const DAV_HEADER = '1, 2';
const ALLOW_HEADER =
  'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY';

const MAX_XML_BYTES = 64 * 1024;

// ============================================================================
// 响应工具
// ============================================================================

function davHeaders(extra = {}) {
  return {
    DAV: DAV_HEADER,
    'MS-Author-Via': 'DAV',
    // WebDAV 客户端（尤其 Office / 资源管理器）对缓存很敏感，
    // 统一 no-store，避免看到过期的目录列表。
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function textResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: davHeaders({
      'Content-Type': 'text/plain;charset=UTF-8',
      ...extra,
    }),
  });
}

/** 401：附带 Basic 挑战，客户端据此弹出账号密码框。 */
function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: davHeaders({
      'Content-Type': 'text/plain;charset=UTF-8',
      'WWW-Authenticate': 'Basic realm="K-Vault WebDAV", charset="UTF-8"',
    }),
  });
}

/** 未启用：返回 404（不确认「这个功能存在但你不给看」，避免功能探测）。 */
function notFound(message = 'Not Found') {
  return textResponse(message, 404);
}

function forbidden(message = 'Forbidden') {
  return textResponse(message, 403);
}

function xmlResponse(xml, status = 207) {
  return new Response(xml, {
    status,
    headers: davHeaders({
      'Content-Type': 'application/xml; charset="utf-8"',
    }),
  });
}

/** 把业务错误码映射成 WebDAV 状态码。 */
function errorResponse(error) {
  const code = error?.code || '';
  const message = error?.message || 'WebDAV 操作失败。';
  if (code === 'NOT_FOUND') return notFound(message);
  if (code === 'ALREADY_EXISTS') return textResponse(message, 405);
  if (code === 'FORBIDDEN') return forbidden(message);
  if (code === 'PRECONDITION_FAILED') return textResponse(message, 412);
  if (code === 'PAYLOAD_TOO_LARGE') return textResponse(message, 413);
  if (code === 'BAD_REQUEST') return textResponse(message, 400);
  console.error('WebDAV error:', message);
  return textResponse(message, 500);
}

// ============================================================================
// 主入口
// ============================================================================

export async function onRequest(context) {
  const { request, env } = context;
  const method = String(request.method || 'GET').toUpperCase();

  try {
    const auth = await authenticateWebdav(request, env);

    // 未启用 → 一律 404（连 OPTIONS 也不放行，彻底隐藏）
    if (auth.disabled) {
      return notFound();
    }
    if (auth.unauthorized) {
      return unauthorized();
    }

    // 写方法在只读模式下拦截
    const writeMethods = new Set(['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY']);
    if (auth.readOnly && writeMethods.has(method)) {
      return forbidden('WebDAV 服务端当前为只读模式。');
    }

    const davPath = normalizeDavPath(new URL(request.url).pathname, MOUNT);

    switch (method) {
      case 'OPTIONS':
        return handleOptions();
      case 'PROPFIND':
        return await handlePropfind(env, request, davPath);
      case 'GET':
      case 'HEAD':
        return await handleGet(context, davPath);
      case 'PUT':
        return await handlePut(env, request, davPath, auth.backend);
      case 'DELETE':
        return await handleDelete(env, davPath);
      case 'MKCOL':
        return await handleMkcol(env, davPath);
      case 'MOVE':
        return await handleMove(env, request, davPath);
      case 'COPY':
        return await handleCopy(env, request, davPath);
      default:
        return textResponse(`不支持的方法：${method}`, 405, { Allow: ALLOW_HEADER });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

// ============================================================================
// 各方法实现
// ============================================================================

function handleOptions() {
  return new Response(null, {
    status: 200,
    headers: davHeaders({
      Allow: ALLOW_HEADER,
      'Content-Length': '0',
    }),
  });
}

/**
 * PROPFIND：Depth 0 只返回自身；Depth 1 再附直接子项。
 *
 * 请求体里的 prop 列表被忽略 —— 我们统一返回完整属性集（含
 * resourcetype / getcontentlength / getlastmodified / getcontenttype）。
 * 这对所有主流客户端都兼容，且省掉解析 XML 请求体的复杂度。
 */
async function handlePropfind(env, request, davPath) {
  const depthHeader = String(request.headers.get('Depth') || '1').trim();
  const depth = depthHeader === '0' ? 0 : 1;
  const isRoot = davPath === '';

  const entries = [];
  const selfHref = isRoot ? `${MOUNT}/` : `${MOUNT}/${davPath}`;

  if (isRoot) {
    entries.push({ href: selfHref, isFolder: true, displayName: '/' });
  } else {
    const stat = await statDavPath(env, davPath);
    if (stat.type === 'none') {
      return notFound('路径不存在。');
    }
    if (stat.type === 'folder') {
      entries.push({ href: `${selfHref}/`, isFolder: true, displayName: splitDavPath(davPath).name });
    } else {
      const meta = stat.record?.metadata || {};
      entries.push({
        href: selfHref,
        isFolder: false,
        size: Number(meta.fileSize) || 0,
        mtime: Number(meta.TimeStamp) || Date.now(),
        mime: meta.mime || meta.contentType || 'application/octet-stream',
        etag: meta.etag,
        displayName: meta.fileName || splitDavPath(davPath).name,
      });
    }
  }

  if (depth === 1) {
    const { items } = await listDavChildren(env, davPath);
    for (const item of items) {
      const childPath = joinDavPath(davPath, item.name);
      entries.push({
        href: item.isFolder ? `${MOUNT}/${childPath}/` : `${MOUNT}/${childPath}`,
        isFolder: item.isFolder,
        size: item.size,
        mtime: item.mtime,
        mime: item.mime,
        etag: item.etag,
        displayName: item.name,
      });
    }
  }

  return xmlResponse(buildMultiStatus(entries));
}

/**
 * GET / HEAD：解析出底层 kvKey 后转交给 /file/ 的 handler。
 *
 * 注意转发要**重写 URL** 指向 `/file/<kvKey>`，并保留 Range 等头；
 * 由于用的是同一个 handler 函数（而不是再发一次网络请求），没有任何
 * 额外往返或序列化开销。
 */
async function handleGet(context, davPath) {
  const { env, request } = context;
  if (!davPath) return notFound('根目录不可下载。');

  const stat = await statDavPath(env, davPath);
  if (stat.type === 'none') return notFound('文件不存在。');
  if (stat.type === 'folder') return notFound('目标是目录。');

  const kvKey = stat.kvKey || davPath;
  const fileUrl = new URL(`/file/${encodeURIComponent(kvKey)}`, new URL(request.url).origin);

  const forwarded = new Request(fileUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const response = await fileHandler({
    request: forwarded,
    env,
    params: { path: kvKey },
    waitUntil: context.waitUntil?.bind(context),
    next: context.next?.bind(context),
  });

  // 给下载响应补上 DAV 头（其余头一律沿用 /file/ 的结果：Content-Length /
  // Content-Range / Content-Disposition / CORS 都已经处理好了）
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(davHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handlePut(env, request, davPath, backend) {
  if (!davPath) return textResponse('缺少文件名。', 400);

  // 内容长度预检：能在读 body 前拒绝就不要先把几十 MB 读进内存
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared && declared > WEBDAV_MAX_FILE_SIZE) {
    return textResponse(
      `文件超过 WebDAV 单文件上限（${Math.round(WEBDAV_MAX_FILE_SIZE / 1024 / 1024)}MB）。`,
      413
    );
  }

  const result = await davPutFile(env, davPath, request, backend);
  return new Response(null, {
    status: result.created ? 201 : 204,
    headers: davHeaders({ 'Content-Length': '0' }),
  });
}

async function handleDelete(env, davPath) {
  if (!davPath) return forbidden('不能删除根目录。');

  const stat = await statDavPath(env, davPath);
  if (stat.type === 'none') return notFound('路径不存在。');

  if (stat.type === 'folder') {
    await davDeleteCollection(env, davPath);
  } else {
    const ok = await davDeleteFileByPath(env, davPath);
    if (!ok) return notFound('文件不存在。');
  }
  return new Response(null, { status: 204, headers: davHeaders({ 'Content-Length': '0' }) });
}

async function handleMkcol(env, davPath) {
  if (!davPath) return textResponse('根目录已存在。', 405);

  try {
    await davMakeCollection(env, davPath);
    return new Response(null, { status: 201, headers: davHeaders({ 'Content-Length': '0' }) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 解析 Destination 头（可能是绝对 URL 或相对路径）→ 归一化 DAV 路径。 */
function resolveDestination(request, destHeader) {
  const raw = String(destHeader || '').trim();
  if (!raw) return '';
  let pathname = raw;
  try {
    pathname = new URL(raw, new URL(request.url).origin).pathname;
  } catch {
    /* 已经是相对路径 */
  }
  return normalizeDavPath(pathname, MOUNT);
}

async function handleMove(env, request, davPath) {
  if (!davPath) return forbidden('不能移动根目录。');

  const dest = resolveDestination(request, request.headers.get('Destination'));
  if (!dest) return textResponse('缺少 Destination 头。', 400);

  const overwrite = String(request.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';

  try {
    const result = await davMovePath(env, davPath, dest, overwrite);
    return new Response(null, {
      status: result.overwritten ? 204 : 201,
      headers: davHeaders({ 'Content-Length': '0' }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCopy(env, request, davPath) {
  if (!davPath) return forbidden('不能复制根目录。');

  const dest = resolveDestination(request, request.headers.get('Destination'));
  if (!dest) return textResponse('缺少 Destination 头。', 400);

  const overwrite = String(request.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';

  try {
    const stat = await statDavPath(env, davPath);
    if (stat.type === 'none') return notFound('源路径不存在。');

    let overwritten = false;

    if (stat.type === 'folder') {
      // 目录复制：递归展开为「建目录 + 逐文件复制」
      overwritten = await copyTree(env, davPath, dest, overwrite);
    } else {
      const result = await davCopyFile(env, davPath, dest, overwrite);
      overwritten = !result.created;
    }

    return new Response(null, {
      status: overwritten ? 204 : 201,
      headers: davHeaders({ 'Content-Length': '0' }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 递归复制目录树。返回目标是否已存在（决定 201 / 204）。 */
async function copyTree(env, sourcePath, destPath, overwrite) {
  const destStat = await statDavPath(env, destPath);
  const existed = destStat.type !== 'none';

  if (existed && !overwrite) {
    const err = new Error('目标已存在。');
    err.code = 'PRECONDITION_FAILED';
    throw err;
  }

  if (existed && destStat.type === 'folder') {
    // 允许合并进已存在的目录
  } else if (existed) {
    const err = new Error('目标已存在但不是目录。');
    err.code = 'PRECONDITION_FAILED';
    throw err;
  } else {
    await davMakeCollection(env, destPath);
  }

  const { items } = await listDavChildren(env, sourcePath);
  for (const item of items) {
    const childSrc = joinDavPath(sourcePath, item.name);
    const childDest = joinDavPath(destPath, item.name);
    if (item.isFolder) {
      await copyTree(env, childSrc, childDest, overwrite);
    } else {
      await davCopyFile(env, childSrc, childDest, overwrite);
    }
  }
  return existed;
}

export { MAX_XML_BYTES };
