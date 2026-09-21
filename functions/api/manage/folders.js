const STORAGE_PREFIXES = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', ''];
// idxt: 记录索引、dlc: 下载计数、fstat: 文件夹统计 —— 均为内部辅助键，不参与文件/文件夹判定。
const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'idxt:', 'dlc:', 'fstat:'];

function normalizeFolderPath(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();
  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('webdav:')) return 'webdav';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
}

function matchStorage(storageType, storageFilter) {
  if (!storageFilter) return true;
  if (storageFilter === 'kv' || storageFilter === 'telegram') return storageType === 'telegram';
  return storageType === storageFilter;
}

function isFolderMarker(key) {
  if (!key?.name) return false;
  if (String(key.name).startsWith('folder:')) return true;
  return key.metadata?.folderMarker === true;
}

function shouldIncludeFileRecord(key) {
  if (!key?.name) return false;
  if (INVALID_PREFIXES.some((prefix) => key.name.startsWith(prefix))) return false;
  if (isFolderMarker(key)) return false;
  const metadata = key.metadata || {};
  return Boolean(metadata.fileName) && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
}

function includeParentPaths(pathValue, set) {
  const parts = normalizeFolderPath(pathValue).split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    set.add(parts.slice(0, i).join('/'));
  }
}

function buildFolderNodes(fileRecords, folderMarkers) {
  const folderPaths = new Set();
  const fileCountByFolder = new Map();

  for (const record of fileRecords) {
    const folderPath = normalizeFolderPath(record?.metadata?.folderPath || '');
    if (!folderPath) continue;
    folderPaths.add(folderPath);
    includeParentPaths(folderPath, folderPaths);
    fileCountByFolder.set(folderPath, (fileCountByFolder.get(folderPath) || 0) + 1);
  }

  for (const marker of folderMarkers) {
    const markerPath = normalizeFolderPath(
      marker?.metadata?.folderPath
      || (String(marker?.name || '').startsWith('folder:') ? String(marker.name).slice('folder:'.length) : '')
      || ''
    );
    if (!markerPath) continue;
    folderPaths.add(markerPath);
    includeParentPaths(markerPath, folderPaths);
  }

  return [...folderPaths]
    .sort((a, b) => {
      const depthA = a.split('/').length;
      const depthB = b.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
    })
    .map((pathValue) => {
      const parts = pathValue.split('/');
      return {
        path: pathValue,
        name: parts[parts.length - 1] || pathValue,
        parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        depth: parts.length,
        fileCount: fileCountByFolder.get(pathValue) || 0,
      };
    });
}

/**
 * 列出 KV 中全部 key（全量扫描）。
 * 仅在 fstat: 索引缺失/失效时作为回落路径使用。
 */
async function listAllKeys(env) {
  const all = [];
  let cursor = undefined;
  let guard = 0;
  do {
    const page = await env.img_url.list({ limit: 1000, cursor });
    all.push(...(page.keys || []));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);
  return all;
}

/**
 * 从全量 key 中解析出"文件夹统计快照"。
 *
 * 快照结构（存入 fstat:__index__ 的 metadata）：
 *   { version, updatedAt, folders: { "<path>": { count, marker } } }
 *
 * 说明：只记录每个 folderPath 的文件数量与是否存在显式 folder: 标记，
 * 足以驱动 buildFolderNodes 的全部输出字段（path/name/parentPath/depth/fileCount）。
 */
function buildFolderSnapshot(allKeys) {
  const folders = {};

  const touch = (pathValue) => {
    const normalized = normalizeFolderPath(pathValue);
    if (!normalized) return null;
    if (!folders[normalized]) folders[normalized] = { count: 0, marker: false };
    return folders[normalized];
  };

  // 自身 + 所有父路径都要入表（父路径 fileCount 为 0，但需作为节点出现）
  const includeAll = (pathValue) => {
    const normalized = normalizeFolderPath(pathValue);
    if (!normalized) return;
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      touch(parts.slice(0, i).join('/'));
    }
  };

  for (const item of allKeys) {
    if (isFolderMarker(item)) {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
        || ''
      );
      if (!markerPath) continue;
      includeAll(markerPath);
      const entry = touch(markerPath);
      if (entry) entry.marker = true;
      continue;
    }

    if (!shouldIncludeFileRecord(item)) continue;
    const folderPath = normalizeFolderPath(item.metadata?.folderPath || '');
    if (!folderPath) continue;
    includeAll(folderPath);
    const entry = touch(folderPath);
    if (entry) entry.count += 1;
  }

  return { version: 1, updatedAt: Date.now(), folders };
}

