/**
 * WebDAV **服务端** 核心逻辑。
 *
 * ============================================================================
 * 这个模块解决什么问题
 * ============================================================================
 *
 * 项目里已有一个 `utils/webdav.js`，那是 WebDAV **客户端** —— 把文件「传去
 * 别人的 WebDAV」。本模块方向相反：让**本项目自己变成一个 WebDAV 服务端**，
 * 于是 Windows 资源管理器 / macOS Finder / RaiDrive / 手机 App 都能把它挂成
 * 网络驱动器，直接拖拽上传下载。
 *
 * 两者名字相近但完全正交，切勿混用：
 *   · webdav.js         —— 出站（本项目 → 外部 WebDAV）
 *   · webdav-server.js  —— 入站（外部客户端 → 本项目）
 *
 * ============================================================================
 * 设计要点
 * ============================================================================
 *
 * 1. **复用既有数据层**。WebDAV 的「目录」映射到项目的 `folder_path` 概念，
 *    文件记录一律走 `file-record.js` / `metadata-d1.js`。因此通过 WebDAV 传上来
 *    的文件与网页上传的文件**完全同构**：能在首页看到、能在后台管理、能分享。
 *
 * 2. **存储后端可配置**，默认 telegram（唯一零凭据可写、且下载走 /file/ 代理
 *    的后端），可切到 r2（已有 R2 绑定时容量与速度都更好）。
 *
 * 3. **认证独立于站点登录**。WebDAV 客户端只会发 Basic，且通常在本地长期
 *    明文保存密码；因此服务端凭据存在独立的 `config:webdav` 组里，与站点
 *    BASIC_USER / BASIC_PASS 解耦，避免扩大站点登录凭据的暴露面。
 *
 * 4. **手写 XML，不引依赖**。项目运行时零依赖，PROPFIND 的 multistatus 响应
 *    结构固定，手写 + 转义比引入 XML 库更轻、更可控。
 *
 * @module webdav-server
 */

import { envValue } from './env-config.js';
import { safeStringEqual } from './auth.js';
import {
  getWebdavServerConfig,
  normalizeWebdavBackend,
} from './runtime-config.js';
import {
  getRecordWithKey,
  removeFileRecord,
  registerFileRecord,
  putKvFileMetadata,
  listRecordsInFolder,
  listMarkers,
  ensureFolderMarker,
  removeFolderMarkers,
  moveFolder,
} from './file-record.js';
import {
  buildTelegramBotApiUrl,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
} from './telegram.js';

const MB = 1024 * 1024;

/**
 * WebDAV PUT 的单文件上限。
 *
 * Telegram 的 Bot API `sendDocument` 上限是 50MB，本项目其余上传路径
 * （MAX_IN_MEMORY_ASSEMBLY = 40MB）也按这个数量级约束。这里取 40MB，
 * 与既有限额对齐，避免出现「网页传不了、WebDAV 却能传」的口径不一致。
 */
export const WEBDAV_MAX_FILE_SIZE = 40 * MB;

/** 目录标记的路径前缀（与 metadata-d1.js 的 folderMarkerId 保持一致）。 */
const FOLDER_PREFIX = 'folder:';

// ============================================================================
// 路径归一化
// ============================================================================

/**
 * 归一化 WebDAV 路径：去掉挂载前缀、`.`, `..`、多重斜杠与首尾斜杠。
 *
 * @param {string} value - 原始路径（如 `/dav/a/b/c.txt`）
 * @param {string} [mountPrefix] - 要剥离的挂载前缀（默认 `/dav`）
 * @returns {string} 形如 `a/b/c.txt`；根目录返回空串
 */