const FSTAT_KEY = 'fstat:__index__';

/**
 * 读取文件夹统计快照。
 * @returns {Promise<{version:number, folders:object}|null>}
 */
async function readFolderSnapshot(env) {
  try {
    const record = await env.img_url.getWithMetadata(FSTAT_KEY, { type: 'json' });
    const snapshot = record?.metadata;
    if (snapshot && snapshot.version === 1 && snapshot.folders && typeof snapshot.folders === 'object') {
      return snapshot;
    }
  } catch (error) {
    console.warn('Failed to read folder snapshot:', error?.message || error);
  }
  return null;
}

/**
 * 写入文件夹统计快照。失败不影响主流程（下次仍走全表扫描）。
 */
async function writeFolderSnapshot(env, snapshot) {
  try {
    await env.img_url.put(FSTAT_KEY, '', { metadata: snapshot });
  } catch (error) {
    console.warn('Failed to write folder snapshot:', error?.message || error);
  }
}

/**
 * 失效文件夹快照。任何会改变文件夹结构的写操作后调用，使下次读取重建。
 */
async function invalidateFolderSnapshot(env) {
  try {
    await env.img_url.delete(FSTAT_KEY);
  } catch (error) {
    console.warn('Failed to invalidate folder snapshot:', error?.message || error);
  }
}

/**
 * 把快照还原成 buildFolderNodes 需要的输入形态，保证输出字段完全一致。
 */
function snapshotToNodes(snapshot, storageFilter) {
  // storageFilter 依赖每个文件的 storageType，快照未记录该维度；
  // 传入过滤条件时退回全量扫描，保证筛选结果正确。
  if (storageFilter) return null;

  const folders = snapshot.folders || {};
  const paths = Object.keys(folders).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b, 'en', { sensitivity: 'base' });
  });

  return paths.map((pathValue) => {
    const parts = pathValue.split('/');
    return {
      path: pathValue,
      name: parts[parts.length - 1] || pathValue,
      parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
      depth: parts.length,
      fileCount: folders[pathValue]?.count || 0,
    };
  });
}