export function normalizeDavPath(value, mountPrefix = '/dav') {
  let raw = String(value || '');

  // 去掉查询串与哈希（WebDAV 客户端偶尔会带）
  const q = raw.search(/[?#]/);
  if (q >= 0) raw = raw.slice(0, q);

  // 去百分号编码
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 非法编码：按原样处理 */
  }

  raw = raw.replace(/\\/g, '/');

  // 剥掉挂载前缀（大小写不敏感，且要求是完整段边界）
  const prefix = String(mountPrefix || '').replace(/\/+$/, '');
  if (prefix) {
    const lower = raw.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lower === lowerPrefix) raw = '';
    else if (lower.startsWith(lowerPrefix + '/')) raw = raw.slice(prefix.length);
  }

  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    // `..` 上跳一层；已在根部则忽略（不允许逃出挂载点）
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

/**
 * 把归一化路径拆成「目录 + 文件名」。
 *
 * @param {string} davPath - 形如 `a/b/c.txt`
 * @returns {{folderPath: string, name: string}} 根目录下为 `{folderPath:'', name:'c.txt'}`
 */
export function splitDavPath(davPath) {
  const normalized = normalizeDavPath(davPath, '');
  if (!normalized) return { folderPath: '', name: '' };
  const segs = normalized.split('/');
  const name = segs.pop();
  return { folderPath: segs.join('/'), name };
}

/** 拼接父目录与子项名为完整路径。 */
export function joinDavPath(folderPath, name) {
  const base = String(folderPath || '').replace(/^\/+|\/+$/g, '');
  const leaf = String(name || '').replace(/^\/+|\/+$/g, '');
  if (!base) return leaf;
  if (!leaf) return base;
  return `${base}/${leaf}`;
}

// ============================================================================
// 认证
// ============================================================================

/**
 * 校验 WebDAV 请求的 Basic 凭据。
 *
 * 返回值刻意区分三态，路由据此给出正确的状态码：
 *   · `{ ok:false, disabled:true }`  → 服务端未启用 → 404
 *   · `{ ok:false, unauthorized:true }` → 凭据缺失/错误 → 401
 *   · `{ ok:true, ... }`             → 放行
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<{ok:boolean, disabled?:boolean, unauthorized?:boolean,
 *                    readOnly?:boolean, backend?:string, config?:object}>}
 */
export async function authenticateWebdav(request, env) {
  const config = await getWebdavServerConfig(env);

  if (!config?.enabled) return { ok: false, disabled: true };
  if (!config.username || !config.password) {
    // 启用但没配账号 → 视为未正确配置，按未启用处理（不暴露半开状态）
    return { ok: false, disabled: true };
  }

  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (!encoded || String(scheme).toLowerCase() !== 'basic') {
    return { ok: false, unauthorized: true };
  }

  let user = '';
  let pass = '';
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes).normalize();
    const idx = decoded.indexOf(':');
    if (idx === -1) return { ok: false, unauthorized: true };
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return { ok: false, unauthorized: true };
  }

  // 恒定时间比较；两次都比较，避免短路泄露「用户名是否存在」
  const userOk = safeStringEqual(user, config.username);
  const passOk = safeStringEqual(pass, config.password);
  if (!(userOk && passOk)) return { ok: false, unauthorized: true };

  return {
    ok: true,
    readOnly: config.readOnly === true,
    backend: normalizeWebdavBackend(config.backend),
    config,
  };
}

// ============================================================================
// XML 生成
// ============================================================================