function folderStartsWith(pathValue, parentPath) {
  const normalizedPath = normalizeFolderPath(pathValue);
  const normalizedParent = normalizeFolderPath(parentPath);
  if (!normalizedParent) return false;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const storageFilter = String(url.searchParams.get('storage') || '').toLowerCase();

  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const baseResponse = (folders) => {
    const response = json({ success: true, folders });
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  };

  // 快路径：读 fstat: 快照（1 次读），直接给出文件夹树，不再全表扫描。
  // 带 storage 过滤时快照不含该维度，退回全量扫描以保证筛选正确。
  if (!storageFilter) {
    const snapshot = await readFolderSnapshot(env);
    if (snapshot) {
      const nodes = snapshotToNodes(snapshot, storageFilter);
      if (nodes) return baseResponse(nodes);
    }
  }

  // 回落：全量扫描，顺带重建快照供后续请求使用
  const allKeys = await listAllKeys(env);
  const fileRecords = allKeys
    .filter(shouldIncludeFileRecord)
    .map((item) => ({
      ...item,
      metadata: {
        ...(item.metadata || {}),
        storageType: inferStorageType(item.name, item.metadata || {}),
        folderPath: normalizeFolderPath(item.metadata?.folderPath || ''),
      },
    }))
    .filter((item) => matchStorage(item.metadata?.storageType, storageFilter));

  const folderMarkers = allKeys
    .filter(isFolderMarker)
    .filter((item) => matchStorage(inferStorageType(item.name, item.metadata || {}), storageFilter));

  // 仅在无过滤时重建快照（否则快照会丢失 storage 维度语义）
  if (!storageFilter) {
    await writeFolderSnapshot(env, buildFolderSnapshot(allKeys));
  }

  return baseResponse(buildFolderNodes(fileRecords, folderMarkers));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const path = normalizeFolderPath(body.path || body.folderPath || '');
  if (!path) {
    return json({ success: false, error: 'path is required.' }, 400);
  }

  await env.img_url.put(`folder:${path}`, '', {
    metadata: {
      folderMarker: true,
      folderPath: path,
      TimeStamp: Date.now(),
    },
  });
  await invalidateFolderSnapshot(env);

  return json({ success: true, path });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const sourcePath = normalizeFolderPath(body.sourcePath || body.path || '');
  const targetPath = normalizeFolderPath(body.targetPath || body.newPath || '');

  if (!sourcePath || !targetPath) {
    return json({ success: false, error: 'sourcePath and targetPath are required.' }, 400);
  }
  if (sourcePath === targetPath) {
    return json({ success: false, error: 'sourcePath and targetPath cannot be the same.' }, 400);
  }
  if (folderStartsWith(targetPath, sourcePath)) {
    return json({ success: false, error: 'targetPath cannot be inside sourcePath.' }, 400);
  }

  const allKeys = await listAllKeys(env);
  let updatedFiles = 0;
  let updatedMarkers = 0;

  for (const item of allKeys) {
    if (shouldIncludeFileRecord(item)) {
      const currentFolder = normalizeFolderPath(item.metadata?.folderPath || '');
      if (!folderStartsWith(currentFolder, sourcePath)) continue;

      const suffix = currentFolder === sourcePath ? '' : currentFolder.slice(sourcePath.length + 1);
      const nextFolder = suffix ? `${targetPath}/${suffix}` : targetPath;
      const metadata = {
        ...(item.metadata || {}),
        folderPath: normalizeFolderPath(nextFolder),
      };
      await env.img_url.put(item.name, '', { metadata });
      updatedFiles += 1;
      continue;
    }

    if (isFolderMarker(item)) {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
      );
      if (!folderStartsWith(markerPath, sourcePath)) continue;

      const suffix = markerPath === sourcePath ? '' : markerPath.slice(sourcePath.length + 1);
      const nextFolder = suffix ? `${targetPath}/${suffix}` : targetPath;
      await env.img_url.put(`folder:${normalizeFolderPath(nextFolder)}`, '', {
        metadata: {
          ...(item.metadata || {}),
          folderMarker: true,
          folderPath: normalizeFolderPath(nextFolder),
          TimeStamp: Date.now(),
        },
      });
      if (item.name !== `folder:${normalizeFolderPath(nextFolder)}`) {
        await env.img_url.delete(item.name);
      }
      updatedMarkers += 1;
    }
  }

  await env.img_url.put(`folder:${targetPath}`, '', {
    metadata: {
      folderMarker: true,
      folderPath: targetPath,
      TimeStamp: Date.now(),
    },
  });
  await invalidateFolderSnapshot(env);

  return json({
    success: true,
    sourcePath,
    targetPath,
    updatedFiles,
    updatedMarkers,
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const url = new URL(request.url);
  let path = normalizeFolderPath(url.searchParams.get('path') || '');
  let recursive = ['1', 'true', 'yes'].includes(String(url.searchParams.get('recursive') || '').toLowerCase());

  if (!path) {
    const body = await request.json().catch(() => ({}));
    path = normalizeFolderPath(body.path || body.folderPath || '');
    if (!recursive) {
      recursive = ['1', 'true', 'yes'].includes(String(body.recursive || '').toLowerCase());
    }
  }

  if (!path) {
    return json({ success: false, error: 'path is required.' }, 400);
  }

  const allKeys = await listAllKeys(env);

  const filesInFolder = allKeys.filter((item) => {
    if (!shouldIncludeFileRecord(item)) return false;
    const folderPath = normalizeFolderPath(item.metadata?.folderPath || '');
    return folderStartsWith(folderPath, path);
  });

  const markersInFolder = allKeys.filter((item) => {
    if (!isFolderMarker(item)) return false;
    const markerPath = normalizeFolderPath(
      item.metadata?.folderPath
      || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
    );
    return folderStartsWith(markerPath, path);
  });

  if (!recursive) {
    if (filesInFolder.length > 0) {
      return json({ success: false, error: 'Folder is not empty. Use recursive=1 to force.' }, 409);
    }
    const hasChildFolder = markersInFolder.some((item) => {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
      );
      return markerPath !== path;
    });
    if (hasChildFolder) {
      return json({ success: false, error: 'Folder has child folders. Use recursive=1 to force.' }, 409);
    }
  }

  let clearedFiles = 0;
  if (recursive) {
    for (const item of filesInFolder) {
      const metadata = {
        ...(item.metadata || {}),
        folderPath: '',
      };
      await env.img_url.put(item.name, '', { metadata });
      clearedFiles += 1;
    }
  }

  let deletedMarkers = 0;
  for (const marker of markersInFolder) {
    await env.img_url.delete(marker.name);
    deletedMarkers += 1;
  }

  if (!recursive) {
    await env.img_url.delete(`folder:${path}`);
    deletedMarkers += 1;
  }
  await invalidateFolderSnapshot(env);

  return json({
    success: true,
    path,
    recursive,
    clearedFiles,
    deletedMarkers,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