/** XML 文本转义（属性值与文本节点共用）。 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 逐段编码 URL 路径（保留 `/`）。 */
function encodeHrefPath(path) {
  return String(path || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * 生成一个 `<d:response>` 条目。
 *
 * @param {object} entry
 * @param {string} entry.href - 绝对路径（如 `/dav/a/b.txt`，目录以 / 结尾）
 * @param {boolean} entry.isFolder
 * @param {number} [entry.size]
 * @param {number} [entry.mtime] - 毫秒时间戳
 * @param {string} [entry.mime]
 * @param {string} [entry.etag]
 */
function buildResponseNode(entry) {
  const href = escapeXml(encodeHrefPath(entry.href));
  const isFolder = Boolean(entry.isFolder);

  const resourcetype = isFolder
    ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : '<d:resourcetype/>';

  // 目录不报 getcontentlength（DAV 语义里目录长度无意义，报 0 反而干扰资源管理器）
  const contentLength = isFolder
    ? ''
    : `<d:getcontentlength>${Number(entry.size) || 0}</d:getcontentlength>`;

  const contentType = !isFolder && entry.mime
    ? `<d:getcontenttype>${escapeXml(entry.mime)}</d:getcontenttype>`
    : '';

  const etag = entry.etag
    ? `<d:getetag>${escapeXml(entry.etag)}</d:getetag>`
    : '';

  // HTTP-date（RFC 1123），DAV 客户端的首选格式
  const lastModified = entry.mtime
    ? `<d:getlastmodified>${new Date(Number(entry.mtime)).toUTCString()}</d:getlastmodified>`
    : '';

  const displayName = `<d:displayname>${escapeXml(entry.displayName || '')}</d:displayname>`;

  return (
    '<d:response>' +
    `<d:href>${href}</d:href>` +
    '<d:propstat>' +
    '<d:prop>' +
    resourcetype +
    contentLength +
    contentType +
    lastModified +
    etag +
    displayName +
    '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope>' +
    '<d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>' +
    '</d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status>' +
    '</d:propstat>' +
    '</d:response>'
  );
}

/**
 * 组装完整的 `207 Multi-Status` 响应体。
 *
 * @param {Array<object>} entries - 见 {@link buildResponseNode}
 * @returns {string} XML 字符串
 */
export function buildMultiStatus(entries) {
  const nodes = (entries || []).map(buildResponseNode).join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:multistatus xmlns:d="DAV:">' +
    nodes +
    '</d:multistatus>'
  );
}

// ============================================================================
// 目录列举 / 存在性判断
// ============================================================================

/**
 * 列举某个目录下的**直接子项**（Depth: 1 语义）。
 *
 * @param {object} env
 * @param {string} folderPath - 归一化目录路径（'' = 根目录）
 * @returns {Promise<{items: Array<object>}>}
 *   item: { name, isFolder, size, mtime, mime, etag }
 */
export async function listDavChildren(env, folderPath) {
  const normalized = normalizeDavPath(folderPath, '');
  const items = [];

  // 文件：D1 精确一层查询（listRecordsInFolder 内部已走 folder_path 索引）
  const filesResult = await listRecordsInFolder(env, normalized, false);
  for (const file of filesResult?.files || []) {
    const meta = file?.metadata || {};
    const name = meta.fileName || String(file.name || '').split('/').pop();
    if (!name) continue;
    items.push({
      name,
      isFolder: false,
      size: Number(meta.fileSize) || 0,
      mtime: Number(meta.TimeStamp) || Date.now(),
      mime: meta.mime || meta.contentType || 'application/octet-stream',
      etag: meta.etag || undefined,
      kvKey: file.name,
    });
  }

  // 子目录：从文件夹标记里筛出「父路径 === 当前目录」的那些
  const markers = await listMarkers(env);
  const seen = new Set();
  for (const marker of markers?.folders || []) {
    const path = String(marker.path || '');
    if (!path) continue;
    const { folderPath: parent, name } = splitDavPath(path);
    if (parent !== normalized || !name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({
      name,
      isFolder: true,
      size: 0,
      mtime: Date.now(),
      mime: '',
    });
  }

  return { items };
}

/**
 * 判断某路径是文件还是目录，或不存在。
 *
 * @param {object} env
 * @param {string} davPath
 * @returns {Promise<{type:'file'|'folder'|'none', record?:object, kvKey?:string}>}
 */
export async function statDavPath(env, davPath) {
  const normalized = normalizeDavPath(davPath, '');
  if (!normalized) return { type: 'folder' };

  // 1) 先当文件查
  const { record, kvKey } = await getRecordWithKey(env, normalized);
  if (record?.metadata) {
    return { type: 'file', record, kvKey };
  }

  // 2) 再当目录查（自身标记，或有以它为父的标记）
  const markers = await listMarkers(env);
  for (const marker of markers?.folders || []) {
    const path = String(marker.path || '');
    if (path === normalized) return { type: 'folder' };
  }

  return { type: 'none' };
}

// ============================================================================
// 存储后端写入 / 删除（telegram / r2）
// ============================================================================

/** 生成一个足够唯一的存储对象名。 */
function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeExtension(fileName) {
  const ext = String(fileName || '')
    .split('.')
    .pop()
    ?.toLowerCase()
    ?.replace(/[^a-z0-9]/g, '');
  return ext || 'bin';
}

/**
 * 把文件写进 Telegram（sendDocument 支持流式上传）。
 *
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {string} mime
 * @param {object} env
 * @returns {Promise<{storageKey:string, extra:object}>}
 */
async function putToTelegram(buffer, fileName, mime, env) {
  const chatId = envValue(env, 'TG_CHAT_ID');
  if (!chatId) throw new Error('Telegram 未配置（缺少 TG_CHAT_ID）。');

  const form = new FormData();
  form.append('chat_id', chatId);
  const { method, field } = getTelegramUploadMethodAndField(mime);
  form.append(field, new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName);

  const response = await fetch(buildTelegramBotApiUrl(env, method), {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram 上传失败：${data?.description || response.status}`);
  }

  // sendAudio 对某些文件会拒收，退回 sendDocument 再试一次（与 upload.js 同策略）
  if (method === 'sendAudio' && !pickTelegramFileId(data)) {
    const retry = new FormData();
    retry.append('chat_id', chatId);
    retry.append('document', new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName);
    const retryRes = await fetch(buildTelegramBotApiUrl(env, 'sendDocument'), {
      method: 'POST',
      body: retry,
    });
    const retryData = await retryRes.json().catch(() => null);
    if (!retryRes.ok || !retryData?.ok) {
      throw new Error(`Telegram 上传失败：${retryData?.description || retryRes.status}`);
    }
    data.result = retryData.result;
  }

  const fileId = pickTelegramFileId(data);
  if (!fileId) throw new Error('Telegram 已接收文件，但未返回可用的文件 ID。');

  const ext = normalizeExtension(fileName);
  const messageId = data?.result?.message_id;
  return {
    // 仅表示「存进 Telegram 后的对象名」；对外标识一律用 DAV 路径，
    // 见 davPutFile 里 kvKey = dav 路径 的说明。
    storageKey: `${fileId}.${ext}`,
    extra: { telegramFileId: fileId, telegramMessageId: messageId || undefined },
  };
}

/**
 * 把文件写进 R2。
 *
 * @returns {Promise<{storageKey:string, extra:object}>}
 */
async function putToR2(buffer, fileName, mime, env) {
  if (!env?.R2_BUCKET) throw new Error('R2 未配置（缺少 R2_BUCKET 绑定）。');
  const objectKey = `${randomId('r2')}.${normalizeExtension(fileName)}`;
  await env.R2_BUCKET.put(objectKey, buffer, {
    httpMetadata: { contentType: mime || 'application/octet-stream' },
    customMetadata: { fileName, uploadTime: String(Date.now()) },
  });
  return {
    storageKey: objectKey,
    extra: { r2Key: objectKey },
  };
}

/**
 * 统一的后端写入入口。
 *
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {string} mime
 * @param {string} backend - telegram / r2（其他后端暂不支持 WebDAV 写入）
 * @param {object} env
 */
async function putToBackend(buffer, fileName, mime, backend, env) {
  const mode = normalizeWebdavBackend(backend);
  if (mode === 'r2') return { ...(await putToR2(buffer, fileName, mime, env)), backend: 'r2' };
  if (mode !== 'telegram') {
    throw new Error(
      `WebDAV 服务端当前仅支持 telegram / r2 作为写入后端（当前为 ${mode}）。请在后台存储设置中切换。`
    );
  }
  return { ...(await putToTelegram(buffer, fileName, mime, env)), backend: 'telegram' };
}

/**
 * 删除后端对象（尽最大努力；元数据删除不因它失败而回滚）。
 */
async function deleteFromBackend(kvKey, metadata, env) {
  const storage = String(metadata?.storageType || metadata?.storage || '').toLowerCase();
  try {
    if (storage === 'r2' && env?.R2_BUCKET) {
      const key = metadata?.r2Key || String(kvKey).replace(/^r2:/, '');
      await env.R2_BUCKET.delete(key);
      return true;
    }
    // Telegram 无法通过 Bot API 删除单条消息里的文件（需 deleteMessage），
    // 这里只做日志，不阻断元数据删除 —— 文件仍可通过直链访问，属已知取舍。
    return false;
  } catch (error) {
    console.warn('WebDAV: 后端删除失败', error?.message || error);
    return false;
  }
}

// ============================================================================
// 文件写入（PUT）
// ============================================================================

/**
 * 处理 WebDAV PUT：写入后端 + 登记 D1 + KV 双写。
 *
 * ## 为什么 kvKey 用「DAV 路径」而不是后端对象名
 *
 * D1 `files` 表是**按相对路径索引**的（`deriveIndexId(key)` 就是剥前缀后的
 * 完整路径），既有 `folder_path` 语义也建立在「key = 相对路径」之上：
 * 网页上传写的是 `a/b/c.png`，子目录用 `folder:d/a/b` 标记。
 *
 * WebDAV 必须给出**双射**的路径↔key 映射，否则：
 *   · 同一目录传两个同名文件 → 后端对象名不同、记录不同（重复条目）；
 *   · 通过 WebDAV 传的文件与网页传的文件不同构，无法在首页/后台互相看到。
 *
 * 因此这里统一：**kvKey = DAV 路径（`docs/a.txt`），后端对象名进
 * `storageKey`/`r2Key`** —— 与记录里 `folder_path` 指向同一目录，命名空间
 * 自洽。清空目录时按 `folder_path` 匹配的既有逻辑也随之正确。
 *
 * @param {object} env
 * @param {string} davPath - 归一化后的目标路径（含文件名）
 * @param {Request} request
 * @param {string} backend
 * @returns {Promise<{created:boolean, kvKey:string}>}
 */
export async function davPutFile(env, davPath, request, backend) {
  const normalized = normalizeDavPath(davPath, '');
  if (!normalized) throw new Error('缺少文件名。');

  const { folderPath, name } = splitDavPath(normalized);
  if (!name) throw new Error('缺少文件名。');

  const buffer = await request.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    // 允许 0 字节文件（有些客户端会用它占位），但要在日志里留痕
    console.warn('WebDAV PUT: 收到 0 字节文件', normalized);
  }
  if (buffer.byteLength > WEBDAV_MAX_FILE_SIZE) {
    const limitMb = Math.round(WEBDAV_MAX_FILE_SIZE / MB);
    const err = new Error(`文件超过 WebDAV 单文件上限（${limitMb}MB）。`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  const mime = request.headers.get('Content-Type') || 'application/octet-stream';

  // 是否覆盖已有文件（决定返回 201 还是 204）
  const existing = await statDavPath(env, normalized);
  const existed = existing.type === 'file';

  // 覆盖时先把旧的后端对象清掉，避免存储侧留下孤儿对象
  if (existed && existing.kvKey && existing.kvKey !== normalized) {
    await deleteFromBackend(existing.kvKey, existing.record?.metadata, env);
  }

  const stored = await putToBackend(buffer, name, mime, backend, env);

  const metadata = {
    TimeStamp: Date.now(),
    ListType: 'None',
    Label: 'None',
    liked: false,
    fileName: name,
    fileSize: buffer.byteLength,
    storageType: stored.backend,
    mime,
    ...(folderPath ? { folderPath } : {}),
    ...stored.extra,
  };

  // kvKey 统一取 DAV 路径：与 folder_path 同命名空间，保证路径 ↔ 记录双射
  const kvKey = normalized; // 如 `docs/a.txt`

  // KV 双写受「存储回滚模式」开关控制；D1 登记始终执行
  await putKvFileMetadata(env, kvKey, metadata);
  await registerFileRecord(env, kvKey, metadata);

  return { created: !existed, kvKey };
}

// ============================================================================
// 目录 / 删除 / 移动 / 复制
// ============================================================================

/** 建目录（MKCOL）。已存在返回 alreadyExists。 */
export async function davMakeCollection(env, davPath) {
  const normalized = normalizeDavPath(davPath, '');
  if (!normalized) {
    const err = new Error('根目录已存在。');
    err.code = 'ALREADY_EXISTS';
    throw err;
  }
  const stat = await statDavPath(env, normalized);
  if (stat.type !== 'none') {
    const err = new Error('资源已存在。');
    err.code = 'ALREADY_EXISTS';
    throw err;
  }

  const result = await ensureFolderMarker(env, normalized);
  if (result && result.disabled) {
    // D1 未绑定：退回 KV 写标记，保持与既有 folder 机制一致
    if (env?.img_url) {
      await env.img_url.put(`${FOLDER_PREFIX}${normalized}`, '', {
        metadata: { folderMarker: true, folderPath: normalized, TimeStamp: Date.now() },
      });
    } else {
      throw new Error('当前部署缺少 D1 与 KV 绑定，无法创建目录。');
    }
  }
  return { path: normalized };
}

/**
 * 递归删除目录及其下所有文件。
 * @returns {Promise<{deletedFiles:number}>}
 */
export async function davDeleteCollection(env, davPath) {
  const normalized = normalizeDavPath(davPath, '');
  if (!normalized) {
    const err = new Error('不能删除根目录。');
    err.code = 'FORBIDDEN';
    throw err;
  }

  // 逐层递归：先删子目录，再删本层文件与自身标记
  const { items } = await listDavChildren(env, normalized);
  let deletedFiles = 0;

  for (const item of items) {
    const childPath = joinDavPath(normalized, item.name);
    if (item.isFolder) {
      const res = await davDeleteCollection(env, childPath);
      deletedFiles += res.deletedFiles;
    } else {
      const ok = await davDeleteFileByPath(env, childPath);
      if (ok) deletedFiles += 1;
    }
  }

  const markerResult = await removeFolderMarkers(env, normalized, true);
  if (markerResult?.disabled && env?.img_url) {
    await env.img_url.delete(`${FOLDER_PREFIX}${normalized}`);
  }
  return { deletedFiles };
}

/**
 * 从 kvKey 推导 D1 `files.id`。
 *
 * 约定（与 `deriveIndexId` 一致）：id = kvKey 剥掉存储前缀后的**完整路径**。
 * 例：`docs/a.txt` → `docs/a.txt`；`r2:xxx.png` → `xxx.png`。
 * 注意**不能**用 split('/').pop() —— 那会把子目录路径压成裸文件名而删错行。
 */
function idFromKvKey(kvKey) {
  const key = String(kvKey || '');
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(colon + 1) : key;
}

/** 删除单个文件：元数据 + 后端对象。 */
export async function davDeleteFileByPath(env, davPath) {
  const normalized = normalizeDavPath(davPath, '');
  const { record, kvKey } = await getRecordWithKey(env, normalized);
  if (!record?.metadata) return false;

  await deleteFromBackend(kvKey, record.metadata, env);
  // 删 D1 记录（id 由 kvKey 推导，保留完整路径）
  const id = idFromKvKey(kvKey);
  await removeFileRecord(env, id).catch(() => {});
  // 清 KV 副作用键
  if (env?.img_url) {
    await env.img_url.delete(String(kvKey)).catch(() => {});
    // 历史上 Telegram 记录的 KV key 无前缀（`<fileId>.<ext>`），
    // 若 kvKey 与实际键不同，再补删一次裸键形式
    if (id && id !== kvKey) await env.img_url.delete(id).catch(() => {});
  }
  return true;
}

/**
 * 移动 / 重命名。
 *
 * - 文件：改 folder_path / file_name（走 D1 局部更新）
 * - 目录：走 moveFolder（D1 一条 UPDATE 改写整棵子树前缀）
 *
 * @returns {Promise<{overwritten:boolean}>}
 */
export async function davMovePath(env, sourcePath, destPath, overwrite = false) {
  const source = normalizeDavPath(sourcePath, '');
  const dest = normalizeDavPath(destPath, '');
  if (!source || !dest) {
    const err = new Error('缺少源或目标路径。');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (dest === source) return { overwritten: false };

  const srcStat = await statDavPath(env, source);
  if (srcStat.type === 'none') {
    const err = new Error('源路径不存在。');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const destStat = await statDavPath(env, dest);
  if (destStat.type !== 'none') {
    if (!overwrite) {
      const err = new Error('目标已存在。');
      err.code = 'PRECONDITION_FAILED';
      throw err;
    }
    // 覆盖：先删目标
    if (destStat.type === 'folder') await davDeleteCollection(env, dest);
    else await davDeleteFileByPath(env, dest);
  }

  if (srcStat.type === 'folder') {
    const moved = await moveFolder(env, source, dest);
    if (moved?.disabled && env?.img_url) {
      // KV 兜底：至少把标记搬过去（文件记录需逐条改，超出本模块范围）
      await env.img_url.put(`${FOLDER_PREFIX}${dest}`, '', {
        metadata: { folderMarker: true, folderPath: dest, TimeStamp: Date.now() },
      });
      await env.img_url.delete(`${FOLDER_PREFIX}${source}`).catch(() => {});
    }
  } else {
    // 文件：目的路径拆成 folderPath + name
    const { folderPath, name } = splitDavPath(dest);
    const kvKey = srcStat.kvKey;
    const metadata = {
      ...(srcStat.record?.metadata || {}),
      fileName: name,
      folderPath: folderPath || null,
    };
    // 迁移到「kvKey = DAV 路径」约定后，文件移动 = 换 id + 改 folder_path。
    // 先登记新 id，再删旧 id（顺序反了会在中途失败时丢记录）。
    const newKvKey = dest;
    const newId = idFromKvKey(newKvKey);
    const oldId = idFromKvKey(kvKey);
    const movedRecord = await registerFileRecord(env, newKvKey, metadata);
    if (movedRecord?.ok === false) {
      // D1 不可用：退回只改 KV（保持与旧行为一致）
      if (env?.img_url) await putKvFileMetadata(env, kvKey, metadata);
    } else {
      if (env?.img_url) {
        await env.img_url.delete(String(kvKey)).catch(() => {});
      }
      if (newId !== oldId) await removeFileRecord(env, oldId).catch(() => {});
    }
  }

  return { overwritten: destStat.type !== 'none' };
}

/**
 * 复制文件（跨路径）。目录复制由路由层展开为逐文件复制。
 *
 * @returns {Promise<{created:boolean}>}
 */
export async function davCopyFile(env, sourcePath, destPath, overwrite = false) {
  const source = normalizeDavPath(sourcePath, '');
  const dest = normalizeDavPath(destPath, '');
  const srcStat = await statDavPath(env, source);
  if (srcStat.type !== 'file') {
    const err = new Error('源文件不存在或不是文件。');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const destStat = await statDavPath(env, dest);
  if (destStat.type !== 'none') {
    if (!overwrite) {
      const err = new Error('目标已存在。');
      err.code = 'PRECONDITION_FAILED';
      throw err;
    }
    if (destStat.type === 'folder') await davDeleteCollection(env, dest);
    else await davDeleteFileByPath(env, dest);
  }

  // 读出源文件内容（用于 COPY）
  const buffer = await readBackendBytes(env, source, srcStat);
  if (!buffer) throw new Error('读取源文件失败。');

  const { folderPath, name } = splitDavPath(dest);
  const mime = srcStat.record?.metadata?.mime || 'application/octet-stream';
  const stored = await putToBackend(buffer, name, mime, srcStat.record?.metadata?.storageType || 'telegram', env);
  const metadata = {
    TimeStamp: Date.now(),
    ListType: 'None',
    Label: 'None',
    liked: false,
    fileName: name,
    fileSize: buffer.byteLength,
    storageType: stored.backend,
    mime,
    ...(folderPath ? { folderPath } : {}),
    ...stored.extra,
  };
  // 与 davPutFile 同一约定：kvKey = DAV 目标路径（保证路径 ↔ 记录双射）
  const kvKey = dest;
  await putKvFileMetadata(env, kvKey, metadata);
  await registerFileRecord(env, kvKey, metadata);
  return { created: destStat.type === 'none' };
}

/**
 * 读取某文件在后端的字节（用于 COPY）。
 * 仅支持 r2 与 telegram（WebDAV 可写后端）。
 */
async function readBackendBytes(env, davPath, stat) {
  const metadata = stat.record?.metadata || {};
  const storage = String(metadata.storageType || metadata.storage || '').toLowerCase();

  if (storage === 'r2' && env?.R2_BUCKET) {
    const key = metadata.r2Key || String(stat.kvKey).replace(/^r2:/, '');
    const obj = await env.R2_BUCKET.get(key);
    if (!obj) return null;
    return await obj.arrayBuffer();
  }

  if (storage === 'telegram') {
    const fileId = metadata.telegramFileId || String(stat.kvKey).split('.')[0];
    const res = await fetch(`${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`);
    const data = await res.json().catch(() => null);
    const filePath = data?.result?.file_path;
    if (!filePath) return null;
    const origin = envValue(env, 'TG_API_BASE') || 'https://api.telegram.org';
    const binRes = await fetch(`${origin.replace(/\/+$/, '')}/file/bot${envValue(env, 'TG_BOT_TOKEN')}/${filePath}`);
    if (!binRes.ok) return null;
    return await binRes.arrayBuffer();
  }

  return null;
}

export { MB };
